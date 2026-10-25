// Ends an approved agent follow-up when the email it was waiting for gets an answer.
// Runs inside the reply's transaction, so the follow-up card and the email card
// change together. It marks the waiting mock action DONE, records the answer and
// returns the order to the status it had before the follow-up (from_state).
// It never touches alerts or the agent_* columns.

import { randomUUID } from "node:crypto"
import { desc, eq } from "drizzle-orm"
import type { ReplyRecorded, Tx } from "./customer-email"
import { agentMockActions, operationalEvents, orders } from "./schema"

export type FollowUpClosed = { mockActionId: string; eventId: string; status: string } | null

export async function closeFollowUpOnReply(tx: Tx, reply: ReplyRecorded): Promise<FollowUpClosed> {
  const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, reply.orderId)).for("update")
  if (order?.status !== "follow_up") return null
  const [action] = await tx.select().from(agentMockActions).where(eq(agentMockActions.orderId, reply.orderId))
    .orderBy(desc(agentMockActions.createdAt)).limit(1)
  if (!action || action.status !== "WAITING") return null

  await tx.update(agentMockActions).set({ status: "DONE" }).where(eq(agentMockActions.id, action.id))
  // Agree or decline, the order goes back to the status it had before the follow-up started.
  // A decline comes back to the control table as a new reply; nothing else in the order changes.
  const [started] = await tx.select({ details: operationalEvents.details }).from(operationalEvents)
    .where(eq(operationalEvents.id, action.eventId)).limit(1)
  const fromState = typeof started?.details.from_state === "string" && started.details.from_state !== "follow_up"
    ? started.details.from_state : null
  if (fromState) {
    await tx.update(orders).set({ status: fromState, waitingOnDescription: null, updatedAt: reply.at }).where(eq(orders.id, reply.orderId))
  }
  const eventId = `evt-${randomUUID()}`
  await tx.insert(operationalEvents).values({ id: eventId, orderId: reply.orderId, command: "agent.follow_up_answered",
    targetType: "mock_action", targetId: action.id, recordedAt: reply.at, details: {
      actor_type: "operator", actor_id: "ops-support", source: "control_room_follow_up", simulated: true,
      recipient_type: reply.recipientType,
      changes: { mock_action_id: action.id, reply_message_id: reply.messageId, conversation_id: reply.conversationId,
        answer: reply.answer, waiting_on_description: action.waitingOnDescription, previous_status: action.status, status: "DONE" },
    } })
  if (fromState) {
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId: reply.orderId, command: "agent.follow_up_ended",
      targetType: "order", targetId: reply.orderId, recordedAt: reply.at, details: {
        actor_type: "operator", actor_id: "ops-support", source: "control_room_follow_up", simulated: true,
        from_state: "follow_up", to_state: fromState, changes: { mock_action_id: action.id, reply_message_id: reply.messageId, answer: reply.answer },
      } })
  }
  return { mockActionId: action.id, eventId, status: fromState ?? "follow_up" }
}
