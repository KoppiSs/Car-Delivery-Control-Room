import { CustomerEmailError, chooseCostOption } from "@/lib/customer-email"

export const runtime = "nodejs"

/** The operator picks one of the cost options. Stored as their decision; nothing is booked. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(await request.text()) as Record<string, unknown> } catch { /* validated below */ }
  if (typeof body.optionId !== "string" || !body.optionId) return Response.json({ error: "Pick one of the options." }, { status: 400 })
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (!reason || reason.length > 300 || /[\r\n]/.test(reason)) return Response.json({ error: "Write one line on why you picked it." }, { status: 400 })
  try {
    return Response.json(await chooseCostOption(id, body.optionId, reason))
  } catch (error) {
    if (error instanceof CustomerEmailError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
