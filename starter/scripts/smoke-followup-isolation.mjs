import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const base = process.env.APP_URL ?? 'http://localhost:3000'
const prefix = `test-isolation-${randomUUID()}`
const cases = [
  { action_type: 'REQUEST_VEHICLE_IDENTITY', description: 'Request the VIN or registration from the customer.', waiting: 'Customer-provided VIN or registration.' },
  { action_type: 'RECHECK_TRAVEL_CAPACITY', description: 'Recheck ferry capacity and driver rest feasibility.', waiting: 'Current ferry capacity and driver rest confirmation.' },
  { action_type: 'REQUEST_HANDOVER_PROOF', description: 'Request signed delivery proof from the receiving site.', waiting: 'Signed delivery proof from the receiving site' },
].map((item, index) => ({ ...item, id: `${prefix}-${index}`, proposal: { investigation_summary: ['Fictional evidence requires follow-up.'],
  proposed_action: item.description, decision_button_text: 'Approve follow-up', executable_tool_call: { action_type: item.action_type, payload: { description: item.description } }, waiting_on_description: item.waiting } }))
const post = (item, proposal = item.proposal) => fetch(base + '/api/agent/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ orderId: item.id, proposal, executable_tool_call: proposal.executable_tool_call, waiting_on_description: proposal.waiting_on_description }) })
try {
  for (const item of cases) {
    await sql`insert into orders (id,reference,customer_id,pickup_site_id,delivery_site_id,pickup_address_id,delivery_address_id,
      display_lane,status,route_kind,created_at,updated_at,details,agent_proposal)
      select ${item.id},${item.id},customer_id,pickup_site_id,delivery_site_id,pickup_address_id,delivery_address_id,
      display_lane,'BLOCKED',route_kind,created_at,updated_at,details,${sql.json(item.proposal)} from orders order by id limit 1`
    const cached = await fetch(base + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: item.id }) })
    assert.equal(cached.status, 200)
    assert.deepEqual(await cached.json(), item.proposal, 'Proposal cache is per order')
  }
  const crossOrder = await post(cases[0], cases[1].proposal)
  assert.equal(crossOrder.status, 409, await crossOrder.text())
  const poisoned = { ...cases[0].proposal, waiting_on_description: cases[2].waiting }
  assert.equal((await post(cases[0], poisoned)).status, 400, 'An unrelated proof dependency must not be approved')
  // Also reject a poisoned cached proposal even if a client omits its proposal copy.
  await sql`update orders set agent_proposal=${sql.json(poisoned)} where id=${cases[0].id}`
  const bypass = await fetch(base + '/api/agent/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: cases[0].id, executable_tool_call: poisoned.executable_tool_call, waiting_on_description: poisoned.waiting_on_description }) })
  assert.equal(bypass.status, 409)
  assert.equal((await sql`select * from agent_mock_actions where order_id=${cases[0].id}`).length, 0)
  await sql`update orders set agent_proposal=${sql.json(cases[0].proposal)} where id=${cases[0].id}`
  const approved = await Promise.all(cases.map((item) => post(item)))
  for (const [index, response] of approved.entries()) {
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(result.waiting_on_description, cases[index].waiting)
  }
  const register = await (await fetch(base + '/api/deliveries')).json()
  for (const item of cases) {
    const [order] = await sql`select * from orders where id=${item.id}`
    const [action] = await sql`select * from agent_mock_actions where order_id=${item.id}`
    const detail = await (await fetch(base + '/api/orders/' + item.id)).json()
    assert.equal(order.waiting_on_description, item.waiting)
    assert.equal(order.status, 'follow_up')
    assert.deepEqual(action.payload, item.proposal.executable_tool_call.payload)
    assert.equal(action.waiting_on_description, item.waiting)
    assert.equal(detail.order.waitingOnDescription, item.waiting)
    assert.equal(register.visible.find((card) => card.id === item.id).waitingOnDescription, item.waiting)
    assert.equal(detail.agentFeedback.find((entry) => entry.outcome === 'MOCK_EXECUTED').previousProposal.waiting_on_description, item.waiting)
  }
  console.log('Verified identity, travel and proof orders retain their own waiting events through cache, concurrent approvals, database records and reopened views; cross-order and mismatched payloads rejected.')
} finally {
  await sql.begin(async (tx) => {
    for (const item of cases) {
      await tx`delete from agent_mock_actions where order_id=${item.id}`
      await tx`delete from agent_proposal_feedback where order_id=${item.id}`
      await tx`delete from operational_events where order_id=${item.id}`
      await tx`delete from orders where id=${item.id}`
    }
  })
  await sql.end()
}
