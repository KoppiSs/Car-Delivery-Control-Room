import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { agentMockActions, agentProposalFeedback, alerts, operationalEvents, orders } from "@/lib/schema"
import { isExecutableAgentProposal, type ExecutableToolCall, type AgentProposal } from "./agent"
import { AgentReviewConflict, sameJson, sameProposal } from "./agent-store"

export async function executeMockResolution(orderId: string, action: ExecutableToolCall, waitingOnDescription: string, expected?: AgentProposal) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return null
    if (order.agentMode !== "AGENT") throw new AgentReviewConflict("This order is under manual control.")
    if (order.status === "follow_up" && order.agentProposal === null) {
      const [existing] = await tx.select().from(agentMockActions).where(eq(agentMockActions.orderId, orderId))
        .orderBy(desc(agentMockActions.createdAt)).limit(1)
      if (existing && existing.actionType === action.action_type && sameJson(existing.payload, action.payload)
        && existing.waitingOnDescription === waitingOnDescription) {
        return { success: true, simulated: true, status: "follow_up", actionId: existing.id, eventId: existing.eventId,
          waiting_on_description: existing.waitingOnDescription, resolvedAlertIds: [], decidedAt: order.agentDecisionAt }
      }
      throw new AgentReviewConflict("This order already has a different follow-up action. Reopen it to see the current state.")
    }
    const proposal = order.agentProposal
    if (!isExecutableAgentProposal(proposal)) throw new AgentReviewConflict("Prepare an updated proposal with a follow-up action before approving.")
    if (!sameJson(proposal.executable_tool_call, action) || proposal.waiting_on_description !== waitingOnDescription
      || (expected && !sameProposal(proposal, expected))) {
      throw new AgentReviewConflict("This proposal has changed. Reopen the order before approving it.")
    }
    const active = await tx.select().from(alerts).where(and(eq(alerts.orderId, orderId),
      inArray(alerts.status, ["OPEN", "ACKNOWLEDGED"]))).for("update")
    const now = new Date()
    const eventId = `evt-${randomUUID()}`
    const actionId = `mock-${randomUUID()}`
    const resolvedAlertIds = active.map((alert) => alert.id)
    const reason = "Operator approved a mocked follow-up action; the order is waiting for the recorded external event."
    await tx.insert(agentMockActions).values({ id: actionId, orderId, actionType: action.action_type,
      payload: action.payload, waitingOnDescription, eventId, createdAt: now })
    await tx.insert(operationalEvents).values({ id: eventId, orderId, command: "agent.follow_up_started",
      targetType: "mock_action", targetId: actionId, recordedAt: now, details: {
        actor_type: "operator", actor_id: "operator", source: "control_room_mock", simulated: true,
        from_state: order.status, to_state: "follow_up",
        changes: { action, waiting_on_description: waitingOnDescription, mock_action_id: actionId,
          resolved_alert_ids: resolvedAlertIds, resolution_reason: reason },
      } })
    await tx.insert(agentProposalFeedback).values({ id: `feedback-${randomUUID()}`, orderId,
      decision: "APPROVE", previousProposal: proposal, outcome: "MOCK_EXECUTED", createdAt: now, completedAt: now })
    for (const alert of active) {
      await tx.update(alerts).set({ status: "RESOLVED", details: { ...alert.details, status: "RESOLVED",
        resolved_at: now.toISOString(), resolution_reason: reason, resolution_event_id: eventId,
        resolution_kind: "MOCK_FOLLOW_UP", followup_previous_status: alert.status, simulated: true } }).where(eq(alerts.id, alert.id))
    }
    await tx.update(orders).set({ status: "follow_up", agentProposal: null, waitingOnDescription,
      agentDecision: "APPROVED", agentDecisionAt: now, agentRevision: order.agentRevision + 1, updatedAt: now }).where(eq(orders.id, orderId))
    return { success: true, simulated: true, status: "follow_up", actionId, eventId, waiting_on_description: waitingOnDescription,
      resolvedAlertIds, decidedAt: now }
  })
}
