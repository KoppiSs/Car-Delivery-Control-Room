import { CustomerEmailError } from "@/lib/customer-email"
import { simulateFollowUpReply } from "@/lib/follow-up-reply"
import { suggestFollowUpReply } from "@/lib/simulated-reply"

export const runtime = "nodejs"

/** A suggested reply that answers what we asked, for the person to edit before recording it. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const suggestion = await suggestFollowUpReply(id)
  return suggestion ? Response.json(suggestion)
    : Response.json({ error: "No follow-up on this order is waiting for a recorded recipient." }, { status: 409 })
}

/** Demo: the party a waiting follow-up asked answers it, with the text the person kept or wrote. Nothing is sent. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(await request.text()) as Record<string, unknown> } catch { /* validated below */ }
  const answer = body.answer ?? "other"
  if (answer !== "agree" && answer !== "decline" && answer !== "other") return Response.json({ error: "Send answer \"agree\", \"decline\" or \"other\"." }, { status: 400 })
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (text.length > 1000 || (answer === "other" && !text)) return Response.json({ error: "Write a reply of 1–1000 characters." }, { status: 400 })
  try {
    const source = body.source === "scripted" || body.source === "model" || body.source === "fallback" || body.source === "operator" ? body.source : undefined
    return Response.json(await simulateFollowUpReply(id, answer, text || undefined, source))
  } catch (error) {
    if (error instanceof CustomerEmailError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
