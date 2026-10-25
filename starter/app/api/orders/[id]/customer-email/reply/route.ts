import { CustomerEmailError, recordSimulatedReply } from "@/lib/customer-email"
import { closeFollowUpOnReply } from "@/lib/follow-up-close"
import { isRecipientType } from "@/lib/templates"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(await request.text())
    if (value && typeof value === "object") body = value as Record<string, unknown>
  } catch { /* validated below */ }
  const recipient = body.recipient ?? "customer"
  if (!isRecipientType(recipient)) return Response.json({ error: "Unknown recipient." }, { status: 400 })
  // A quick pick ("agree" / "decline"), or "other" with the reply written out. A written text replaces the quick-pick wording.
  if (body.answer !== "agree" && body.answer !== "decline" && body.answer !== "other") {
    return Response.json({ error: "Send answer \"agree\", \"decline\" or \"other\" with the reply text." }, { status: 400 })
  }
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (text.length > 1000 || (body.answer === "other" && !text)) return Response.json({ error: "Write a reply of 1–1000 characters." }, { status: 400 })
  try {
    return Response.json(await recordSimulatedReply(id, recipient, body.answer, closeFollowUpOnReply, text || undefined))
  } catch (error) {
    if (error instanceof CustomerEmailError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
