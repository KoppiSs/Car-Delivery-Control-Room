import { isAgentProposal } from "@/lib/agent"
import { AgentReviewConflict, recordAgentDecision } from "@/lib/agent-store"

export const runtime = "nodejs"

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 30_000) return Response.json({ error: "Review payload is too large." }, { status: 413 })
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body")
    body = value as Record<string, unknown>
  } catch { return Response.json({ error: "Send an orderId, decision and proposal." }, { status: 400 }) }
  if (typeof body.orderId !== "string" || !body.orderId.trim() || body.orderId.length > 200
    || (body.decision !== "APPROVED" && body.decision !== "REJECTED") || !isAgentProposal(body.proposal)) {
    return Response.json({ error: "An orderId, APPROVED or REJECTED decision, and the reviewed proposal are required." }, { status: 400 })
  }
  try {
    const result = await recordAgentDecision(body.orderId, body.decision, body.proposal)
    if (!result) return Response.json({ error: "Order not found." }, { status: 404 })
    return Response.json(result)
  } catch (error) {
    if (!(error instanceof AgentReviewConflict)) console.error("Agent decision failed:", error instanceof Error ? error.message : error)
    return Response.json({ error: error instanceof AgentReviewConflict ? error.message : "Could not save this review. Please retry." },
      { status: error instanceof AgentReviewConflict ? 409 : 500 })
  }
}
