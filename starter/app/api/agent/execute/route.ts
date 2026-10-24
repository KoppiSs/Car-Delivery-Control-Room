import { executeMockResolution } from "@/lib/agent-execute"
import { isAgentProposal, isExecutableToolCall, isExternalWaitingDescription, isWaitingAlignedWithAction } from "@/lib/agent"
import { AgentReviewConflict } from "@/lib/agent-store"

export const runtime = "nodejs"

/** Operator approval records a mock action only; no external tool is invoked. */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 50_000) return Response.json({ error: "Action payload is too large." }, { status: 413 })
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body")
    body = parsed as Record<string, unknown>
  } catch { return Response.json({ error: "Send orderId, executable_tool_call and waiting_on_description." }, { status: 400 }) }
  if (typeof body.orderId !== "string" || !body.orderId.trim() || body.orderId.length > 200) {
    return Response.json({ error: "orderId is required." }, { status: 400 })
  }
  const raw = body.executable_tool_call ?? body.action
  const nested = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  const waiting = body.waiting_on_description ?? nested?.waiting_on_description
  const action = nested && Object.hasOwn(nested, "waiting_on_description")
    ? { action_type: nested.action_type, payload: nested.payload } : raw
  if (!isExecutableToolCall(action) || typeof waiting !== "string" || !waiting.trim() || waiting.length > 500
    || (body.proposal !== undefined && !isAgentProposal(body.proposal))) {
    return Response.json({ error: "Provide an action_type, nonempty payload object and waiting_on_description (1–500 characters)." }, { status: 400 })
  }
  if (!isExternalWaitingDescription(waiting)) {
    return Response.json({ error: "Waiting on must name an external reply, document or confirmation. Revise the proposal before approving." }, { status: 400 })
  }
  if (isAgentProposal(body.proposal) && !isWaitingAlignedWithAction(body.proposal)) {
    return Response.json({ error: "The waiting event does not match the proposed action. Edit the proposal before approving." }, { status: 400 })
  }
  try {
    const result = await executeMockResolution(body.orderId, action, waiting, isAgentProposal(body.proposal) ? body.proposal : undefined)
    if (!result) return Response.json({ error: "Order not found." }, { status: 404 })
    return Response.json(result)
  } catch (error) {
    return Response.json({ error: error instanceof AgentReviewConflict ? error.message : "Could not record the mocked follow-up. Please retry." },
      { status: error instanceof AgentReviewConflict ? 409 : 500 })
  }
}
