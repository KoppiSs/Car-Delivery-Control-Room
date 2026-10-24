import type { BoardCard } from "./types"

export const REVIEW_COLUMNS = [
  { id: "priority", title: "Priority review", description: "High-priority decisions first" },
  { id: "review", title: "Needs review", description: "Open questions and blocked work" },
  { id: "followup", title: "Follow-up", description: "Reviewed plans and owned alerts" },
  { id: "manual", title: "Manual control", description: "Work taken over by operations" },
] as const

export function reviewType(card: BoardCard): typeof REVIEW_COLUMNS[number]["id"] {
  if (card.agentMode === "MANUAL") return "manual"
  if (card.status === "follow_up") return "followup"
  if (["APPROVED", "REJECTED"].includes(card.agentDecision ?? "")) return "followup"
  if (card.openAlerts.some((severity) => severity === "high" || severity === "critical")) return "priority"
  if (card.openAlerts.length || card.status.toUpperCase() === "BLOCKED" || !card.acknowledgedAlerts.length) return "review"
  return "followup"
}
