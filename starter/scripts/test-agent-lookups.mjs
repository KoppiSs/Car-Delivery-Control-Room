import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const require = createRequire(import.meta.url)
const { transformSync } = require('next/dist/build/swc')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modules = new Map()
let database
function load(path) {
  const filename = resolve(root, extname(path) ? path : path + '.ts')
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }
  modules.set(filename, module)
  const { code } = transformSync(readFileSync(filename, 'utf8'), { filename,
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } })
  new Function('require', 'module', 'exports', code)((name) => {
    if (name === '@/lib/db') return { db: database }
    if (name.startsWith('@/')) return load(resolve(root, name.slice(2)))
    if (name.startsWith('.')) return load(resolve(dirname(filename), name))
    return require(name)
  }, module, module.exports)
  return module.exports
}

// Real Postgres connection and production queries; this check performs no writes.
const sql = postgres(process.env.DATABASE_URL, { max: 2 })
database = require('drizzle-orm/postgres-js').drizzle(sql, { schema: load('lib/schema.ts') })
const { AGENT_TOOLS, runTool } = load('lib/agent/tools.ts')
try {
  const names = ['get_tracking', 'get_travel', 'get_driver_activity', 'get_order_context']
  for (const name of names) {
    const tool = AGENT_TOOLS.find((entry) => entry.function.name === name)?.function
    assert.ok(tool, `${name}: advertised schema`)
    assert.equal(tool.strict, true)
    assert.deepEqual(tool.parameters, { type: 'object', properties: {}, required: [], additionalProperties: false })
  }
  const tracking = await runTool('get_tracking', { orderId: 'ord-01013' }, 'ord-00806')
  const source = await sql`select id from related_records where collection='tracking_observations' and order_id='ord-00806'
    and details->>'source'='driver_app'`
  assert.deepEqual(tracking.map((entry) => entry.id).sort(), source.map((entry) => entry.id).sort())
  assert.ok(tracking.length > 0)
  assert.ok(tracking.every((entry) => entry.details.order_id === 'ord-00806' && entry.details.observed_at && entry.details.received_at))
  const noPosition = await runTool('get_tracking', {}, 'ord-01013')
  assert.deepEqual(noPosition, [], 'Missing tracking remains missing; no observation is invented')
  const travel = await runTool('get_travel', {}, 'ord-00299')
  assert.ok(travel.options.some((entry) => entry.details.status === 'SOLD_OUT'))
  assert.ok(travel.options.some((entry) => entry.details.status === 'AVAILABLE_QUOTE'))
  for (const entry of [...travel.options, ...travel.reservations, ...travel.gateEvents]) assert.equal(entry.details.order_id, 'ord-00299')
  const activity = await runTool('get_driver_activity', {}, 'ord-01013')
  assert.ok(activity.some((event) => event.command === 'expense.submitted'))
  assert.ok(activity.every((event) => event.orderId === 'ord-01013'))
  const context = await runTool('get_order_context', {}, 'ord-00806')
  assert.equal(context.order.id, 'ord-00806')
  assert.equal(context.order.reference, 'CD-420806')
  assert.ok(context.assignments.length > 0)
  await assert.rejects(runTool('get_tracking', {}, 'missing-order'), /Order not found/)
  console.log('Verified all four strict lookup schemas against real Postgres: source records, missing data, quotes vs bookings, driver activity, order context and caller-owned order isolation. No writes performed.')
} finally { await sql.end() }
