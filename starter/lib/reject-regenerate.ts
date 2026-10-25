// Reject → regenerate. Every rejection is stored with its reason. A new proposal is asked for
// with all earlier rejected ones listed as "do not propose these again". The model is
// deterministic, so the answer is checked: if it repeats a rejected plan (same action and same
// recipient/waiting text), it is retried once with a higher temperature; if it still repeats,
// that is said plainly ("no other suggestion") instead of pretending it changed.

import { randomUUID } from "node:crypto"
import { desc, eq } from "drizzle-orm"
import { buildAgentGenerationRequest, isAgentProposal, parseAgentOutput, type AgentProposal } from "./agent"
import { AgentReviewConflict, sameProposal } from "./agent-store"
import { generateWithModel } from "./model-call"
import { updateManualOrder } from "./agent-manual"
import { nextActionTime } from "./clock"
import { db } from "./db"
import { loadOrder } from "./present/load"
import { agentProposalFeedback, operationalEvents, orders } from "./schema"

export type RegenerateOutcome =
  | { outcome: "new"; proposal: AgentProposal; rejectedInARow: number }
  | { outcome: "no_other"; rejectedInARow: number }
  | { outcome: "failed"; reason: string; rejectedInARow: number }
  | { outcome: "taken_over" }

const norm = (text: string | undefined) => (text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
const samePlan = (a: AgentProposal, b: AgentProposal) =>
  norm(a.proposed_action) === norm(b.proposed_action) && norm(a.waiting_on_description) === norm(b.waiting_on_description)

/** The rejections since the order's last approval, takeover or approved edit, newest first. */
async function rejectionsInARow(orderId: string) {
  const rows = await db.select().from(agentProposalFeedback).where(eq(agentProposalFeedback.orderId, orderId))
    .orderBy(desc(agentProposalFeedback.createdAt), desc(agentProposalFeedback.id))
  const streak: { proposal: AgentProposal; reason: string }[] = []
  for (const row of rows) {
    if (row.decision !== "REJECT") break
    if (isAgentProposal(row.previousProposal)) streak.push({ proposal: row.previousProposal, reason: row.correction ?? "" })
  }
  return streak
}

/** Stores one rejection with its reason. The rejected proposal stays visible until a new one replaces it. */
async function storeRejection(orderId: string, proposal: AgentProposal, reason: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new AgentReviewConflict("Order not found.")
    if (order.agentMode !== "AGENT") throw new AgentReviewConflict("This order is under manual control.")
    if (!sameProposal(order.agentProposal, proposal)) throw new AgentReviewConflict("This proposal has changed. Reopen the order before rejecting it.")
    const now = await nextActionTime(tx)
    await tx.insert(agentProposalFeedback).values({ id: `feedback-${randomUUID()}`, orderId, decision: "REJECT", correction: reason,
      previousProposal: proposal, outcome: "REJECTED", operatorId: "operator", createdAt: now, completedAt: now })
    await tx.update(orders).set({ agentDecision: "REJECTED", agentDecisionAt: now, agentRevision: order.agentRevision + 1, updatedAt: now })
      .where(eq(orders.id, orderId))
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: "agent.proposal_rejected", targetType: "order",
      targetId: orderId, recordedAt: now, details: { actor_type: "operator", actor_id: "operator", source: "control_room",
        changes: { decision: "REJECTED", reason, reviewed_proposal: proposal } } })
  })
}

/** Asks the model for a plan unlike every rejected one. Never throws for model problems. */
async function regenerate(orderId: string): Promise<Exclude<RegenerateOutcome, { outcome: "taken_over" }>> {
  const streak = await rejectionsInARow(orderId)
  const loaded = await loadOrder(orderId)
  if (!loaded) return { outcome: "failed", reason: "the order could not be loaded", rejectedInARow: streak.length }
  const events = loaded.events.map((event) => ({ id: event.id, command: event.command, recordedAt: event.recordedAt.toISOString(), details: event.details }))
  const context = { order: { id: orderId, reference: loaded.order.reference }, snapshot_at: loaded.bundle.snapshotAt, status: loaded.order.status,
    alerts: loaded.alerts.map((alert) => ({ signal: alert.signal, status: alert.status, severity: alert.severity, summary: alert.summary })) }
  const rejected = streak.map((entry) => entry.proposal)
  const steer = {
    correction: [`Do not propose these again; the operator rejected them:`,
      ...streak.map((entry, index) => `${index + 1}. "${entry.proposal.proposed_action}" (waiting on: ${entry.proposal.waiting_on_description ?? "nothing"}) — rejected because: ${entry.reason || "no reason given"}`),
      `Propose a different action or ask a different party.`].join("\n").slice(0, 1900),
    previousAction: rejected[0]?.proposed_action ?? "",
    previousWaitingOn: rejected[0]?.waiting_on_description,
  }
  const allowedIds = events.map((event) => event.id)
  const model = process.env.OLLAMA_MODEL || "llama3.2"
  for (const temperature of [0, 0.8]) {
    const request = buildAgentGenerationRequest(events, context, model, temperature ? 1 : 0, steer) as Record<string, unknown> & { options: Record<string, unknown> }
    request.options = { ...request.options, temperature }
    const result = await generateWithModel(request)
    if (!result.ok) return { outcome: "failed", reason: result.reason, rejectedInARow: streak.length }
    const proposal = parseAgentOutput(result.output, allowedIds, steer.correction)
    if (!proposal) {
      if (temperature) return { outcome: "failed", reason: "the model's answer was not a complete plan", rejectedInARow: streak.length }
      continue
    }
    if (rejected.some((entry) => samePlan(entry, proposal))) continue
    const saved = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
      if (!order || order.agentMode !== "AGENT" || order.status === "follow_up") return false
      const now = await nextActionTime(tx)
      await tx.update(orders).set({ agentProposal: proposal, agentDecision: "PENDING", agentDecisionAt: null, agentRevision: order.agentRevision + 1, updatedAt: now })
        .where(eq(orders.id, orderId))
      await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: "agent.proposal_revised", targetType: "order",
        targetId: orderId, recordedAt: now, details: { actor_type: "agent", actor_id: "local-agent", source: "control_room",
          changes: { replaces_rejected: streak.length, temperature } } })
      return true
    })
    if (!saved) return { outcome: "failed", reason: "the order changed while the agent was thinking", rejectedInARow: streak.length }
    return { outcome: "new", proposal, rejectedInARow: streak.length }
  }
  return { outcome: "no_other", rejectedInARow: streak.length }
}

/**
 * then = "regenerate": reject and ask for another. "takeover": reject and hand it to a person.
 * "retry": ask again after a failure, without storing another rejection.
 */
export async function rejectProposal(orderId: string, proposal: AgentProposal | null, reason: string,
  then: "regenerate" | "takeover" | "retry"): Promise<RegenerateOutcome> {
  if (then !== "retry") {
    if (!proposal) throw new AgentReviewConflict("Send the proposal being rejected.")
    await storeRejection(orderId, proposal, reason)
  }
  if (then === "takeover") {
    await updateManualOrder(orderId, "takeover", `Rejected the agent's plan: ${reason}`)
    return { outcome: "taken_over" }
  }
  return regenerate(orderId)
}

