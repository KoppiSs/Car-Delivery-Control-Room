// Approving a follow-up plan: the agent's own plan, or a person's edit of it ("Your version").
// Every approval names who we are waiting for. The recipient is chosen by a person and
// stored structured (type, id, name), never guessed from the plan's words. The agent's
// original stays stored next to a human edit. Approving never resolves alerts: approving
// an action does not fix the problem. If the plan asks someone, the order is Pending.

import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { isAgentProposal, isExecutableAgentProposal, type AgentProposal } from "./agent"
import { AgentReviewConflict, sameProposal } from "./agent-store"
import { nextActionTime } from "./clock"
import { db } from "./db"
import { loadOrder } from "./present/load"
import { partiesFor } from "./present/names"
import { FOLLOW_UP_RECIPIENT_LABELS, type FollowUpRecipient } from "./present/names-text"
import { agentMockActions, agentProposalFeedback, alerts, operationalEvents, orders } from "./schema"

export type EditedPlan = { action: string; recipient: FollowUpRecipient; waitingOn: string }

export function isRecipient(value: unknown): value is FollowUpRecipient {
  return typeof value === "string" && value in FOLLOW_UP_RECIPIENT_LABELS
}

export function isEditedPlan(value: unknown): value is EditedPlan {
  if (!value || typeof value !== "object") return false
  const plan = value as Record<string, unknown>
  const text = (entry: unknown, max: number) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= max
  return text(plan.action, 400) && isRecipient(plan.recipient)
    && (plan.recipient === "nobody" ? typeof plan.waitingOn === "string" && plan.waitingOn.length <= 300 : text(plan.waitingOn, 300))
}

/** A short, readable record of what the person changed, stored as the correction. */
function describeEdit(original: AgentProposal, edited: EditedPlan, recipientName: string | null): string {
  const changes: string[] = []
  if (edited.action.trim() !== original.proposed_action.trim()) changes.push(`Action: "${edited.action.trim()}" instead of "${original.proposed_action.trim()}"`)
  changes.push(`Goes to: ${FOLLOW_UP_RECIPIENT_LABELS[edited.recipient]}${recipientName ? ` (${recipientName})` : ""}`)
  if (edited.waitingOn.trim() !== (original.waiting_on_description ?? "").trim()) changes.push(`Waiting for: "${edited.waitingOn.trim() || "nothing"}"`)
  return changes.join("; ")
}

/**
 * Approves a plan. `edited` false: the agent's plan as it stands, with the recipient a person chose.
 * `edited` true: the person's version, stored next to the agent's original.
 */
export async function approvePlan(orderId: string, original: AgentProposal, plan: EditedPlan, edited: boolean) {
  if (!isAgentProposal(original)) throw new AgentReviewConflict("The agent's proposal is missing. Reopen the order.")
  if (!edited && !isExecutableAgentProposal(original)) throw new AgentReviewConflict("This plan has no follow-up action yet. Edit it into your own version first.")
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  // The recipient must be someone on this order; their id and name come from the records, not the browser.
  const party = plan.recipient === "nobody" ? null : partiesFor(loaded.bundle)[plan.recipient]
  if (plan.recipient !== "nobody" && !party) throw new AgentReviewConflict(`There is no ${FOLLOW_UP_RECIPIENT_LABELS[plan.recipient].toLowerCase()} on file for this order.`)

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return null
    if (order.agentMode !== "AGENT") throw new AgentReviewConflict("This order is under manual control.")
    if (order.status === "follow_up") throw new AgentReviewConflict("This order is already waiting for an answer.")
    if (!sameProposal(order.agentProposal, original)) throw new AgentReviewConflict("The agent's proposal has changed. Reopen the order before approving.")

    const now = await nextActionTime(tx)
    const asksSomeone = !!party
    const action = (edited ? plan.action : original.proposed_action).trim()
    const waitingOn = (edited ? plan.waitingOn : original.waiting_on_description ?? "").trim()
    const approved: AgentProposal = edited ? {
      ...original,
      proposed_action: action,
      executable_tool_call: { action_type: original.executable_tool_call?.action_type ?? "operator.plan", payload: { description: action } },
      waiting_on_description: asksSomeone ? waitingOn : "No reply needed",
    } : original
    const open = await tx.select({ id: alerts.id, status: alerts.status }).from(alerts)
      .where(and(eq(alerts.orderId, orderId), inArray(alerts.status, ["OPEN", "ACKNOWLEDGED"])))
    const linkedAlertIds = open.map((alert) => alert.id)
    const actionId = `mock-${randomUUID()}`
    const startedId = `evt-${randomUUID()}`
    const recipient = { recipient_type: plan.recipient, recipient_id: party?.id ?? null, recipient_actor_type: party?.actorType ?? null,
      recipient_name: party?.name ?? null }
    const correction = edited ? describeEdit(original, plan, party?.name ?? null) : null

    await tx.insert(agentProposalFeedback).values({ id: `feedback-${randomUUID()}`, orderId,
      decision: edited ? "OVERRIDE" : "APPROVE", correction, previousProposal: original, replacementProposal: edited ? approved : null,
      outcome: edited ? "APPROVED_EDITED" : "MOCK_EXECUTED", operatorId: "operator", createdAt: now, completedAt: now })
    await tx.insert(agentMockActions).values({ id: actionId, orderId, actionType: approved.executable_tool_call!.action_type,
      payload: { description: action, ...recipient, edited_by: edited ? "person" : "agent" },
      waitingOnDescription: asksSomeone ? waitingOn : "No reply needed", status: asksSomeone ? "WAITING" : "DONE",
      eventId: startedId, createdAt: now })
    if (asksSomeone) {
      await tx.insert(operationalEvents).values({ id: startedId, orderId, command: "agent.follow_up_started",
        targetType: "mock_action", targetId: actionId, recordedAt: now, details: {
          actor_type: "operator", actor_id: "operator", source: "control_room_mock", simulated: true,
          from_state: order.status, to_state: "follow_up",
          changes: { action: approved.executable_tool_call, waiting_on_description: waitingOn, mock_action_id: actionId,
            linked_alert_ids: linkedAlertIds, ...recipient, edited_by: edited ? "person" : "agent" },
        } })
    }
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: "agent.action_approved",
      targetType: "mock_action", targetId: actionId, recordedAt: now, details: {
        actor_type: "operator", actor_id: "operator", source: "control_room_mock", simulated: true,
        changes: { mock_action_id: actionId, action_type: approved.executable_tool_call!.action_type, edited, edited_by: edited ? "person" : "agent",
          correction, ...recipient, linked_alert_ids: linkedAlertIds,
          alert_statuses: Object.fromEntries(open.map((alert) => [alert.id, alert.status])) },
      } })
    await tx.update(orders).set({
      ...(asksSomeone ? { status: "follow_up", waitingOnDescription: waitingOn } : {}),
      agentProposal: null, agentDecision: "APPROVED", agentDecisionAt: now, agentRevision: order.agentRevision + 1, updatedAt: now,
    }).where(eq(orders.id, orderId))
    return { success: true, simulated: true, edited, status: asksSomeone ? "follow_up" : order.status, actionId,
      waitingFor: party?.name ?? null, waiting_on_description: asksSomeone ? waitingOn : null, decidedAt: now }
  })
}
