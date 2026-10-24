import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

const dataset = resolve(process.env.DATASET_DIR ?? '../dataset/data')
const manifest = JSON.parse(await readFile(resolve(dataset, 'manifest.json'), 'utf8'))
const core = new Set(['customers', 'sites', 'addresses', 'vehicles', 'drivers', 'orders', 'order_items', 'conversations', 'messages', 'alerts', 'operational_events'])
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
try {
  const related = await sql`select collection,id,details from related_records`
  let checked = 0
  for (const [collection, count] of Object.entries(manifest.tables)) {
    const source = (await readFile(resolve(dataset, `${collection}.jsonl`), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    const expected = new Map(source.map((row) => [row.id, row]))
    const actual = core.has(collection) ? await sql.unsafe(`select * from ${collection}`) : related.filter((row) => row.collection === collection)
    assert.equal(actual.length, count, `${collection}: original row count`)
    for (const row of actual) {
      const original = expected.get(row.id)
      assert.ok(original, `${collection}/${row.id}: source record exists`)
      if (row.details) assert.deepEqual(row.details, original, `${collection}/${row.id}: original source fields`)
      if (core.has(collection)) for (const [key, value] of Object.entries(row)) {
        if (!Object.hasOwn(original, key)) continue
        assert.deepEqual(value instanceof Date ? value.toISOString() : value,
          value instanceof Date ? new Date(original[key]).toISOString() : original[key], `${collection}/${row.id}.${key}`)
      }
      checked++
    }
  }
  assert.equal(related.length, Object.entries(manifest.tables).filter(([name]) => !core.has(name)).reduce((sum, [, count]) => sum + count, 0))
  const [local] = await sql`select count(*)::int as changed from orders where agent_proposal is not null or agent_mode <> 'AGENT'
    or agent_decision <> 'PENDING' or agent_decision_at is not null or agent_revision <> 0 or waiting_on_description is not null`
  assert.equal(local.changed, 0, 'Local proposal, ownership and decision state must be cleared')
  for (const table of ['agent_mock_actions', 'agent_proposal_feedback']) {
    const [result] = await sql.unsafe(`select count(*)::int as count from ${table}`)
    assert.equal(result.count, 0, `${table}: no local workflow history remains`)
  }
  console.log(`Verified original dataset: ${manifest.tables.orders} orders and all ${checked} source records match; local decisions, proposals and mock actions cleared.`)
} finally { await sql.end() }
