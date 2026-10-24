import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { createRequire } from 'node:module'
const { isExecutableAgentProposal, isExternalWaitingDescription } = createRequire(import.meta.url)('../lib/agent.ts')
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const base = process.env.APP_URL ?? 'http://localhost:3000'
const orderId = `test-edit-${randomUUID()}`
const eventId = `${orderId}-quote`
const previous = { investigation_summary: ['Ferry options have only been quoted.'], proposed_action: 'Compare ferry options for the driver.', decision_button_text: 'Approve follow-up' }
const correction = 'Check trains instead of ferries. Ask for a train quote and bring it to an operator for approval.'
try {
  await sql`insert into orders (id, reference, customer_id, pickup_site_id, delivery_site_id, pickup_address_id, delivery_address_id,
    display_lane, status, route_kind, created_at, updated_at, details, agent_proposal)
    select ${orderId}, ${orderId}, customer_id, pickup_site_id, delivery_site_id, pickup_address_id, delivery_address_id,
    display_lane, 'BLOCKED', route_kind, created_at, updated_at, details, ${sql.json(previous)} from orders order by id limit 1`
  await sql`insert into alerts (id,order_id,severity,signal,status,summary,triggered_at,details)
    values (${orderId + '-alert'},${orderId},'medium','TRAVEL_OPTIONS_NEEDED','OPEN','Travel options need operator review.',now(),'{}'::jsonb)`
  const eventDetails = { actor_type: 'system', actor_id: 'test-provider', source: 'mock_travel_quotes',
    changes: { travel_mode: 'FERRY', state: 'QUOTED', note: 'A ferry quote was recorded; no train option has been checked in this selected history.' } }
  await sql`insert into operational_events (id,order_id,command,target_type,target_id,recorded_at,details)
    values (${eventId},${orderId},'travel.option_quoted','order',${orderId},now(),${sql.json(eventDetails)})`
  const events = await sql`select * from operational_events where order_id = ${orderId}`
  const response = await fetch(base + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(195_000), body: JSON.stringify({ orderId, events, correction, previousProposal: previous,
      context: { order: { id: orderId }, situation: 'Driver travel is blocked pending a review of travel alternatives. Nothing is booked.' } }) })
  const proposal = await response.json()
  assert.equal(response.status, 200, JSON.stringify(proposal))
  assert.ok(isExecutableAgentProposal(proposal), 'Ollama must return an executable tool call and waiting description')
  assert.ok(isExternalWaitingDescription(proposal.waiting_on_description, correction), 'Waiting on must describe an external dependency, never echo the edit instruction')
  assert.ok(proposal.investigation_summary.every((finding) => typeof finding === 'object' && Array.isArray(finding.source_event_ids)))
  assert.ok(proposal.investigation_summary.some((finding) => finding.source_event_ids.includes(eventId)), 'The direct quote evidence should be cited')
  assert.match(JSON.stringify(proposal), /train|rail/i)
  const [saved] = await sql`select agent_proposal from orders where id = ${orderId}`
  assert.deepEqual(saved.agent_proposal, proposal)
  const [feedback] = await sql`select * from agent_proposal_feedback where order_id = ${orderId}`
  assert.equal(feedback.decision, 'OVERRIDE')
  assert.equal(feedback.outcome, 'APPLIED')
  assert.equal(feedback.correction, correction)
  assert.deepEqual(feedback.previous_proposal, previous)
  assert.deepEqual(feedback.replacement_proposal, proposal)
  const execute = await fetch(base + '/api/agent/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, executable_tool_call: proposal.executable_tool_call, waiting_on_description: proposal.waiting_on_description, proposal }) })
  const executed = await execute.json()
  assert.equal(execute.status, 200, JSON.stringify(executed))
  const [followUp] = await sql`select * from orders where id = ${orderId}`
  assert.equal(followUp.status, 'follow_up')
  assert.equal(followUp.agent_proposal, null)
  assert.equal(followUp.waiting_on_description, proposal.waiting_on_description)
  assert.equal((await sql`select * from agent_mock_actions where order_id = ${orderId}`).length, 1)
  console.log('Verified live Ollama executable proposal, human correction, mock approval, exact follow_up status, cleared proposal and persisted waiting description.')
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
