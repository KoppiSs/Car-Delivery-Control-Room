// Email templates for the customer and the sites on an order. Pure text, no
// database access, so the UI can use it directly. Placeholders are {field}; a
// required field left empty stays visible as {field} in the rendered text and
// is listed in `missing`. An optional field left empty simply drops out.

export type TemplateId =
  | "delay_notice" | "delivery_delay" | "pickup_change" | "status_update"
  | "site_readiness" | "site_pickup_time" | "site_access" | "site_arrival_time"

/** Who an email goes to. Drivers are not here: they use app chat. */
export type RecipientType = "customer" | "pickup_site" | "delivery_site"

export type Template = {
  label: string
  /** One line for the operator choosing a template. */
  description: string
  /** What we are waiting to hear about, for the control table: "new pickup time". */
  about: string
  /** Who this template can be sent to. */
  recipients: RecipientType[]
  /**
   * True when the email asks something and we wait for the answer: sending it puts the order in Pending.
   * False when it only informs: the card shows "informed" and the order stays where it is.
   */
  expectsReply: boolean
  subject: string
  body: string
  fields: string[]
  /** Fields the operator may leave empty. Every other field must be filled before sending. */
  optional: string[]
  /** Fixed closing sentence. Appended after the body and never editable. */
  closing: string | null
}

export const NO_CHANGE_CLOSING = "We have not changed anything in the order. Nothing changes until you confirm."

export const RECIPIENT_LABELS: Record<RecipientType, string> = {
  customer: "Customer", pickup_site: "Pickup site", delivery_site: "Delivery site",
}

export const RECIPIENT_TYPES = Object.keys(RECIPIENT_LABELS) as RecipientType[]

export const TEMPLATES: Record<TemplateId, Template> = {
  delay_notice: {
    about: "possible delay",
    label: "Possible delay",
    description: "Tell the customer we see a possible delay and are on it. Nothing changes yet and no reply is needed.",
    recipients: ["customer"],
    expectsReply: false,
    subject: "{reference}: possible delay for your {car}",
    body: [
      "Hello {customer},",
      "We see a possible delay for your {car} (order {reference}). {reason}",
      "We are working on it. Nothing changes yet: delivery is still planned for {delivery}.",
      "You don't need to reply. If you have any questions, you can contact our support team at any time.",
    ].join("\n\n"),
    fields: ["customer", "reference", "car", "reason", "delivery"],
    optional: ["reason"],
    closing: null,
  },
  delivery_delay: {
    about: "new delivery time",
    label: "Confirmed delay",
    description: "The promise will be missed. Ask the customer to agree a new delivery window; nothing changes until they do.",
    recipients: ["customer"],
    expectsReply: true,
    subject: "{reference}: new delivery time for your {car}",
    body: [
      "Hello {customer},",
      "The delivery of your {car} (order {reference}) will be later than planned. {reason}",
      "Planned delivery: {oldDelivery}\nNew expected delivery: {newDelivery}",
      "Please reply to let us know if the new time works for you.",
    ].join("\n\n"),
    fields: ["customer", "reference", "car", "reason", "oldDelivery", "newDelivery"],
    optional: [],
    closing: NO_CHANGE_CLOSING,
  },
  pickup_change: {
    about: "new pickup time",
    label: "Pickup change",
    description: "Propose a different pickup time and ask the customer to confirm it.",
    recipients: ["customer"],
    expectsReply: true,
    subject: "{reference}: new pickup time for your {car}",
    body: [
      "Hello {customer},",
      "We would like to move the pickup of your {car} (order {reference}).",
      "Current pickup: {oldSlot}\nProposed pickup: {newSlot}",
      "Delivery is still planned for {delivery}.",
      "Please reply to let us know if the new pickup time works for you.",
    ].join("\n\n"),
    fields: ["customer", "reference", "car", "oldSlot", "newSlot", "delivery"],
    optional: [],
    closing: NO_CHANGE_CLOSING,
  },
  status_update: {
    about: "status update",
    label: "Status update",
    description: "Send a short progress note. The customer does not need to confirm anything.",
    recipients: ["customer"],
    expectsReply: false,
    subject: "{reference}: update on your {car}",
    body: [
      "Hello {customer},",
      "A short update on your {car} (order {reference}). {update}",
      "Delivery is planned for {delivery}.",
      "If you have any questions, reply to this email.",
    ].join("\n\n"),
    fields: ["customer", "reference", "car", "update", "delivery"],
    optional: [],
    closing: null,
  },
  site_readiness: {
    about: "car, keys and papers ready",
    label: "Is the car ready?",
    description: "Check that the car, keys and papers are ready for the booked pickup.",
    recipients: ["pickup_site"],
    expectsReply: true,
    subject: "{reference}: is the {car} ready for pickup?",
    body: [
      "Hello {contact},",
      "We are due to collect the {car} (order {reference}) on {pickupSlot}.",
      "Can you confirm the car is ready, and that the keys and papers are with you? {question}",
      "Please reply to let us know.",
    ].join("\n\n"),
    fields: ["contact", "reference", "car", "pickupSlot", "question"],
    optional: ["question"],
    closing: null,
  },
  site_pickup_time: {
    about: "new handover time",
    label: "New handover time",
    description: "Ask if the site can hand the car over at a different time.",
    recipients: ["pickup_site"],
    expectsReply: true,
    subject: "{reference}: new handover time for the {car}",
    body: [
      "Hello {contact},",
      "We would like to collect the {car} (order {reference}) at a different time.",
      "Booked handover: {oldSlot}\nProposed handover: {newSlot}",
      "Can you hand the car over at the new time? Please reply to let us know.",
    ].join("\n\n"),
    fields: ["contact", "reference", "car", "oldSlot", "newSlot"],
    optional: [],
    closing: NO_CHANGE_CLOSING,
  },
  site_access: {
    about: "access and handover",
    label: "Access and handover",
    description: "Ask which gate or reception to use and who signs for the car.",
    recipients: ["pickup_site", "delivery_site"],
    expectsReply: true,
    subject: "{reference}: access and handover for the {car}",
    body: [
      "Hello {contact},",
      "Our driver will come to your site for the {car} (order {reference}).",
      "Which gate or reception should the driver use, and who will sign for the car? {question}",
      "Please reply to let us know.",
    ].join("\n\n"),
    fields: ["contact", "reference", "car", "question"],
    optional: [],
    closing: null,
  },
  site_arrival_time: {
    about: "new arrival time",
    label: "New arrival time",
    description: "Tell the delivery site the driver will arrive at a different time.",
    recipients: ["delivery_site"],
    expectsReply: true,
    subject: "{reference}: new arrival time for the {car}",
    body: [
      "Hello {contact},",
      "Our driver will arrive with the {car} (order {reference}) at a different time.",
      "Planned arrival: {oldArrival}\nNew expected arrival: {newArrival}",
      "Can someone receive the car at the new time? Please reply to let us know.",
    ].join("\n\n"),
    fields: ["contact", "reference", "car", "oldArrival", "newArrival"],
    optional: [],
    closing: NO_CHANGE_CLOSING,
  },
}

/** Plain names for the fields, for the operator. */
export const FIELD_LABELS: Record<string, string> = {
  customer: "Customer", contact: "Contact", reference: "Order", car: "Car", reason: "Reason", update: "Update",
  oldDelivery: "Planned delivery", newDelivery: "New delivery", delivery: "Delivery",
  oldSlot: "Current pickup", newSlot: "New pickup", pickupSlot: "Pickup slot", question: "Question",
  oldArrival: "Planned arrival", newArrival: "New arrival",
}

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[]

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && value in TEMPLATES
}

export function isRecipientType(value: unknown): value is RecipientType {
  return typeof value === "string" && value in RECIPIENT_LABELS
}

/** Required fields that are still empty. */
export function emptyRequired(templateId: TemplateId, fields: Record<string, string | null | undefined>): string[] {
  const template = TEMPLATES[templateId]
  return template.fields.filter((name) => !template.optional.includes(name) && !fields[name]?.trim())
}

function fill(pattern: string, fields: Record<string, string | null | undefined>, optional: string[], missing: Set<string>): string {
  return pattern.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = fields[name]?.trim()
    if (value) return value
    if (optional.includes(name)) return ""
    missing.add(name)
    return placeholder
  }).split("\n").map((line) => line.replace(/ {2,}/g, " ").trimEnd()).join("\n")
}

export function render(templateId: TemplateId, fields: Record<string, string | null | undefined>): {
  subject: string
  body: string
  missing: string[]
} {
  const template = TEMPLATES[templateId]
  const missing = new Set<string>()
  const subject = fill(template.subject, fields, template.optional, missing)
  const text = fill(template.body, fields, template.optional, missing)
  const body = template.closing ? `${text}\n\n${template.closing}` : text
  return { subject, body, missing: template.fields.filter((name) => missing.has(name)) }
}
