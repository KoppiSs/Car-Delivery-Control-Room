import { MANUAL_STATUSES, updateManualOrder } from "@/lib/agent-manual"
import { AgentReviewConflict } from "@/lib/agent-store"

export const runtime = "nodejs"

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 10_000) return Response.json({ error: "Manual update is too large." }, { status: 413 })
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body")
    body = value as Record<string, unknown>
  } catch { return Response.json({ error: "Send an orderId and manual operation." }, { status: 400 }) }
  if (typeof body.orderId !== "string" || !body.orderId.trim() || body.orderId.length > 200
    || !["takeover", "note", "resolve"].includes(String(body.operation))) {
    return Response.json({ error: "An orderId and takeover, note or resolve operation are required." }, { status: 400 })
  }
  const note = typeof body.note === "string" ? body.note.trim() : ""
  if (note.length > 3000 || (body.operation !== "takeover" && !note)) {
    return Response.json({ error: "Enter a note of 1–3000 characters." }, { status: 400 })
  }
  if (body.operation === "resolve" && (typeof body.nextStatus !== "string" || !Object.hasOwn(MANUAL_STATUSES, body.nextStatus))) {
    return Response.json({ error: "Select the order status after resolution." }, { status: 400 })
  }
  try {
    const result = await updateManualOrder(body.orderId, body.operation as "takeover" | "note" | "resolve", note,
      body.nextStatus as keyof typeof MANUAL_STATUSES | undefined)
    if (!result) return Response.json({ error: "Order not found." }, { status: 404 })
    return Response.json(result)
  } catch (error) {
    return Response.json({ error: error instanceof AgentReviewConflict ? error.message : "Could not save the manual update. Please retry." },
      { status: error instanceof AgentReviewConflict ? 409 : 500 })
  }
}
