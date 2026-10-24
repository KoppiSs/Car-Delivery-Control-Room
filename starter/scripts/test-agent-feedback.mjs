import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../lib/schema.ts'
const require = createRequire(import.meta.url)
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const dbClient = postgres(process.env.DATABASE_URL, { max: 1 })
globalThis.feedbackTestDb = drizzle(dbClient, { schema })
const asModule = (source) => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64')
const agentUrl = asModule(await readFile(new URL('../lib/agent.ts', import.meta.url), 'utf8'))
const dbUrl = asModule('export const db = globalThis.feedbackTestDb;')
const schemaUrl = new URL('../lib/schema.ts', import.meta.url).href
const ormUrl = pathToFileURL(require.resolve('drizzle-orm')).href
const prepare = (source) => source.replace('"@/lib/db"', JSON.stringify(dbUrl))
  .replace('"@/lib/schema"', JSON.stringify(schemaUrl)).replace('"drizzle-orm"', JSON.stringify(ormUrl))
const storeUrl = asModule(prepare(await readFile(new URL('../lib/agent-store.ts', import.meta.url), 'utf8')).replace('"./agent"', JSON.stringify(agentUrl)))
const store = await import(storeUrl)
const manualUrl = asModule(prepare(await readFile(new URL('../lib/agent-manual.ts', import.meta.url), 'utf8')).replace('"./agent-store"', JSON.stringify(storeUrl)))
const { updateManualOrder } = await import(manualUrl)
const orderId = `test-feedback-${randomUUID()}`
const base = process.env.APP_URL ?? 'http://localhost:3000'
const old = { investigation_summary: ['Ferry is only a quote.'], proposed_action: 'Compare ferry options.', decision_button_text: 'Approve follow-up' }
let revised = { ...old, proposed_action: 'Compare train options first.' }
try {
  await sql`insert into orders (id, reference, customer_id, pickup_site_id, delivery_site_id, pickup_address_id, delivery_address_id,
    display_lane, status, route_kind, created_at, updated_at, details, agent_proposal)
    select ${orderId}, ${orderId}, customer_id, pickup_site_id, delivery_site_id, pickup_address_id, delivery_address_id,
    display_lane, 'BLOCKED', route_kind, created_at, updated_at, details, ${sql.json(old)} from orders order by id limit 1`
  for (const [index, status] of ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].entries()) {
    await sql`insert into alerts (id, order_id, severity, signal, status, summary, triggered_at, details)
      values (${orderId + '-' + index}, ${orderId}, 'medium', 'TRACKING_GAP', ${status}, 'Test alert', now(), ${sql.json({ marker: 'preserve', status })})`
  }
  const override = await store.beginAgentOverride(orderId, 'Check trains instead of ferries', old)
  assert.equal(override.revision, 1)
  assert.deepEqual((await store.loadAgentOrder(orderId)).agentProposal, old)
  assert.deepEqual(await store.saveAgentProposal(orderId, revised, override.revision, override.feedbackId), revised)
  const [feedback] = await sql`select * from agent_proposal_feedback where id = ${override.feedbackId}`
  assert.equal(feedback.decision, 'OVERRIDE')
  assert.equal(feedback.outcome, 'APPLIED')
  assert.deepEqual(feedback.previous_proposal, old)
  assert.deepEqual(feedback.replacement_proposal, revised)
  assert.equal(feedback.correction, 'Check trains instead of ferries')
  await assert.rejects(store.beginAgentOverride(orderId, 'Stale correction', old), /changed/)
  const review = (decision, proposal = revised) => fetch(base + '/api/agent/decision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, decision, proposal }),
  })
  const staleReview = await review('APPROVED', old)
  assert.equal(staleReview.status, 409, `Stale proposals must not be approved: ${await staleReview.text()}`)
  for (const response of await Promise.all([review('APPROVED'), review('APPROVED')])) assert.equal(response.status, 200)
  const approved = await (await fetch(base + '/api/orders/' + orderId)).json()
  assert.equal(approved.order.agentDecision, 'APPROVED', 'Approval must survive reopening')
  assert.ok(approved.order.agentDecisionAt)
  assert.equal(approved.agentFeedback.filter((entry) => entry.decision === 'APPROVE').length, 1, 'Duplicate approvals must not duplicate history')
  assert.equal((await review('REJECTED')).status, 200)
  const rejected = await (await fetch(base + '/api/orders/' + orderId)).json()
  assert.equal(rejected.order.agentDecision, 'REJECTED', 'Rejection must survive reopening')
  assert.ok(rejected.agentFeedback.some((entry) => entry.decision === 'REJECT'))
  assert.deepEqual(rejected.order.agentProposal, revised, 'Rejected plans must remain reviewable')
  const reconsider = await store.beginAgentOverride(orderId, 'Compare earlier trains.', revised)
  revised = { ...revised, proposed_action: 'Compare earlier train options.' }
  await store.saveAgentProposal(orderId, revised, reconsider.revision, reconsider.feedbackId)
  const freshPlan = await (await fetch(base + '/api/orders/' + orderId)).json()
  assert.equal(freshPlan.order.agentDecision, 'PENDING', 'A revised plan needs a new review')
  assert.equal(freshPlan.order.agentDecisionAt, null)
  const failed = await store.beginAgentOverride(orderId, 'Another correction', revised)
  await store.finishAgentFeedback(failed.feedbackId, 'FAILED')
  assert.deepEqual((await store.loadAgentOrder(orderId)).agentProposal, revised, 'Failed revisions must retain the old proposal')
  const historyBefore = await sql`select details from alerts where id = ${orderId + '-2'}`
  const beforeTakeover = (await (await fetch(base + '/api/overview')).json()).visible.find((order) => order.id === orderId)
  const [firstTakeover, repeated] = await Promise.all([
    updateManualOrder(orderId, 'takeover', 'Operator rejected the plan.'),
    updateManualOrder(orderId, 'takeover', 'Repeated click'),
  ])
  assert.ok([firstTakeover, repeated].some((result) => result.resolvedAlertIds.length === 2))
  const after = await store.loadAgentOrder(orderId)
  assert.equal(after.agentMode, 'MANUAL')
  assert.equal(after.agentProposal, null)
  assert.equal(await store.saveAgentProposal(orderId, old, failed.revision), null, 'Late generation must not undo takeover')
  assert.deepEqual(await sql`select details from alerts where id = ${orderId + '-2'}`, historyBefore)
  const rejections = await sql`select * from agent_proposal_feedback where order_id = ${orderId} and decision = 'TAKEOVER'`
  assert.equal(rejections.length, 1)
  assert.deepEqual(rejections[0].previous_proposal, revised)
  const active = await sql`select * from alerts where order_id = ${orderId} and status in ('OPEN','ACKNOWLEDGED')`
  assert.equal(active.length, 0)
  const overview = await (await fetch(base + '/api/overview')).json()
  assert.ok(overview.visible.some((order) => order.id === orderId && order.agentMode === 'MANUAL'), 'Manual work must stay in the queue')
  const afterTakeover = overview.visible.find((order) => order.id === orderId)
  assert.equal(afterTakeover.problemTitle, beforeTakeover.problemTitle, 'Takeover must preserve the problem title')
  assert.equal(afterTakeover.problemDetail, beforeTakeover.problemDetail, 'Takeover must preserve the problem description')
  const takenOver = await (await fetch(base + '/api/orders/' + orderId)).json()
  assert.equal(takenOver.order.agentDecision, 'TAKEN_OVER')
  assert.ok(takenOver.agentFeedback.some((entry) => entry.decision === 'TAKEOVER'))
  const blocked = await fetch(base + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, events: [] }) })
  assert.equal(blocked.status, 409)
  const post = (body) => fetch(base + '/api/agent/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, ...body }) })
  assert.equal((await post({ operation: 'takeover' })).status, 200)
  assert.equal((await post({ operation: 'resolve', note: 'Done', nextStatus: 'INVALID' })).status, 400)
  assert.equal((await post({ operation: 'note', note: 'Awaiting the site reply.' })).status, 200)
  assert.equal((await post({ operation: 'resolve', note: 'Release confirmed by an operator; return to preparation.', nextStatus: 'NEW' })).status, 200)
  assert.equal((await store.loadAgentOrder(orderId)).agentMode, 'MANUAL_COMPLETE')
  const complete = await (await fetch(base + '/api/overview')).json()
  assert.ok(!complete.visible.some((order) => order.id === orderId))
  const detail = await (await fetch(base + '/api/orders/' + orderId)).json()
  assert.ok(detail.view.history.flatMap((day) => day.events).some((event) => event.text === 'Operator recorded a manual resolution'))
  console.log('Verified feedback persistence, old/new proposal audit, stale edits, failed revisions, duplicate takeover, late generation protection, alert clearing, manual queue ownership, notes, and manual resolution.')
} finally {
  await sql.begin(async (tx) => {
    await tx`delete from agent_proposal_feedback where order_id = ${orderId}`
    await tx`delete from operational_events where order_id = ${orderId}`
    await tx`delete from alerts where order_id = ${orderId}`
    await tx`delete from orders where id = ${orderId}`
  })
  await sql.end()
  await dbClient.end()
  delete globalThis.feedbackTestDb
}
