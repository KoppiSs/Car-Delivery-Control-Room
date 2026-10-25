import { AgentReviewConflict } from "@/lib/agent-store"
import { approvePlan, isEditedPlan } from "@/lib/approve-edited"
import { isAgentProposal } from "@/lib/agent"

export const runtime = "nodejs"

/** "Approve your version": approves the person's edit of the agent's plan, keeping both. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    if (text.length > 30_000) return Response.json({ error: "The plan is too large." }, { status: 413 })
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object") body = value as Record<string, unknown>
  } catch { /* validated below */ }
  if (!isAgentProposal(body.original)) return Response.json({ error: "Send the agent's original proposal." }, { status: 400 })
  if (!isEditedPlan(body.edited)) {
    return Response.json({ error: "Your version needs an action, who it goes to, and what we are waiting for (unless it goes to nobody)." }, { status: 400 })
  }
  try {
    const result = await approvePlan(id, body.original, body.edited, true)
    return result ? Response.json(result) : Response.json({ error: "Order not found." }, { status: 404 })
  } catch (error) {
    if (error instanceof AgentReviewConflict) return Response.json({ error: error.message }, { status: 409 })
    throw error
  }
}
