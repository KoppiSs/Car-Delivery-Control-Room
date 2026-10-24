import { randomUUID } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/lib/db"
import { agentProposalFeedback, operationalEvents, orders } from "@/lib/schema"
import { isAgentProposal, type AgentProposal } from "./agent"

export class AgentReviewConflict extends Error {}

export function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export function sameProposal(previous: unknown, expected: AgentProposal): boolean {
  return isAgentProposal(previous) && previous.proposed_action === expected.proposed_action
    && previous.decision_button_text === expected.decision_button_text
    && sameJson(previous.investigation_summary, expected.investigation_summary)
    && sameJson(previous.executable_tool_call, expected.executable_tool_call)
    && previous.waiting_on_description === expected.waiting_on_description
}

export async function recordAgentDecision(orderId: string, decision: "APPROVED" | "REJECTED", expected: AgentProposal) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return null
    if (order.agentMode !== "AGENT" || !sameProposal(order.agentProposal, expected)) {
      throw new AgentReviewConflict("This proposal has changed or is under manual control. Reopen the order before reviewing it.")
    }
    if (order.agentDecision === decision) return { success: true, decision, decidedAt: order.agentDecisionAt }
    const now = new Date()
    await tx.insert(agentProposalFeedback).values({ id: `feedback-${randomUUID()}`, orderId,
      decision: decision === "APPROVED" ? "APPROVE" : "REJECT", previousProposal: order.agentProposal,
      outcome: decision, createdAt: now, completedAt: now })
    await tx.update(orders).set({ agentDecision: decision, agentDecisionAt: now,
      agentRevision: order.agentRevision + 1, updatedAt: now }).where(eq(orders.id, orderId))
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId,
      command: decision === "APPROVED" ? "agent.proposal_approved" : "agent.proposal_rejected",
      targetType: "order", targetId: orderId, recordedAt: now,
      details: { actor_type: "operator", actor_id: "operator", source: "control_room",
        changes: { decision, reviewed_proposal: order.agentProposal, executed: false } } })
    return { success: true, decision, decidedAt: now }
  })
}

export async function loadAgentOrder(orderId: string) {
  const [order] = await db.select({ id: orders.id, agentProposal: orders.agentProposal,
    agentMode: orders.agentMode, agentRevision: orders.agentRevision, status: orders.status })
    .from(orders).where(eq(orders.id, orderId)).limit(1)
  return order ?? null
}

export async function beginAgentOverride(orderId: string, correction: string, expected: AgentProposal) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return null
    const previous = order.agentProposal
    if (order.agentMode !== "AGENT" || !sameProposal(previous, expected)) {
      throw new AgentReviewConflict("This proposal has changed or is under manual control. Reopen the order before editing.")
    }
    const feedbackId = `feedback-${randomUUID()}`
    const revision = order.agentRevision + 1
    const now = new Date()
    await tx.insert(agentProposalFeedback).values({ id: feedbackId, orderId, decision: "OVERRIDE",
      correction, previousProposal: previous, outcome: "REQUESTED", createdAt: now })
    await tx.update(orders).set({ agentRevision: revision, updatedAt: now }).where(eq(orders.id, orderId))
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId,
      command: "agent.proposal_overridden", targetType: "order", targetId: orderId, recordedAt: now,
      details: { actor_type: "operator", actor_id: "operator", source: "control_room",
        changes: { correction, feedback_id: feedbackId, previous_proposal: previous } } })
    return { feedbackId, revision, previous: previous as AgentProposal }
  })
}

export async function finishAgentFeedback(feedbackId: string, outcome: string) {
  await db.update(agentProposalFeedback).set({ outcome, completedAt: new Date() })
    .where(and(eq(agentProposalFeedback.id, feedbackId), eq(agentProposalFeedback.outcome, "REQUESTED")))
}

export async function saveAgentProposal(orderId: string, proposal: AgentProposal, revision = 0, feedbackId?: string) {
  return db.transaction(async (tx) => {
    const [saved] = await tx.update(orders).set({ agentProposal: proposal, agentDecision: "PENDING", agentDecisionAt: null })
      .where(and(eq(orders.id, orderId), eq(orders.agentMode, "AGENT"), eq(orders.agentRevision, revision),
        feedbackId ? undefined : isNull(orders.agentProposal)))
      .returning({ agentProposal: orders.agentProposal })
    if (saved && feedbackId) {
      await tx.update(agentProposalFeedback).set({ replacementProposal: proposal, outcome: "APPLIED", completedAt: new Date() })
        .where(eq(agentProposalFeedback.id, feedbackId))
      await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId,
        command: "agent.proposal_revised", targetType: "order", targetId: orderId, recordedAt: new Date(),
        details: { actor_type: "agent", actor_id: "local-agent", source: "control_room",
          changes: { feedback_id: feedbackId, agent_revision: revision } } })
    }
    if (saved) return saved.agentProposal
    const [current] = await tx.select().from(orders).where(eq(orders.id, orderId))
    return !feedbackId && current?.agentMode === "AGENT" && current.agentRevision === revision ? current.agentProposal : null
  })
}
