import 'dotenv/config'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('next/dist/build/swc')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modules = new Map()
let database
function load(path) {
  let filename = resolve(root, path)
  if (!extname(filename)) filename += existsSync(filename + '.ts') ? '.ts' : '.tsx'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }
  modules.set(filename, module)
  const { code } = transformSync(readFileSync(filename, 'utf8'), { filename,
    jsc: { parser: { syntax: 'typescript', tsx: filename.endsWith('.tsx') }, target: 'es2022', transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' } })
  new Function('require', 'module', 'exports', code)((name) => {
    if (name === 'server-only') return {}
    if (name === '@/lib/db' || (name === './db' && ['lib/messages.ts', 'lib/actions.ts'].some((file) => filename === resolve(root, file)))) return { db: database }
    if (name === 'next/link') return ({ children, prefetch, ...props }) => React.createElement('a', props, children)
    if (name.startsWith('@/')) return load(resolve(root, name.slice(2)))
    if (name.startsWith('.')) return load(resolve(dirname(filename), name))
    return require(name)
  }, module, module.exports)
  return module.exports
}

const sql = postgres(process.env.DATABASE_URL, { max: 2 })
database = require('drizzle-orm/postgres-js').drizzle(sql, { schema: load('lib/schema.ts') })
const { getGlobalInbox } = load('lib/messages.ts')
const { default: MessagesPage } = load('app/inbox/page.tsx')
const { groupMessagesByOrder, isConversationInFolder, MESSAGE_FOLDERS } = load('lib/present/messages.ts')
const external = ['driver', 'customer', 'site_contact', 'handoff_contact']
const bahn = ['operator', 'agent', 'system']
function expectedFolder(row, folder) {
  const internal = row.details.visibility === 'INTERNAL' || row.details.channel === 'internal_note'
  if (folder === 'all') return true
  if (internal) return false
  if (folder === 'sent') return bahn.includes(row.author_type) && external.includes(row.details.recipient_type)
  return external.includes(row.author_type) && bahn.includes(row.details.recipient_type)
}

try {
  const source = await sql`select m.*,o.reference,c.name as customer_name from messages m
    join orders o on o.id=m.order_id join customers c on c.id=o.customer_id
    order by m.authored_at desc,m.id desc`
  const result = await getGlobalInbox()
  const [count] = await sql`select count(*)::int as count from messages`
  assert.equal(result.length, count.count, 'All messages must survive the joins')
  assert.deepEqual(result.map((message) => message.id), source.map((row) => row.id), 'Global chronological order must be newest first')
  for (const [index, message] of result.entries()) {
    const row = source[index]
    assert.equal(message.orderReference, row.reference)
    assert.equal(message.customerName, row.customer_name)
    assert.equal(message.body, row.body)
    assert.equal(message.isRead, row.is_read)
    assert.equal(message.authoredAt, new Date(row.authored_at).toISOString())
    if (row.details.author_name_snapshot) assert.equal(message.sender.name, row.details.author_name_snapshot, 'Historical sender snapshots take precedence over current contact names')
  }
  assert.deepEqual(MESSAGE_FOLDERS.map((folder) => folder.id), ['sent', 'inbox', 'all'])
  const groupedSource = new Map()
  for (const row of source) {
    const thread = groupedSource.get(row.order_id)
    if (thread) thread.messages.push(row)
    else groupedSource.set(row.order_id, { orderId: row.order_id, latest: row, messages: [row] })
  }
  const sourceThreads = [...groupedSource.values()]
  const expectedThreads = (view) => sourceThreads.filter((thread) => thread.messages.some((row) => expectedFolder(row, ['sent', 'inbox'].includes(view) ? view : 'all')))
  const sample = result[0]
  const incoming = { ...sample, id: 'a-old', orderId: 'order-a', authoredAt: '2026-10-20T08:00:00Z', internal: false, sender: { kind: 'driver' }, recipient: { kind: 'operator' } }
  const outgoing = { ...sample, id: 'a-new', orderId: 'order-a', authoredAt: '2026-10-21T08:00:00Z', internal: false, sender: { kind: 'operator' }, recipient: { kind: 'driver' } }
  const anotherOrder = { ...outgoing, id: 'b-new', orderId: 'order-b', authoredAt: '2026-10-21T09:00:00Z' }
  const unsorted = [incoming, anotherOrder, outgoing]
  const grouped = groupMessagesByOrder(unsorted)
  assert.deepEqual(grouped.map((thread) => thread.orderId), ['order-b', 'order-a'], 'Same-customer orders stay separate and sort by latest activity')
  assert.equal(grouped[1].messages.length, 2)
  assert.equal(grouped[1].latestMessage.id, 'a-new')
  assert.equal(isConversationInFolder(grouped[1], 'inbox'), true, 'An incoming conversation keeps its latest overall reply as preview')
  assert.equal(isConversationInFolder(grouped[1], 'sent'), true)
  assert.deepEqual(unsorted.map((message) => message.id), ['a-old', 'b-new', 'a-new'], 'Grouping must not mutate the source list')
  const counts = {}
  for (const view of ['sent', 'inbox', 'agent', 'all', 'unknown']) {
    const expected = expectedThreads(view)
    const html = renderToStaticMarkup(await MessagesPage({ searchParams: Promise.resolve({ view }) }))
    const rendered = [...html.matchAll(/data-order-id="([^"]+)"/g)].map((match) => match[1])
    assert.deepEqual(rendered, expected.map((thread) => thread.orderId), `${view}: one row per order, latest activity first`)
    assert.deepEqual([...html.matchAll(/data-latest-message-id="([^"]+)"/g)].map((match) => match[1]), expected.map((thread) => thread.latest.id))
    assert.equal(new Set(rendered).size, rendered.length)
    assert.equal([...html.matchAll(/class="message-unread-dot"/g)].length, expected.filter((thread) => thread.messages.some((row) => !row.is_read)).length)
    assert.equal([...html.matchAll(/aria-expanded="false"/g)].length, expected.length, 'Every row initially offers expansion')
    assert.ok(!html.includes('class="message-thread-expanded"'), 'Full history starts collapsed')
    assert.ok(!html.includes('View Order'), 'Navigation is only offered inside an expanded thread')
    assert.ok(html.includes('aria-label="Message views"'))
    assert.ok(html.includes('Messages'))
    assert.ok(html.includes('All messages'))
    assert.ok(!html.includes('Agent messages'))
    assert.ok(!html.includes('view=agent'))
    counts[view] = rendered.length
  }
  const defaultHtml = renderToStaticMarkup(await MessagesPage({ searchParams: Promise.resolve({}) }))
  assert.equal([...defaultHtml.matchAll(/data-order-id=/g)].length, sourceThreads.length)
  assert.equal(groupMessagesByOrder(result).reduce((total, thread) => total + thread.messages.length, 0), count.count, 'All messages remain in their order history')
  if (process.argv.includes('--http')) {
    const base = process.env.APP_URL ?? 'http://localhost:3000'
    for (const view of ['sent', 'inbox', 'all']) {
      const response = await fetch(`${base}/inbox?view=${view}`, { signal: AbortSignal.timeout(60_000) })
      assert.equal(response.status, 200, `${view}: Next.js page loads`)
      const html = await response.text()
      assert.deepEqual([...html.matchAll(/data-order-id="([^"]+)"/g)].map((match) => match[1]), expectedThreads(view).map((thread) => thread.orderId))
      assert.ok(html.includes('Message views'))
    }
    console.log('Verified every Messages view over HTTP with one row per order in the initial HTML.')
  }
  console.log(`Verified ${count.count} messages grouped into ${sourceThreads.length} order conversations, latest-message previews, case links and filter counts: ${JSON.stringify(counts)}. No database writes.`)
} finally { await sql.end() }
