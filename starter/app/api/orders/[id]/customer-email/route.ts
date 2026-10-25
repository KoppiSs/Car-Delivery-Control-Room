import { CustomerEmailError, draftEmail, emailOverview, sendSimulatedEmail } from "@/lib/customer-email"
import { TEMPLATE_IDS, isRecipientType, isTemplateId } from "@/lib/templates"

export const runtime = "nodejs"

const json = (error: unknown) => {
  if (error instanceof CustomerEmailError) return Response.json({ error: error.message }, { status: error.status })
  throw error
}

// Without ?template: who can be written to, where each email stands, and the delay hint, all from stored records.
// With ?template (and optional &recipient): a draft for that template and recipient.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const params = new URL(request.url).searchParams
  const template = params.get("template")
  if (template === null) {
    const overview = await emailOverview(id)
    return overview ? Response.json(overview) : Response.json({ error: "Order not found." }, { status: 404 })
  }
  if (!isTemplateId(template)) return Response.json({ error: `Unknown template. Use one of: ${TEMPLATE_IDS.join(", ")}.` }, { status: 400 })
  const recipient = params.get("recipient") ?? undefined
  if (recipient !== undefined && !isRecipientType(recipient)) return Response.json({ error: "Unknown recipient." }, { status: 400 })
  try {
    const draft = await draftEmail(id, template, recipient)
    return draft ? Response.json({ draft }) : Response.json({ error: "Order not found." }, { status: 404 })
  } catch (error) { return json(error) }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 50_000) return Response.json({ error: "The email is too large." }, { status: 413 })
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body")
    body = value as Record<string, unknown>
  } catch { return Response.json({ error: "Send templateId, recipientType, subject, body, fields, draftBuiltAt and basis." }, { status: 400 }) }

  const { templateId, recipientType, subject, body: text, fields, draftBuiltAt, basis } = body
  if (!isTemplateId(templateId)) return Response.json({ error: `Unknown template. Use one of: ${TEMPLATE_IDS.join(", ")}.` }, { status: 400 })
  if (!isRecipientType(recipientType)) return Response.json({ error: "Choose who the email goes to." }, { status: 400 })
  if (typeof subject !== "string" || typeof text !== "string") return Response.json({ error: "Subject and body must be text." }, { status: 400 })
  if (!fields || typeof fields !== "object" || Array.isArray(fields)
    || Object.values(fields).some((value) => typeof value !== "string")) {
    return Response.json({ error: "Fields must be an object of text values." }, { status: 400 })
  }
  if (typeof draftBuiltAt !== "string" || Number.isNaN(Date.parse(draftBuiltAt)) || typeof basis !== "string") {
    return Response.json({ error: "Send the draftBuiltAt and basis returned with the draft." }, { status: 400 })
  }
  try {
    return Response.json(await sendSimulatedEmail(id, { templateId, recipientType, subject, body: text,
      fields: fields as Record<string, string>, draftBuiltAt, basis }))
  } catch (error) { return json(error) }
}
