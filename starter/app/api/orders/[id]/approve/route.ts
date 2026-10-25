import { AgentReviewConflict } from "@/lib/agent-store"
import { approvePlan, isRecipient } from "@/lib/approve-edited"
import { isAgentProposal } from "@/lib/agent"

export const runtime = "nodejs"

/** Approves the agent's plan as it stands. A person must say who we are waiting for; it is never guessed. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    if (text.length > 30_000) return Response.json({ error: "The plan is too large." }, { status: 413 })
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object") body = value as Record<string, unknown>
  } catch { /* validated below */ }
  if (!isAgentProposal(body.proposal)) return Response.json({ error: "Send the agent's proposal." }, { status: 400 })
  if (!isRecipient(body.recipient)) return Response.json({ error: "Who do we ask? Choose the customer (dealer), a site, the driver, or nobody." }, { status: 400 })
  const proposal = body.proposal
  try {
    const result = await approvePlan(id, proposal, { action: proposal.proposed_action, recipient: body.recipient,
      waitingOn: proposal.waiting_on_description ?? "" }, false)
    return result ? Response.json(result) : Response.json({ error: "Order not found." }, { status: 404 })
  } catch (error) {
    if (error instanceof AgentReviewConflict) return Response.json({ error: error.message }, { status: 409 })
    throw error
  }
}
