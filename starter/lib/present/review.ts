import type { BoardCard } from "./types"

export const REVIEW_COLUMNS = [
  { id: "priority", title: "Priority review", description: "High-priority decisions first" },
  { id: "review", title: "Needs review", description: "Open questions and blocked work" },
  { id: "followup", title: "Follow-up", description: "Owned checks and expected replies" },
  { id: "manual", title: "Manual control", description: "Work taken over by operations" },
] as const

/** Open conversations and unconfirmed inbox matches are context, not diagnoses. */
export function reviewReasons(card: Pick<BoardCard, "attention">) {
  return (card.attention ?? []).filter((item) => item.kind !== "conversation"
    && (item.kind !== "inbox" || item.requiresReview === true))
}

export function needsControlRoomReview(card: BoardCard): boolean {
  const activeAlerts = card.openAlerts.length > 0 || card.acknowledgedAlerts.length > 0
  // Finishing manual work closes its old derived checks; a new alert can reopen it.
  if (card.agentMode === "MANUAL_COMPLETE") return activeAlerts
  return card.agentMode === "MANUAL" || card.status.toUpperCase() === "FOLLOW_UP"
    || ["APPROVED", "REJECTED"].includes(card.agentDecision ?? "") || activeAlerts
    || card.isBlocked === true || card.status.toUpperCase() === "BLOCKED" || reviewReasons(card).length > 0
}

export function reviewType(card: BoardCard): typeof REVIEW_COLUMNS[number]["id"] {
  if (card.agentMode === "MANUAL") return "manual"
  if (card.status.toUpperCase() === "FOLLOW_UP") return "followup"
  if (["APPROVED", "REJECTED"].includes(card.agentDecision ?? "")) return "followup"
  if (card.openAlerts.some((severity) => severity === "high" || severity === "critical")) return "priority"
  const reasons = card.agentMode === "MANUAL_COMPLETE" ? [] : reviewReasons(card)
  if (reasons.some((item) => item.tone === "danger")) return "priority"
  if (card.openAlerts.length || card.isBlocked || card.status.toUpperCase() === "BLOCKED"
    || reasons.some((item) => item.tone === "warn" || ["check", "claim"].includes(item.kind)
      || (["work", "waiting", "custody"].includes(item.kind) && !item.owner)
      || (item.kind === "proposal" && item.atLabel !== "approved"))) return "review"
  if (!card.acknowledgedAlerts.length && !reasons.length) return "review"
  return "followup"
}

export function reviewBadge(card: BoardCard): string {
  const type = reviewType(card)
  if (type === "manual") return "Manual follow-up"
  if (type === "followup" && card.agentDecision === "APPROVED") return "Approved · follow-up"
  if (type === "followup" && card.agentDecision === "REJECTED") return "Rejected · follow-up"
  return REVIEW_COLUMNS.find((column) => column.id === type)!.title
}
