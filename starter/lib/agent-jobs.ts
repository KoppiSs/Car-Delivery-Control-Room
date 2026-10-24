import type { AgentProposal } from "./agent"

type Result = { status: number; body: AgentProposal | { error: string } }
// Keep work alive across drawer closes and Next.js development reloads.
const state = globalThis as typeof globalThis & { agentProposalJobs?: Map<string, Promise<Result>> }
const jobs = state.agentProposalJobs ??= new Map<string, Promise<Result>>()

export function runAgentJob(orderId: string, work: () => Promise<Result>, intent = ""): Promise<Result> {
  const key = intent ? `${orderId}:${intent}` : orderId
  const existing = jobs.get(key)
  if (existing) return existing
  // Local CPU inference cannot service an unbounded queue of different orders.
  if (jobs.size) return Promise.resolve({ status: 503, body: { error: "The agent is reviewing another order. Please retry shortly." } })
  const job = Promise.resolve().then(work).finally(() => { jobs.delete(key) })
  jobs.set(key, job)
  return job
}
