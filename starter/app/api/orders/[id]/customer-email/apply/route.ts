import { CustomerEmailError, applySimulatedChange } from "@/lib/customer-email"
import { isRecipientType } from "@/lib/templates"

export const runtime = "nodejs"

// Records the change the recipient agreed to as a simulated event. time_windows and the order stay as they are.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let recipient: unknown = "customer"
  try {
    const value: unknown = JSON.parse(await request.text())
    if (value && typeof value === "object" && "recipient" in value) recipient = (value as Record<string, unknown>).recipient
  } catch { /* an empty body means the customer */ }
  if (!isRecipientType(recipient)) return Response.json({ error: "Unknown recipient." }, { status: 400 })
  try {
    return Response.json(await applySimulatedChange(id, recipient))
  } catch (error) {
    if (error instanceof CustomerEmailError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
