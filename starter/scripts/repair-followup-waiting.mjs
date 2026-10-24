import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import postgres from 'postgres'
const { isWaitingAlignedWithAction } = createRequire(import.meta.url)('../lib/agent.ts')
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
// Narrow repair for the two confirmed copies of the old prompt example.
// Approval records and original events remain intact; correction is appended.
const oldWaiting = 'Signed delivery proof from the receiving site'
const repairs = [
  { orderId: 'ord-00009', sourceId: 'work-x536223efaa59e0b6', collection: 'work_items',
    expectedAction: 'Identity input required', waiting: 'Customer-provided VIN or registration for CD-420009.' },
  { orderId: 'ord-00154', sourceId: 'agent-x68cbbd7e6e58691c', collection: 'agent_proposals',
    expectedAction: 'Recheck road, rest, check-in, vehi', waiting: 'Current crossing capacity and driver positioning/rest feasibility for CD-420154.' },
]
try {
  await sql.begin(async (tx) => {
    for (const repair of repairs) {
      const [order] = await tx`select * from orders where id=${repair.orderId} for update`
      assert.ok(order, `${repair.orderId}: order exists`)
      if (order.waiting_on_description !== oldWaiting) { console.log(`${order.reference}: no matching stale value; skipped.`); continue }
      assert.equal(order.status, 'follow_up')
      const [action] = await tx`select * from agent_mock_actions where order_id=${order.id} order by created_at desc limit 1 for update`
      const [approval] = await tx`select * from agent_proposal_feedback where order_id=${order.id} and outcome='MOCK_EXECUTED' order by created_at desc limit 1`
      const [source] = await tx`select * from related_records where collection=${repair.collection} and id=${repair.sourceId} and order_id=${order.id}`
      assert.ok(source, 'Correction must be grounded in this order’s source work')
      assert.equal(action?.payload.description, repair.expectedAction, 'Never alter a different approved action')
      assert.equal(action.waiting_on_description, oldWaiting)
      assert.equal(approval?.previous_proposal?.waiting_on_description, oldWaiting)
      const corrected = { ...approval.previous_proposal, waiting_on_description: repair.waiting }
      assert.ok(isWaitingAlignedWithAction(corrected))
      const reason = 'Corrected an unrelated system-prompt example copied into the waiting event. The approved mock action is unchanged; the expected result follows this order’s recorded work.'
      const eventId = `evt-${randomUUID()}`
      await tx`update orders set waiting_on_description=${repair.waiting},agent_revision=agent_revision+1,updated_at=now() where id=${order.id}`
      await tx`update agent_mock_actions set waiting_on_description=${repair.waiting} where id=${action.id} and order_id=${order.id}`
      await tx`insert into operational_events (id,order_id,command,target_type,target_id,recorded_at,details)
        values (${eventId},${order.id},'agent.follow_up_waiting_corrected','mock_action',${action.id},now(),${tx.json({
          actor_type: 'system', actor_id: 'local-data-repair', source: 'control_room_repair', simulated: true,
          changes: { previous_waiting_on_description: oldWaiting, waiting_on_description: repair.waiting, reason,
            source_refs: [{ table: repair.collection, id: repair.sourceId }], original_action_event_id: action.event_id, approval_feedback_id: approval.id },
        })})`
      await tx`insert into agent_proposal_feedback (id,order_id,decision,correction,previous_proposal,replacement_proposal,outcome,operator_id,created_at,completed_at)
        values (${`feedback-${randomUUID()}`},${order.id},'CORRECT_WAITING',${reason},${tx.json(approval.previous_proposal)},${tx.json(corrected)},'CORRECTED','system',now(),now())`
      console.log(`${order.reference}: waiting on ${repair.waiting}`)
    }
  })
} finally { await sql.end() }
