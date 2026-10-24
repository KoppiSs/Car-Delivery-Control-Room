// Shared deterministic business clock, independent of the computer's real time.
export const NOW = "2026-10-21T09:00:00Z"

export type Route = "fine" | "agent_investigate" | "person_now"
export type CaseStatus = "fine" | "agent_working" | "needs_person"
export type Fact = { text: string; source: string; at: string; recordId: string }
export type Evidence = { collection: string; recordId: string; timestamp: string | null }
export type Deadline = { at: string; label: string; collection: string; recordId: string }
export type Check = {
  rule: string
  passed: boolean
  outcome: "pass" | "fail" | "unknown" | "not_applicable"
  detail: string
  evidence: Evidence[]
}
export type Case = {
  id: string
  reference: string
  status: CaseStatus
  priority: number
  headline: string
  /** Human-readable journey, never the triage classification. */
  route: string
  checks: Check[]
  facts: Fact[]
  deadline: Deadline | null
}

/** Initial deterministic classification. Agent execution/persistence remains B's concern. */
export function classifyCase(value: Pick<Case, "status">): Route {
  return value.status === "needs_person" ? "person_now" : value.status === "agent_working" ? "agent_investigate" : "fine"
}
