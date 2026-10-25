import { CustomerEmailError, logPhoneCall } from "@/lib/customer-email"
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
  const note = body.note
  if (typeof note !== "string" || !note.trim() || note.length > 2000) {
    return Response.json({ error: "Write a note of 1–2000 characters about the call." }, { status: 400 })
  }
  try {
    return Response.json(await logPhoneCall(id, recipient, note.trim()))
  } catch (error) {
    if (error instanceof CustomerEmailError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
