import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { agentMockActions, agentProposalFeedback, alerts, operationalEvents, orders } from "@/lib/schema"
import { AgentReviewConflict } from "./agent-store"
import { nextActionTime } from "./clock"

export const MANUAL_STATUSES = { NEW: "intake", WAITING_FOR_PICKUP: "booked", IN_TRANSIT: "moving", DELIVERED: "delivered", CANCELLED: "cancelled" } as const

export type ManualOperation = "takeover" | "note" | "resolve" | "end"
/** How manual control ends: the person confirms the problem is solved, or hands the order back to the agent. */
export type ManualEnding = "solved" | "handed_back"

export async function updateManualOrder(orderId: string, operation: ManualOperation, note: string,
  nextStatus?: keyof typeof MANUAL_STATUSES, ending?: ManualEnding) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return null
    if (operation === "takeover" && order.agentMode === "MANUAL") return { success: true, mode: "MANUAL",
      decision: order.agentDecision, decidedAt: order.agentDecisionAt, openAlertIds: [], resolvedAlertIds: [], eventId: null }
    if (operation !== "takeover" && order.agentMode !== "MANUAL") throw new AgentReviewConflict("Take over this order before recording what you did.")
    if (operation === "end" && ending !== "solved" && ending !== "handed_back") throw new AgentReviewConflict("Choose whether the problem is solved or goes back to the agent.")
    const now = await nextActionTime(tx)
    const eventId = `evt-${randomUUID()}`
    // Taking over is not solving: alerts keep their status. Record which ones were open.
    const open = await tx.select().from(alerts).where(and(
      eq(alerts.orderId, orderId), inArray(alerts.status, ["OPEN", "ACKNOWLEDGED"])))
    const openAlertIds = open.map((alert) => alert.id)
    // Only a person confirming the problem is solved resolves alerts, with their note as the reason.
    const resolvedAlertIds = operation === "end" && ending === "solved" ? openAlertIds : []
    for (const alert of operation === "end" && ending === "solved" ? open : []) {
      await tx.update(alerts).set({ status: "RESOLVED", details: { ...alert.details, status: "RESOLVED",
        resolved_at: now.toISOString(), resolved_by: "operator", resolved_by_type: "operator", resolution_reason: note,
        resolution_kind: "OPERATOR_CONFIRMED_SOLVED", resolution_event_id: eventId, previous_status: alert.status } }).where(eq(alerts.id, alert.id))
    }
    const mode = operation === "resolve" ? "MANUAL_COMPLETE" : operation === "end" ? (ending === "solved" ? "MANUAL_COMPLETE" : "AGENT") : "MANUAL"
    // Ending manual control closes a follow-up still waiting from before, and the order
    // returns to the status it had when that follow-up started.
    let restoredStatus: string | null = null
    let closedFollowUpId: string | null = null
    if (operation === "end") {
      const [waiting] = await tx.select().from(agentMockActions).where(and(eq(agentMockActions.orderId, orderId), eq(agentMockActions.status, "WAITING")))
        .orderBy(desc(agentMockActions.createdAt)).limit(1)
      if (waiting) {
        await tx.update(agentMockActions).set({ status: "ENDED" }).where(eq(agentMockActions.id, waiting.id))
        closedFollowUpId = waiting.id
        const [started] = await tx.select({ details: operationalEvents.details }).from(operationalEvents).where(eq(operationalEvents.id, waiting.eventId)).limit(1)
        const from = started?.details.from_state
        if (order.status === "follow_up" && typeof from === "string" && from !== "follow_up") restoredStatus = from
      }
    }
    if (operation === "takeover") {
      await tx.insert(agentProposalFeedback).values({ id: `feedback-${randomUUID()}`, orderId, decision: "TAKEOVER",
        previousProposal: order.agentProposal, correction: note || "Operator chose manual takeover.",
        outcome: "MANUAL_TAKEOVER", createdAt: now, completedAt: now })
    }
    await tx.update(orders).set({
      agentMode: mode,
      ...(operation === "takeover" ? { agentProposal: null, agentRevision: order.agentRevision + 1,
        agentDecision: "TAKEN_OVER", agentDecisionAt: now } : {}),
      // Handing back: the agent may suggest again, a person still decides. Solved: closed by the person.
      ...(operation === "end" ? { agentRevision: order.agentRevision + 1, agentDecision: ending === "solved" ? "TAKEN_OVER" : "PENDING",
        agentDecisionAt: ending === "solved" ? now : null,
        ...(restoredStatus ? { status: restoredStatus, waitingOnDescription: null } : {}) } : {}),
      ...(operation === "resolve" && nextStatus ? { status: nextStatus, displayLane: MANUAL_STATUSES[nextStatus], waitingOnDescription: null } : {}),
      updatedAt: now,
    }).where(eq(orders.id, orderId))
    const command = operation === "takeover" ? "manual_control.started" : operation === "end" ? "manual_control.ended"
      : operation === "resolve" ? "manual.resolution_recorded" : "manual.note_added"
    await tx.insert(operationalEvents).values({ id: eventId, orderId, command,
      targetType: "order", targetId: orderId, recordedAt: now, details: {
        actor_type: "operator", actor_id: "operator", source: "control_room_manual", simulated: true,
        from_state: order.status, to_state: operation === "resolve" ? nextStatus : restoredStatus ?? order.status,
        changes: { note, agent_mode: mode, open_alert_ids: openAlertIds, closed_follow_up_id: closedFollowUpId,
          alert_statuses: Object.fromEntries(open.map((alert) => [alert.id, alert.status])),
          ...(operation === "end" ? { choice: ending, resolved_alert_ids: resolvedAlertIds } : {}),
          ...(operation === "takeover" ? { previous_proposal: order.agentProposal } : {}) },
      } })
    return { success: true, mode, decision: operation === "takeover" || (operation === "end" && ending === "solved") ? "TAKEN_OVER"
      : operation === "end" ? "PENDING" : order.agentDecision,
      decidedAt: operation === "takeover" ? now : operation === "end" ? (ending === "solved" ? now : null) : order.agentDecisionAt,
      openAlertIds, resolvedAlertIds, eventId, recordedAt: now }
  })
}
