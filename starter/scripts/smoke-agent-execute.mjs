import "dotenv/config"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import postgres from "postgres"
import { executableFields } from "./fixtures/proposal.cjs"
const { reviewType } = createRequire(import.meta.url)("../lib/present/review.ts")
const base = process.env.APP_URL ?? "http://localhost:3000"
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const orderId = `test-execute-${randomUUID()}`
const alertIds = [0, 1, 2].map((index) => `${orderId}-alert-${index}`)
const proposal = { investigation_summary: ["The last report is stale."], proposed_action: "Ask the fictional driver for an update.", decision_button_text: "Approve follow-up", ...executableFields }
const action = proposal.executable_tool_call
const body = { orderId, ...executableFields, proposal }
const post = (payload) => fetch(`${base}/api/agent/execute`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
})
try {
  await sql.begin(async (tx) => {
    await tx`insert into orders (id, reference, customer_id, pickup_site_id, delivery_site_id, pickup_address_id,
      delivery_address_id, display_lane, status, route_kind, created_at, updated_at, details, agent_proposal)
      select ${orderId}, ${orderId}, customer_id, pickup_site_id, delivery_site_id, pickup_address_id,
      delivery_address_id, display_lane, 'BLOCKED', route_kind, created_at, updated_at, details, ${tx.json(proposal)}
      from orders order by id limit 1`
    for (const [index, status] of ["OPEN", "ACKNOWLEDGED", "RESOLVED"].entries()) {
      await tx`insert into alerts (id, order_id, severity, signal, status, summary, triggered_at, details)
        values (${alertIds[index]}, ${orderId}, ${index === 0 ? 'high' : 'medium'}, 'TRACKING_GAP', ${status}, 'Fictional test alert', now(),
        ${tx.json({ status, evidence_refs: ["test-evidence"], marker: "preserve-history" })})`
    }
  })
  for (const invalid of [null, {}, { orderId, action: {} }, { orderId, ...executableFields, waiting_on_description: '' },
    { ...body, executable_tool_call: { action_type: 'REQUEST_DRIVER_UPDATE', payload: 'bad' } },
    { ...body, waiting_on_description: 'Revise this entirely again.' }]) {
    assert.equal((await post(invalid)).status, 400)
  }
  assert.equal((await post({ orderId, action: { text: "a".repeat(50_001) } })).status, 413)
  assert.equal((await post({ ...body, orderId: `${orderId}-missing` })).status, 404)
  const stale = await post({ ...body, executable_tool_call: { ...action, payload: { description: 'Different action' } } })
  assert.equal(stale.status, 409, await stale.text())
  const [unchanged] = await sql`select agent_proposal, status from orders where id = ${orderId}`
  assert.deepEqual(unchanged.agent_proposal, proposal)
  assert.equal(unchanged.status, 'BLOCKED')
  const before = await sql`select id, status, details from alerts where id = ${alertIds[2]}`
  const beforeCard = (await (await fetch(base + '/api/overview')).json()).visible.find((order) => order.id === orderId)
  const correction = 'Prioritise the rail option'
  const badProposal = { ...proposal, waiting_on_description: correction }
  await sql`update orders set agent_proposal = ${sql.json(badProposal)} where id = ${orderId}`
  await sql`insert into agent_proposal_feedback (id, order_id, decision, correction, previous_proposal, replacement_proposal, outcome)
    values (${orderId + '-override'}, ${orderId}, 'OVERRIDE', ${correction}, ${sql.json(proposal)}, ${sql.json(badProposal)}, 'APPLIED')`
  const badApproval = await post({ ...body, proposal: badProposal, waiting_on_description: correction })
  assert.equal(badApproval.status, 409, await badApproval.text())
  const [blocked] = await sql`select status from orders where id = ${orderId}`
  assert.equal(blocked.status, 'BLOCKED', 'An instruction echo must never move an order to Follow-up')
  assert.equal((await sql`select * from agent_mock_actions where order_id = ${orderId}`).length, 0)
  await sql`update orders set agent_proposal = ${sql.json(proposal)} where id = ${orderId}`
  await sql`delete from agent_proposal_feedback where id = ${orderId + '-override'}`
  const responses = await Promise.all([post(body), post(body)])
  const results = []
  for (const response of responses) { const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); results.push(data) }
  assert.ok(results.every((result) => result.success && result.simulated && result.status === 'follow_up'))
  assert.deepEqual(results.map((result) => result.resolvedAlertIds.length).sort(), [0, 2])
  assert.equal(results[0].actionId, results[1].actionId)
  const [saved] = await sql`select * from orders where id = ${orderId}`
  assert.equal(saved.status, 'follow_up')
  assert.equal(saved.agent_proposal, null)
  assert.equal(saved.waiting_on_description, proposal.waiting_on_description)
  assert.equal(saved.agent_decision, 'APPROVED')
  const actions = await sql`select * from agent_mock_actions where order_id = ${orderId}`
  assert.equal(actions.length, 1, 'Duplicate submissions must create only one mock record')
  assert.equal(actions[0].action_type, action.action_type)
  assert.deepEqual(actions[0].payload, action.payload)
  assert.equal(actions[0].waiting_on_description, proposal.waiting_on_description)
  const events = await sql`select * from operational_events where order_id = ${orderId}`
  assert.equal(events.length, 1)
  assert.equal(events[0].command, 'agent.follow_up_started')
  assert.equal(events[0].target_id, actions[0].id)
  assert.equal(events[0].details.to_state, 'follow_up')
  const feedback = await sql`select * from agent_proposal_feedback where order_id = ${orderId}`
  assert.equal(feedback.length, 1)
  assert.equal(feedback[0].outcome, 'MOCK_EXECUTED')
  assert.deepEqual(feedback[0].previous_proposal, proposal)
  const active = await sql`select * from alerts where order_id = ${orderId} and status in ('OPEN', 'ACKNOWLEDGED')`
  assert.equal(active.length, 0)
  assert.deepEqual(await sql`select id, status, details from alerts where id = ${alertIds[2]}`, before)
  const detail = await (await fetch(`${base}/api/orders/${orderId}`)).json()
  assert.equal(detail.order.waitingOnDescription, proposal.waiting_on_description)
  assert.ok(detail.view.history.flatMap((day) => day.events).some((event) => event.text === 'Mock follow-up action recorded'))
  const overview = await (await fetch(`${base}/api/overview`)).json()
  const card = overview.visible.find((order) => order.id === orderId)
  assert.ok(card, 'Follow-up must remain visible even after all alerts are cleared')
  assert.equal(reviewType(card), 'followup')
  assert.equal(card.problemSeverity, 'high', 'Original severity is retained as context while Follow-up ownership determines placement')
  assert.equal(card.waitingOnDescription, proposal.waiting_on_description)
  assert.equal(card.problemTitle, beforeCard.problemTitle)
  assert.equal((await fetch(base + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, events: [] }) })).status, 409)
  console.log('Verified atomic mock approval: one action record, cleared proposal, exact follow_up status, waiting description, preserved problem title, alert resolution, audit history, duplicate safety, and Follow-up visibility.')
} finally {
  await sql.begin(async (tx) => {
    await tx`delete from agent_mock_actions where order_id = ${orderId}`
    await tx`delete from agent_proposal_feedback where order_id = ${orderId}`
    await tx`delete from operational_events where order_id = ${orderId}`
    await tx`delete from alerts where order_id = ${orderId}`
    await tx`delete from orders where id = ${orderId}`
  })
  await sql.end()
}
