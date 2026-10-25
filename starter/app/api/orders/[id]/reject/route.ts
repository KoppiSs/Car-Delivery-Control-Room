import { isAgentProposal } from "@/lib/agent"
import { AgentReviewConflict } from "@/lib/agent-store"
import { rejectProposal } from "@/lib/reject-regenerate"

export const runtime = "nodejs"

/**
 * Reject the agent's proposal with a one-line reason, then: "regenerate" (ask for another),
 * "takeover" (a person handles it), or "retry" (ask again after a failure, no new rejection).
 * Model problems come back as { outcome: "failed", reason }, never as an empty answer.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    if (text.length > 30_000) return Response.json({ error: "The request is too large." }, { status: 413 })
    body = JSON.parse(text) as Record<string, unknown>
  } catch { /* validated below */ }
  const then = body.then
  if (then !== "regenerate" && then !== "takeover" && then !== "retry") {
    return Response.json({ error: "Send then: regenerate, takeover or retry." }, { status: 400 })
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (then !== "retry" && (!reason || reason.length > 300 || /[\r\n]/.test(reason))) {
    return Response.json({ error: "Write one line on what's wrong with this proposal." }, { status: 400 })
  }
  if (then !== "retry" && !isAgentProposal(body.proposal)) return Response.json({ error: "Send the proposal being rejected." }, { status: 400 })
  try {
    return Response.json(await rejectProposal(id, isAgentProposal(body.proposal) ? body.proposal : null, reason, then))
  } catch (error) {
    if (error instanceof AgentReviewConflict) return Response.json({ error: error.message }, { status: 409 })
    throw error
  }
}
