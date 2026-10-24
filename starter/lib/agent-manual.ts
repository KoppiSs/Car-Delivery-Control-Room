import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { agentProposalFeedback, alerts, operationalEvents, orders } from "@/lib/schema"
import { AgentReviewConflict } from "./agent-store"

export const MANUAL_STATUSES = { NEW: "intake", WAITING_FOR_PICKUP: "booked", IN_TRANSIT: "moving", DELIVERED: "delivered", CANCELLED: "cancelled" } as const

export async function updateManualOrder(orderId: string, operation: "takeover" | "note" | "resolve", note: string, nextStatus?: keyof typeof MANUAL_STATUSES) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return null
    if (operation === "takeover" && order.agentMode === "MANUAL") return { success: true, mode: "MANUAL",
      decision: order.agentDecision, decidedAt: order.agentDecisionAt, resolvedAlertIds: [], eventId: null }
    if (operation !== "takeover" && order.agentMode !== "MANUAL") throw new AgentReviewConflict("Take over this order before recording a manual resolution.")
    const now = new Date()
    const eventId = `evt-${randomUUID()}`
    const active = operation === "takeover" ? await tx.select().from(alerts).where(and(
      eq(alerts.orderId, orderId), inArray(alerts.status, ["OPEN", "ACKNOWLEDGED"]),
    )).for("update") : []
    const reason = "Automated alert review ended after operator takeover. The underlying work remains open under manual ownership."
    for (const alert of active) {
      await tx.update(alerts).set({ status: "RESOLVED", details: { ...alert.details, status: "RESOLVED",
        resolved_at: now.toISOString(), resolution_reason: reason, resolution_event_id: eventId,
        resolution_kind: "MANUAL_TAKEOVER", takeover_previous_status: alert.status,
        manual_followup_required: true } }).where(eq(alerts.id, alert.id))
    }
    const mode = operation === "resolve" ? "MANUAL_COMPLETE" : "MANUAL"
    if (operation === "takeover") {
      await tx.insert(agentProposalFeedback).values({ id: `feedback-${randomUUID()}`, orderId, decision: "TAKEOVER",
        previousProposal: order.agentProposal, correction: note || "Operator chose manual takeover.",
        outcome: "MANUAL_TAKEOVER", createdAt: now, completedAt: now })
    }
    await tx.update(orders).set({
      agentMode: mode,
      ...(operation === "takeover" ? { agentProposal: null, agentRevision: order.agentRevision + 1,
        agentDecision: "TAKEN_OVER", agentDecisionAt: now } : {}),
      ...(operation === "resolve" && nextStatus ? { status: nextStatus, displayLane: MANUAL_STATUSES[nextStatus], waitingOnDescription: null } : {}),
      updatedAt: now,
    }).where(eq(orders.id, orderId))
    await tx.insert(operationalEvents).values({ id: eventId, orderId,
      command: operation === "takeover" ? "agent.manual_takeover" : operation === "resolve" ? "manual.resolution_recorded" : "manual.note_added",
      targetType: "order", targetId: orderId, recordedAt: now, details: {
        actor_type: "operator", actor_id: "operator", source: "control_room_manual", simulated: true,
        from_state: order.status, to_state: operation === "resolve" ? nextStatus : order.status,
        changes: { note, agent_mode: mode, resolved_alert_ids: active.map((alert) => alert.id),
          ...(operation === "takeover" ? { resolution_reason: reason, previous_proposal: order.agentProposal } : {}) },
      } })
    return { success: true, mode, decision: operation === "takeover" ? "TAKEN_OVER" : order.agentDecision,
      decidedAt: operation === "takeover" ? now : order.agentDecisionAt,
      resolvedAlertIds: active.map((alert) => alert.id), eventId }
  })
}
