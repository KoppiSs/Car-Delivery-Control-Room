// Drafts an email to whoever an order's problem belongs to (the customer, the
// pickup site or the delivery site) and records a simulated send.
// Deterministic: every value comes from the database or stays empty for a
// person to write. Nothing is ever sent; a "send" is a message row marked
// simulated. A send never changes the order, its alerts or its agent columns,
// and an agreed change is recorded as a simulated event, never applied to time_windows.

import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, or, sql } from "drizzle-orm"
import { currentTime, nextActionTime } from "./clock"
import { costOptions, type CostOptions } from "./cost-options"
import { db } from "./db"
import { chosenWindows, windowViews } from "./present/attention"
import { finalDeliveryPoint, originPickupPoint, rows, str, type Bundle, type RelatedRow } from "./present/bundle"
import { label } from "./present/labels"
import { loadOrder } from "./present/load"
import type { WindowView } from "./present/types"
import { evaluateTriage, type Rule } from "./triage"
import { readAppPositions } from "./triage-read"
import { conversations, messages, operationalEvents, orders } from "./schema"
import { RECIPIENT_LABELS, RECIPIENT_TYPES, TEMPLATES, emptyRequired, render, type RecipientType, type TemplateId } from "./templates"

export type DraftField = {
  value: string
  /** Where the value came from, e.g. "vehicles.veh-123". Null when empty. */
  source: string | null
  /** The same source in plain words, e.g. "the delivery promise". Null when empty. */
  sourceLabel: string | null
  /** Snapshot time the value was read at. Null when empty. */
  at: string | null
  filledBy: "data" | "empty"
}

/**
 * Who an email goes to. Customers have no email address in the data; sites have a
 * contact handle. Nothing is ever sent to either.
 */
export type Recipient = {
  type: RecipientType
  /** Actor id as messages store it: the customer id, the site id, or the endpoint record for a one-off address. */
  id: string
  actorType: "customer" | "site_contact" | "handoff_contact"
  name: string
  role: string | null
  handle: string | null
  /** False when the order records the site contact as unconfirmed. */
  confirmed: boolean
  endpointId: string | null
}

export type EmailDraft = {
  orderId: string
  reference: string
  templateId: TemplateId
  recipient: Recipient
  fields: Record<string, DraftField>
  subject: string
  body: string
  missing: string[]
  replyToConversationId: string | null
  draftBuiltAt: string
  /** Order status and selected time windows the draft was built from. A send must hand it back unchanged. */
  basis: string
}

export class CustomerEmailError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message)
  }
}

export const ORDER_CHANGED = "The order changed since this draft was made. Check the fields again."
const OPERATOR_ID = "ops-support"
/** Thread status after an email that only informs: nobody is waiting for an answer. */
const INFORMED = "INFORMED"

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** How each recipient's thread is stored. */
const THREADS: Record<RecipientType, { channel: string; category: string; waitingStatus: string; waitingOn: string }> = {
  customer: { channel: "customer_email", category: "customer_update", waitingStatus: "WAITING_ON_CUSTOMER", waitingOn: "customer" },
  pickup_site: { channel: "site_email", category: "pickup_site_coordination", waitingStatus: "WAITING_ON_SITE", waitingOn: "pickup site" },
  delivery_site: { channel: "site_email", category: "delivery_site_coordination", waitingStatus: "WAITING_ON_SITE", waitingOn: "delivery site" },
}

/** Fingerprint of what a draft depends on: the order status and every selected time window. */
function draftBasis(status: string, windows: { id: string; details: Record<string, unknown> }[]): string {
  const selected = windows.filter((row) => row.details.is_selected === true)
    .map((row) => [row.id, row.details.purpose, row.details.start_at, row.details.end_at, row.details.timezone])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return JSON.stringify({ status, selected })
}

const dayFormat = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" })
const timeFormat = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** "Thursday 22 October, 16:00–17:00" in the window's own time zone. */
export function formatWindow(start: string, end: string | null, zone: string | null): string {
  const timeZone = zone ?? "UTC"
  const day = (value: Date) => dayFormat(timeZone).format(value)
  const time = (value: Date) => timeFormat(timeZone).format(value)
  const from = new Date(start)
  const fromText = `${day(from)}, ${time(from)}`
  if (!end) return `${fromText} ${zoneName(from, timeZone)}`
  const to = new Date(end)
  return `${day(to) === day(from) ? `${fromText}–${time(to)}` : `${fromText} – ${day(to)}, ${time(to)}`} ${zoneName(to, timeZone)}`
}

/** The zone's short name ("CEST", "EET"), so a time never reads as if it were UTC. */
function zoneName(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? timeZone
}

/** "Thursday 22 October, around 16:00" for a single estimated moment. */
function formatEstimate(at: string, zone: string | null): string {
  const timeZone = zone ?? "UTC"
  const date = new Date(at)
  return `${dayFormat(timeZone).format(date)}, around ${timeFormat(timeZone).format(date)} ${zoneName(date, timeZone)}`
}

/** The endpoint record for the order's first pickup or final delivery. */
function endpointFor(bundle: Bundle, boundary: "PICKUP" | "DELIVERY"): RelatedRow | null {
  const candidates = rows(bundle, "order_endpoint_details").filter((row) => row.details.boundary === boundary)
  const point = boundary === "PICKUP" ? originPickupPoint(bundle) : finalDeliveryPoint(bundle)
  return candidates.find((row) => point && row.details.point_id === point.id) ?? candidates[0] ?? null
}

function siteRecipient(bundle: Bundle, type: "pickup_site" | "delivery_site"): Recipient | null {
  const endpoint = endpointFor(bundle, type === "pickup_site" ? "PICKUP" : "DELIVERY")
  const name = str(endpoint?.details.contact_name)
  if (!endpoint || !name) return null
  const siteId = str(endpoint.details.site_id)
  return {
    type, id: siteId ?? endpoint.id, actorType: siteId ? "site_contact" : "handoff_contact", name,
    role: str(endpoint.details.contact_role), handle: str(endpoint.details.contact_handle),
    confirmed: endpoint.details.contact_status === "CONFIRMED", endpointId: endpoint.id,
  }
}

/** Every possible recipient on the order. Null where no contact is on file. */
export function recipientsFor(bundle: Bundle): Record<RecipientType, Recipient | null> {
  return {
    customer: { type: "customer", id: bundle.customer.id, actorType: "customer", name: bundle.customer.name,
      role: null, handle: null, confirmed: true, endpointId: null },
    pickup_site: siteRecipient(bundle, "pickup_site"),
    delivery_site: siteRecipient(bundle, "delivery_site"),
  }
}

/** The latest driver-app ETA, when it is later than the planned delivery window. */
function laterEstimate(bundle: Bundle, plannedEnd: string | null): RelatedRow | null {
  const eta = readAppPositions(bundle).find((row) => str(row.details.estimated_delivery_at))
  const at = str(eta?.details.estimated_delivery_at)
  if (!eta || !at || !plannedEnd) return null
  return Date.parse(at) > Date.parse(plannedEnd) ? eta : null
}

export async function draftEmail(orderId: string, templateId: TemplateId, recipientType?: RecipientType): Promise<EmailDraft | null> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  const { order, items, bundle } = loaded
  const template = TEMPLATES[templateId]
  const type = recipientType ?? template.recipients[0]
  if (!template.recipients.includes(type)) throw new CustomerEmailError(`${template.label} can't be sent to this recipient.`, 400)
  const recipient = recipientsFor(bundle)[type]
  if (!recipient) throw new CustomerEmailError("No contact on file for this recipient.", 409)

  const at = bundle.snapshotAt
  const fromData = (value: string | null | undefined, source: string, sourceLabel: string): DraftField => value
    ? { value, source, sourceLabel, at, filledBy: "data" }
    : { value: "", source: null, sourceLabel: null, at: null, filledBy: "empty" }
  const windowField = (window: WindowView | null, purpose: string, sourceLabel: string): DraftField => {
    if (!window) return fromData(null, "", "")
    const row = rows(bundle, "time_windows").find((candidate) =>
      candidate.details.purpose === purpose && candidate.details.is_selected === true && candidate.details.start_at === window.start)
    return fromData(formatWindow(window.start, window.end, window.zone), `time_windows.${row?.id ?? purpose}`, sourceLabel)
  }

  const primary = items.find(({ item }) => item.role === "PRIMARY") ?? items[0]
  const windows = chosenWindows(bundle)
  const final = finalDeliveryPoint(bundle)
  const deliverySlot = windowViews(bundle).find((window) => window.purpose === "SELECTED_DELIVERY_SLOT" && window.selected
    && (!final || window.pointId === final.id)) ?? null
  const plannedArrival = deliverySlot
    ? windowField(deliverySlot, "SELECTED_DELIVERY_SLOT", "the selected delivery slot")
    : windowField(windows.promise, "CUSTOMER_DELIVERY_PROMISE", "the delivery promise")
  // A later driver-app ETA is the only new time the records know. Without one, a person fills it in.
  const eta = laterEstimate(bundle, (deliverySlot ?? windows.promise)?.end ?? null)
  const estimate = eta ? fromData(formatEstimate(String(eta.details.estimated_delivery_at), (deliverySlot ?? windows.promise)?.zone ?? null),
    `tracking_observations.${eta.id}`, "the latest driver-app estimate") : fromData(null, "", "")
  const contactSource = recipient.endpointId ? `order_endpoint_details.${recipient.endpointId}` : ""
  const contactLabel = type === "pickup_site" ? "the pickup site details" : "the delivery site details"

  const available: Record<string, DraftField> = {
    customer: fromData(recipient.type === "customer" ? recipient.name : null, `customers.${order.customerId}`, "the customer record"),
    contact: fromData(recipient.type === "customer" ? null : recipient.name, contactSource, contactLabel),
    reference: fromData(order.reference, `orders.${order.id}`, "the order"),
    car: fromData(primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : null, `vehicles.${primary?.vehicle.id}`, "the vehicle record"),
    oldDelivery: windowField(windows.promise, "CUSTOMER_DELIVERY_PROMISE", "the delivery promise"),
    delivery: windowField(windows.promise, "CUSTOMER_DELIVERY_PROMISE", "the delivery promise"),
    oldSlot: windowField(windows.pickupSlot, "SELECTED_PICKUP_SLOT", "the selected pickup slot"),
    pickupSlot: windowField(windows.pickupSlot, "SELECTED_PICKUP_SLOT", "the selected pickup slot"),
    oldArrival: plannedArrival,
    newDelivery: estimate,
    newArrival: estimate,
  }
  // A status update asked for in an operator's note says exactly what the note asks for.
  const request = templateId === "status_update" ? updateRequestFor(bundle) : null
  if (request) {
    available.update = { value: request.content, source: `messages.${request.messageId}`,
      sourceLabel: `the internal note at ${new Date(request.at).toISOString().slice(11, 16)} from ${request.author}`, at: request.at, filledBy: "data" }
  }
  // reason, newSlot, update and question are only known to a person or the agent.
  const fields = Object.fromEntries(template.fields.map((name) => [name, available[name] ?? fromData(null, "", "")]))
  const rendered = render(templateId, Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value])))
  const replyTo = await emailThread(db, orderId, type)

  return {
    orderId: order.id,
    reference: order.reference,
    templateId,
    recipient,
    fields,
    ...rendered,
    replyToConversationId: replyTo?.id ?? null,
    draftBuiltAt: new Date().toISOString(),
    basis: draftBasis(order.status, rows(bundle, "time_windows")),
  }
}

/** Latest email thread with this recipient on the order. A customer thread may also be linked from another order. */
async function emailThread(tx: Pick<typeof db, "select">, orderId: string, type: RecipientType) {
  const [thread] = await tx.select().from(conversations).where(type === "customer"
    ? and(eq(conversations.channel, THREADS.customer.channel),
      or(eq(conversations.orderId, orderId), sql`${conversations.details} -> 'related_order_ids' @> ${JSON.stringify([orderId])}::jsonb`))
    : and(eq(conversations.channel, THREADS[type].channel), eq(conversations.orderId, orderId),
      sql`${conversations.details} ->> 'recipient_type' = ${type}`),
  ).orderBy(desc(conversations.updatedAt)).limit(1)
  return thread ?? null
}

export type SendInput = {
  templateId: TemplateId
  recipientType: RecipientType
  subject: string
  body: string
  fields: Record<string, string>
  draftBuiltAt: string
  basis: string
}

export async function sendSimulatedEmail(orderId: string, input: SendInput) {
  // 1. The draft must still describe the order as it is now.
  const fresh = await draftEmail(orderId, input.templateId, input.recipientType)
  if (!fresh) throw new CustomerEmailError("Order not found.", 404)
  if (input.basis !== fresh.basis) throw new CustomerEmailError(ORDER_CHANGED, 409)

  // 2. Every required field filled, no placeholder left, and the fixed sentence intact.
  const template = TEMPLATES[input.templateId]
  const empty = emptyRequired(input.templateId, input.fields)
  if (empty.length) throw new CustomerEmailError(`Fill in every field before sending. Empty: ${empty.join(", ")}.`, 400)
  if (!input.subject.trim() || !input.body.trim()) throw new CustomerEmailError("The subject and the body cannot be empty.", 400)
  const leftover = [...`${input.subject}\n${input.body}`.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
  if (leftover.length) throw new CustomerEmailError(`The email still contains placeholders: ${leftover.map((name) => `{${name}}`).join(", ")}.`, 400)
  if (template.closing && !input.body.replace(/\s+/g, " ").trim().endsWith(template.closing)) {
    throw new CustomerEmailError(`The email must end with the fixed sentence: "${template.closing}"`, 400)
  }

  const recipient = fresh.recipient
  const thread = THREADS[recipient.type]
  const editedFields = template.fields.filter((name) =>
    fresh.fields[name]?.filledBy === "data" && (input.fields[name] ?? "").trim() !== fresh.fields[name].value)
  const fields = Object.fromEntries(template.fields.map((name) => [name, (input.fields[name] ?? "").trim()]))
  const rendered = render(input.templateId, fields)

  // 3. One transaction: thread, message, event. The order row is locked to
  // serialise sends and re-read to catch a status change since step 1; it is never written.
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new CustomerEmailError("Order not found.", 404)
    if (order.status !== JSON.parse(fresh.basis).status) throw new CustomerEmailError(ORDER_CHANGED, 409)

    const now = await nextActionTime(tx)
    const at = now.toISOString()
    const existing = await emailThread(tx, orderId, recipient.type)
    const conversationId = existing?.id ?? `conv-${randomUUID()}`
    // Only an email that asks something makes us wait; one that informs leaves nobody waiting.
    const { waiting_on: _previousWaitingOn, ...previousDetails } = (existing?.details ?? {}) as Record<string, unknown>
    const threadStatus = template.expectsReply ? thread.waitingStatus : INFORMED
    const threadDetails = {
      ...(existing ? previousDetails : {
        id: conversationId, channel: thread.channel, category: thread.category, order_id: orderId, started_at: at,
        counterparty_id: recipient.id, counterparty_type: recipient.actorType, counterparty_name_snapshot: recipient.name,
        recipient_type: recipient.type, simulated: true,
      }),
      status: threadStatus, updated_at: at, ...(template.expectsReply ? { waiting_on: thread.waitingOn } : {}),
    }
    if (existing) {
      await tx.update(conversations).set({ status: threadStatus, updatedAt: now, details: threadDetails })
        .where(eq(conversations.id, conversationId))
    } else {
      await tx.insert(conversations).values({ id: conversationId, orderId, category: thread.category,
        channel: thread.channel, status: threadStatus, updatedAt: now, details: threadDetails })
    }

    const messageId = `msg-${randomUUID()}`
    await tx.insert(messages).values({ id: messageId, orderId, conversationId, authorType: "operator", body: input.body,
      authoredAt: now, details: {
        id: messageId, body: input.body, channel: thread.channel, language: "en", order_id: orderId,
        author_id: OPERATOR_ID, author_type: "operator", visibility: "PUBLIC", authored_at: at,
        recipient_id: recipient.id, recipient_type: recipient.actorType, recipient_name_snapshot: recipient.name,
        email_recipient_type: recipient.type, recipient_contact_confirmed: recipient.confirmed, conversation_id: conversationId,
        simulated: true, status: "sent (simulated)", template: input.templateId, subject: input.subject, fields,
        edited_fields: editedFields, body_edited: input.body !== rendered.body, subject_edited: input.subject !== rendered.subject,
        draft_built_at: input.draftBuiltAt,
      } })

    const eventId = `evt-${randomUUID()}`
    await tx.insert(operationalEvents).values({ id: eventId, orderId, command: "customer_email.sent_simulated",
      targetType: "conversation", targetId: conversationId, recordedAt: now, details: {
        actor_type: "operator", actor_id: OPERATOR_ID, source: "control_room_customer_email", simulated: true,
        recipient_type: recipient.type,
        changes: { message_id: messageId, conversation_id: conversationId, template: input.templateId, edited_fields: editedFields },
      } })

    return { success: true, simulated: true, status: "sent (simulated)", conversationId, messageId, eventId,
      conversationStatus: threadStatus, expectsReply: template.expectsReply, sentAt: at }
  })
}

export type ReplyAnswer = "agree" | "decline"
/** A reply is an agreement, a refusal, or anything else the person wrote ("other"). */
export type ReplyKind = ReplyAnswer | "other"

export const SIMULATED_REPLIES: Record<"customer" | "site", Record<ReplyAnswer, string>> = {
  customer: { agree: "Agreed, go ahead with the new time.", decline: "That doesn't work for us, please call me." },
  site: { agree: "Yes, that works.", decline: "No, we can't do that time." },
}

const replyText = (type: RecipientType, answer: ReplyAnswer) => SIMULATED_REPLIES[type === "customer" ? "customer" : "site"][answer]

export type ReplyRecorded = { orderId: string; recipientType: RecipientType | "driver"; answer: ReplyKind; messageId: string; conversationId: string; at: Date }

/**
 * Records a simulated answer from the recipient on the thread waiting for it. The order itself is not changed here.
 * `afterReply` runs in the same transaction, so whatever it ends is ended together with the reply or not at all.
 */
export async function recordSimulatedReply(orderId: string, type: RecipientType, answer: ReplyKind,
  afterReply?: (tx: Tx, reply: ReplyRecorded) => Promise<unknown>, text?: string, source?: "scripted" | "operator") {
  const body = text?.trim() || (answer === "other" ? "" : replyText(type, answer))
  if (!body) throw new CustomerEmailError("Write the reply before recording it.", 400)
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new CustomerEmailError("Order not found.", 404)
    const thread = await emailThread(tx, orderId, type)
    // A reply can answer an email we are waiting on, or come in anyway after one that only informed.
    if (!thread || (thread.status !== THREADS[type].waitingStatus && thread.status !== INFORMED)) {
      throw new CustomerEmailError("No email on this order is waiting for a reply from this recipient.", 409)
    }
    const latest = await latestSend(tx, thread.id)
    const sent = latest?.sent.details ?? {}
    const now = await nextActionTime(tx)
    const at = now.toISOString()
    const messageId = `msg-${randomUUID()}`
    await tx.insert(messages).values({ id: messageId, orderId, conversationId: thread.id, authorType: String(sent.recipient_type ?? "customer"), body,
      authoredAt: now, details: {
        id: messageId, body, channel: thread.channel, language: "en", order_id: orderId,
        author_id: sent.recipient_id ?? null, author_type: sent.recipient_type ?? "customer", author_name_snapshot: sent.recipient_name_snapshot ?? null,
        visibility: "PUBLIC", authored_at: at, recipient_id: OPERATOR_ID, recipient_type: "operator", conversation_id: thread.id,
        email_recipient_type: type, simulated: true, answer, reply_source: source ?? (text?.trim() ? "operator" : "scripted"),
      } })
    // The recipient answered, so nobody is waiting on them any more; the thread is open for the operator.
    const { waiting_on: _waitingOn, ...rest } = thread.details
    await tx.update(conversations).set({ status: "OPEN", updatedAt: now,
      details: { ...rest, status: "OPEN", updated_at: at, last_answer: answer } }).where(eq(conversations.id, thread.id))
    const eventId = `evt-${randomUUID()}`
    await tx.insert(operationalEvents).values({ id: eventId, orderId, command: "customer_email.reply_simulated",
      targetType: "conversation", targetId: thread.id, recordedAt: now, details: {
        actor_type: sent.recipient_type ?? "customer", actor_id: sent.recipient_id ?? null, source: "control_room_customer_email",
        simulated: true, simulated_by: "operator", recipient_type: type,
        changes: { message_id: messageId, conversation_id: thread.id, answer },
      } })
    const followUp = afterReply
      ? await afterReply(tx, { orderId, recipientType: type, answer, messageId, conversationId: thread.id, at: now }) : null
    return { success: true, simulated: true, conversationId: thread.id, messageId, eventId, answer, conversationStatus: "OPEN", followUp }
  })
}

export const SLOT_CHANGE_COMMAND = "order.slot_change_simulated"

/** The change a template proposes: which sent field holds the old time and which the new one. */
const PROPOSED_CHANGES: Partial<Record<TemplateId, { kind: "pickup" | "delivery" | "arrival"; from: string; to: string }>> = {
  pickup_change: { kind: "pickup", from: "oldSlot", to: "newSlot" },
  delivery_delay: { kind: "delivery", from: "oldDelivery", to: "newDelivery" },
  site_pickup_time: { kind: "pickup", from: "oldSlot", to: "newSlot" },
  site_arrival_time: { kind: "arrival", from: "oldArrival", to: "newArrival" },
}

export type EmailStage = "waiting" | "informed" | "agreed" | "applied" | "done" | "declined" | "replied"

export type EmailCase = {
  conversationId: string
  recipientType: RecipientType
  recipientName: string
  templateId: TemplateId
  templateLabel: string
  sentAt: string
  stage: EmailStage
  reply: { answer: ReplyKind; body: string; at: string; source: string | null } | null
  /** What an agreement would change. Null for templates that propose nothing. */
  change: { kind: "pickup" | "delivery" | "arrival"; from: string; to: string } | null
  applied: { at: string } | null
  calls: { note: string; at: string }[]
}

const iso = (value: Date) => value.toISOString()
const text = (value: unknown) => typeof value === "string" ? value : ""

function isSentTemplate(value: unknown): value is TemplateId {
  return typeof value === "string" && value in TEMPLATES
}

/** The newest simulated send on the thread, with everything stored after it. */
async function latestSend(tx: Pick<typeof db, "select">, threadId: string) {
  const threadMessages = await tx.select().from(messages).where(eq(messages.conversationId, threadId))
    .orderBy(asc(messages.authoredAt), asc(messages.id))
  const index = threadMessages.findLastIndex((message) => message.authorType === "operator"
    && message.details.simulated === true && isSentTemplate(message.details.template))
  return index < 0 ? null : { sent: threadMessages[index], after: threadMessages.slice(index + 1) }
}

async function appliedEventFor(tx: Pick<typeof db, "select">, orderId: string, messageId: string) {
  const [event] = await tx.select().from(operationalEvents).where(and(
    eq(operationalEvents.orderId, orderId), eq(operationalEvents.command, SLOT_CHANGE_COMMAND),
    sql`${operationalEvents.details} -> 'changes' ->> 'message_id' = ${messageId}`,
  )).limit(1)
  return event ?? null
}

/** The thread to use for one recipient, from all email threads on or linked to the order (newest first). */
export function threadFor<T extends { channel: string; orderId: string; updatedAt: Date; details: Record<string, unknown> }>(
  threads: T[], orderId: string, type: RecipientType,
): T | null {
  return threads.filter((thread) => type === "customer"
    ? thread.channel === THREADS.customer.channel
    : thread.channel === THREADS[type].channel && thread.orderId === orderId && thread.details.recipient_type === type)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null
}

type MessageRecord = typeof messages.$inferSelect

/**
 * The latest simulated email on one thread and what happened after it. Pure: the caller
 * passes the thread's messages (oldest first) and how to find a recorded change for a sent message.
 */
export function buildEmailCase(threadId: string, type: RecipientType, threadMessages: MessageRecord[],
  appliedAt: (sentMessageId: string) => Date | null): EmailCase | null {
  const index = threadMessages.findLastIndex((message) => message.authorType === "operator"
    && message.details.simulated === true && isSentTemplate(message.details.template))
  if (index < 0) return null
  const sent = threadMessages[index]
  const after = threadMessages.slice(index + 1)
  const templateId = sent.details.template as TemplateId
  const replyMessage = after.find((message) => message.authorType !== "operator"
    && (message.details.answer === "agree" || message.details.answer === "decline" || message.details.answer === "other"))
  const fields = (sent.details.fields ?? {}) as Record<string, unknown>
  const proposal = PROPOSED_CHANGES[templateId]
  const change = proposal ? { kind: proposal.kind, from: text(fields[proposal.from]), to: text(fields[proposal.to]) } : null
  const applied = appliedAt(sent.id)
  const appliedEvent = applied ? { recordedAt: applied } : null
  const thread = { id: threadId }
  const reply = replyMessage
    ? { answer: replyMessage.details.answer as ReplyKind, body: replyMessage.body, at: iso(replyMessage.authoredAt),
      source: typeof replyMessage.details.reply_source === "string" ? replyMessage.details.reply_source : null } : null
  const stage: EmailStage = !reply ? (TEMPLATES[templateId].expectsReply ? "waiting" : "informed") : reply.answer === "decline" ? "declined" : reply.answer === "other" ? "replied"
    : !change ? "done" : appliedEvent ? "applied" : "agreed"
  return {
    conversationId: thread.id,
    recipientType: type,
    recipientName: text(sent.details.recipient_name_snapshot) || text(fields.customer) || text(fields.contact) || "the recipient",
    templateId,
    templateLabel: TEMPLATES[templateId].label,
    sentAt: iso(sent.authoredAt),
    stage,
    reply,
    change,
    applied: appliedEvent ? { at: iso(appliedEvent.recordedAt) } : null,
    calls: after.filter((message) => message.details.call_note === true).map((message) => ({ note: message.body, at: iso(message.authoredAt) })),
  }
}

/** The latest simulated email to one recipient, read only from stored records. */
async function emailCaseFor(orderId: string, type: RecipientType): Promise<EmailCase | null> {
  const thread = await emailThread(db, orderId, type)
  if (!thread) return null
  const threadMessages = await db.select().from(messages).where(eq(messages.conversationId, thread.id))
    .orderBy(asc(messages.authoredAt), asc(messages.id))
  const applied = await db.select({ at: operationalEvents.recordedAt, messageId: sql<string>`${operationalEvents.details} -> 'changes' ->> 'message_id'` })
    .from(operationalEvents).where(and(eq(operationalEvents.orderId, orderId), eq(operationalEvents.command, SLOT_CHANGE_COMMAND)))
  return buildEmailCase(thread.id, type, threadMessages, (id) => applied.find((entry) => entry.messageId === id)?.at ?? null)
}

/** "Pickup moved to Thursday 22 October, 16:00–17:00, customer agreed 09:04 (simulated)". */
export function appliedNote(emailCase: EmailCase): string | null {
  if (emailCase.stage !== "applied" || !emailCase.change || !emailCase.reply) return null
  const who = emailCase.recipientType === "customer" ? "customer" : RECIPIENT_LABELS[emailCase.recipientType].toLowerCase()
  const time = new Date(emailCase.reply.at).toISOString().slice(11, 16)
  const kind = emailCase.change.kind.charAt(0).toUpperCase() + emailCase.change.kind.slice(1)
  return `${kind} moved to ${emailCase.change.to}, ${who} agreed ${time} (simulated)`
}

/** Signals that mean the customer's delivery may slip. Invoices, proof reviews and condition claims are not here. */
const DELAY_SIGNALS = new Set(["DELIVERY_PROMISE_UNACHIEVABLE", "FERRY_SOLD_OUT", "FERRY_CONNECTION_RISK", "POSITIONING_AT_RISK",
  "DRIVER_AVAILABILITY_RISK", "EMPTY_PICKUP", "SAFETY_STOP", "SITE_ACCESS_UNCONFIRMED", "SITE_ACCESS_CONFLICT",
  "DELIVERY_ACCESS_RISK", "RELEASE_DOCUMENT_UNCLEAR", "TRACKING_GAP"])

const RULE_REASONS: Record<Rule, string> = {
  safety_stop: "A safety stop or vehicle warning is open",
  ferry_cutoff: "The ferry check-in is at risk",
  travel_sold_out: "The driver's travel is sold out",
  positioning_risk: "The driver may not reach the next pickup in time",
  tracking_missing: "No tracking since the pickup",
  tracking_stale: "Tracking is out of date",
  eta_vs_promise: "The arrival estimate is close to or past the promise",
  progress_plateau: "The car has stopped making progress",
  tracking_fresh: "Tracking",
  other_desk: "Handled by another desk",
}

/**
 * Possible delay: a risk, the promise may still hold → delay_notice (informs, no reply needed).
 * Confirmed delay: the records show the promise will be missed → delivery_delay (asks the customer
 * to agree a new window). Decided from data only; the person can switch before sending.
 */
export type DelayKind = "possible" | "confirmed" | "site" | "note"
export type DelayHint = {
  /** "site": a pickup- or delivery-side problem, so the site is asked first, not the customer. */
  kind: DelayKind
  recipient: RecipientType
  templateId: TemplateId
  /** Why this suggestion, in one plain sentence: "ETA is 10 min inside the promise". */
  because: string
  /** Every delay signal seen, for the details line. */
  reasons: string[]
}

/** Words drivers and sites use to say they will be late (English, German, French). */
const LATE_WORDS = /\b(?:(?:will|we'll|i'll) be late|running late|(?:won't|will not|cannot|can't) make (?:it|the (?:slot|window|delivery))|miss(?:ing)? the (?:slot|window|promise|delivery)|after the (?:slot|window|promise)|later than (?:planned|promised)|verspät\w*|komme später|en retard|dépasserai|dépasser le créneau)\b/i

function clock(at: string, zone: string | null): string {
  const timeZone = zone ?? "UTC"
  return `${new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(at)).replace(",", "")}${timeZone === "UTC" ? "" : ` ${zoneName(new Date(at), timeZone)}`}`
}

function minutesText(minutes: number): string {
  const value = Math.round(Math.abs(minutes))
  return value >= 120 ? `${Math.round(value / 60)} h` : `${value} min`
}

/** Whether the customer may need to hear about a delay, and which email fits. A hint only: nothing is drafted or sent from it. */
/**
 * An operator's note asking for a customer update ("prepare a buyer update that says …").
 * The update's content is taken from the note itself, word for word; nothing is added.
 */
export type UpdateRequest = { messageId: string; at: string; author: string; content: string; note: string }

const UPDATE_REQUEST = /prepare (?:a |an )?(?:buyer|customer) update (?:that says|saying|stating) (.+?)(?:,|\.|;|$)/i

export function updateRequestFor(bundle: Bundle): UpdateRequest | null {
  const note = [...bundle.messages].reverse().find((message) => message.authorType === "operator" && UPDATE_REQUEST.test(message.body))
  const content = note ? UPDATE_REQUEST.exec(note.body)?.[1]?.trim() : null
  if (!note || !content) return null
  const author = bundle.dir.title(note.details.author_id) ?? "an operator"
  return { messageId: note.id, at: note.authoredAt, author, content: `${content.charAt(0).toUpperCase()}${content.slice(1)}.`, note: note.body }
}

function noteHint(bundle: Bundle, reasons: string[]): DelayHint | null {
  const request = updateRequestFor(bundle)
  if (!request) return null
  const time = new Date(request.at).toISOString().slice(11, 16)
  return { kind: "note", recipient: "customer", templateId: "status_update", reasons,
    because: `the internal note at ${time} from ${request.author} asks for a buyer update: “${request.note.length > 160 ? `${request.note.slice(0, 159)}…` : request.note}”` }
}

/** Problems at the pickup end: the pickup site is asked first. */
// Driver positioning and availability are not here: their first answers are internal (another driver,
// driver travel); the pickup site is asked only after the operator chooses to move the pickup time.
const PICKUP_SIDE: Record<string, TemplateId> = {
  EMPTY_PICKUP: "site_readiness",
  RELEASE_DOCUMENT_UNCLEAR: "site_readiness", SITE_ACCESS_UNCONFIRMED: "site_access", SITE_ACCESS_CONFLICT: "site_access",
}
/** Signals that put the delivery promise itself at risk. Tracking gaps alone do not: they hide the car, not delay it. */
const PROMISE_SIGNALS = new Set(["FERRY_SOLD_OUT", "FERRY_CONNECTION_RISK", "SAFETY_STOP"])
const PROMISE_RULES = new Set<Rule>(["eta_vs_promise", "safety_stop", "ferry_cutoff", "travel_sold_out"])
const TRAVEL_SIGNALS = new Set(["FERRY_SOLD_OUT", "FERRY_CONNECTION_RISK"])
const TRAVEL_RULES = new Set<Rule>(["ferry_cutoff", "travel_sold_out"])

function delayHint(bundle: Bundle, options: CostOptions | null, recipients: Record<RecipientType, Recipient | null>): DelayHint | null {
  if (["DELIVERED", "CANCELLED"].includes(bundle.order.status.toUpperCase())) return null
  const reasons = new Set<string>()
  for (const alert of bundle.alerts) {
    if ((alert.status === "OPEN" || alert.status === "ACKNOWLEDGED") && DELAY_SIGNALS.has(alert.signal)) reasons.add(label(alert.signal))
  }
  const checks = evaluateTriage(bundle).checks
  for (const check of checks) if (check.outcome === "fail") reasons.add(RULE_REASONS[check.rule])

  const promise = chosenWindows(bundle).promise
  const promiseEnd = promise?.end ? Date.parse(promise.end) : null
  const zone = promise?.zone ?? null
  // 1. Confirmed: the latest valid app ETA is after the promise end.
  const eta = readAppPositions(bundle).find((row) => str(row.details.estimated_delivery_at))
  const etaAt = str(eta?.details.estimated_delivery_at)
  if (etaAt && promiseEnd !== null && Date.parse(etaAt) > promiseEnd) {
    return { kind: "confirmed", recipient: "customer", templateId: "delivery_delay", reasons: [...reasons],
      because: `the latest app ETA (${clock(etaAt, zone)}) is ${minutesText((Date.parse(etaAt) - promiseEnd) / 60_000)} after the delivery promise ends (${clock(promise!.end!, zone)})` }
  }
  // 2. Confirmed: booked travel arrives after the promise end, before the last road leg even starts.
  const booked = rows(bundle, "travel_reservations").find((row) => row.details.status === "BOOKED" && str(row.details.expected_arrival_at)
    && promiseEnd !== null && Date.parse(String(row.details.expected_arrival_at)) > promiseEnd)
  if (booked) {
    return { kind: "confirmed", recipient: "customer", templateId: "delivery_delay", reasons: [...reasons],
      because: `the booked ${label(str(booked.details.kind)).toLowerCase() || "travel"} arrives ${clock(String(booked.details.expected_arrival_at), zone)}, after the delivery promise ends (${clock(promise!.end!, zone)})` }
  }
  // 3. Confirmed: an open alert states the delivery promise cannot be met.
  const unachievable = bundle.alerts.find((alert) => (alert.status === "OPEN" || alert.status === "ACKNOWLEDGED")
    && alert.signal === "DELIVERY_PROMISE_UNACHIEVABLE")
  if (unachievable) {
    return { kind: "confirmed", recipient: "customer", templateId: "delivery_delay", reasons: [...reasons],
      because: `an open alert says the delivery promise cannot be met (${clock(unachievable.triggeredAt, zone)})` }
  }
  // 4. Confirmed: the driver or a site says it will be late.
  const late = [...bundle.messages].reverse().find((message) => ["driver", "site_contact", "handoff_contact"].includes(message.authorType)
    && LATE_WORDS.test(message.body))
  if (late) {
    const who = late.authorType === "driver" ? "the driver" : "the site"
    return { kind: "confirmed", recipient: "customer", templateId: "delivery_delay", reasons: [...reasons],
      because: `${who} wrote on ${clock(late.authoredAt, zone)} that it will be late: “${late.body.length > 90 ? `${late.body.slice(0, 89)}…` : late.body}”` }
  }
  if (!reasons.size) return noteHint(bundle, [])
  const active = bundle.alerts.filter((alert) => alert.status === "OPEN" || alert.status === "ACKNOWLEDGED")
  const failedRules = checks.filter((check) => check.outcome === "fail").map((check) => check.rule)
  // A quoted option that still meets the promise means the travel problem is a cost decision, not a customer delay.
  const travelHandled = !!options?.options.some((option) => option.meetsTarget === true && option.target?.label === "the promise ends")
  const promiseAtRisk = active.some((alert) => PROMISE_SIGNALS.has(alert.signal) && !(travelHandled && TRAVEL_SIGNALS.has(alert.signal)))
    || failedRules.some((rule) => PROMISE_RULES.has(rule) && !(travelHandled && TRAVEL_RULES.has(rule)))
  if (!promiseAtRisk) {
    // Not the customer's concern yet: ask the site where the problem is.
    const pickup = active.find((alert) => alert.signal in PICKUP_SIDE && alert.details.boundary !== "DELIVERY")
    const delivery = active.find((alert) => alert.signal === "DELIVERY_ACCESS_RISK"
      || (alert.signal.startsWith("SITE_ACCESS") && alert.details.boundary === "DELIVERY"))
    if (pickup) {
      return { kind: "site", recipient: "pickup_site", templateId: PICKUP_SIDE[pickup.signal], reasons: [...reasons],
        because: `the problem is at the pickup (${label(pickup.signal).toLowerCase()}); the delivery promise is not at risk yet${recipients.pickup_site ? "" : ". No pickup contact on file"}` }
    }
    if (delivery) {
      return { kind: "site", recipient: "delivery_site", templateId: "site_access", reasons: [...reasons],
        because: `the problem is at the delivery site (${label(delivery.signal).toLowerCase()})${recipients.delivery_site ? "" : ". No delivery contact on file"}` }
    }
    // Nothing to ask anyone yet; an operator may still have asked for a customer update.
    return noteHint(bundle, [...reasons])
  }
  // Possible: a risk only. Say the most telling one.
  const etaCheck = checks.find((check) => check.rule === "eta_vs_promise" && check.outcome === "fail")
  const margin = etaAt && promiseEnd !== null ? (promiseEnd - Date.parse(etaAt)) / 60_000 : null
  const because = etaCheck && margin !== null
    ? (Math.round(margin) === 0 ? "the ETA is exactly at the end of the promise, so it may still hold"
      : `the ETA is ${minutesText(margin)} inside the promise, so it may still hold`)
    : `of ${reasons.size === 1 ? "this signal" : "these signals"}: ${[...reasons].slice(0, 2).map((reason) => reason.charAt(0).toLowerCase() + reason.slice(1)).join("; ")}. The promise may still hold`
  return { kind: "possible", recipient: "customer", templateId: "delay_notice", reasons: [...reasons], because }
}

export type EmailOverview = {
  /** Who can be written to, null where no contact is on file. */
  recipients: Record<RecipientType, Recipient | null>
  /** The latest email per recipient, newest first. */
  cases: EmailCase[]
  delayHint: DelayHint | null
  /** Money decisions: the options the operator picks from. */
  costOptions: CostOptions | null
  /** The operator's latest pick, if any. */
  costDecision: CostDecision | null
}

export async function emailOverview(orderId: string): Promise<EmailOverview | null> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  const cases = (await Promise.all(RECIPIENT_TYPES.map((type) => emailCaseFor(orderId, type))))
    .filter((entry): entry is EmailCase => !!entry).sort((a, b) => b.sentAt.localeCompare(a.sentAt))
  const recipients = recipientsFor(loaded.bundle)
  const options = costOptions(loaded.bundle, await currentTime())
  return { recipients, cases, delayHint: delayHint(loaded.bundle, options, recipients), costOptions: options,
    costDecision: await latestCostDecision(orderId) }
}

/**
 * Records that the operator would now move the time as the recipient agreed.
 * Simulated: one event with the old and new values. time_windows and the order are not edited.
 */
export async function applySimulatedChange(orderId: string, type: RecipientType) {
  const current = await emailCaseFor(orderId, type)
  if (!current) throw new CustomerEmailError("There is no email to this recipient on this order.", 409)
  if (current.stage === "applied") throw new CustomerEmailError("This change is already recorded.", 409)
  if (current.stage !== "agreed" || !current.change) throw new CustomerEmailError("Only a change the recipient agreed to can be recorded.", 409)
  const change = current.change
  // The recipient agreed to move away from a specific time. If the order no longer shows it, stop.
  const fresh = await draftEmail(orderId, current.templateId, type)
  if (!fresh) throw new CustomerEmailError("Order not found.", 404)
  const window = fresh.fields[PROPOSED_CHANGES[current.templateId]!.from]
  if (window.value !== change.from) {
    throw new CustomerEmailError(`The order no longer shows the ${change.kind} as ${change.from}. Check the order before recording this change.`, 409)
  }
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new CustomerEmailError("Order not found.", 404)
    // Re-read under the lock: the same send, still agreed, not yet recorded.
    const thread = await emailThread(tx, orderId, type)
    const latest = thread ? await latestSend(tx, thread.id) : null
    if (!thread || !latest || thread.id !== current.conversationId || iso(latest.sent.authoredAt) !== current.sentAt) {
      throw new CustomerEmailError("The email changed while you were looking. Reload the order.", 409)
    }
    if (await appliedEventFor(tx, orderId, latest.sent.id)) throw new CustomerEmailError("This change is already recorded.", 409)
    const reply = latest.after.find((message) => message.authorType !== "operator" && message.details.answer === "agree")
    const now = await nextActionTime(tx)
    const eventId = `evt-${randomUUID()}`
    const windowId = window.source?.startsWith("time_windows.") ? window.source.slice("time_windows.".length) : null
    await tx.insert(operationalEvents).values({ id: eventId, orderId, command: SLOT_CHANGE_COMMAND,
      targetType: "time_window", targetId: windowId ?? orderId, recordedAt: now, details: {
        actor_type: "operator", actor_id: OPERATOR_ID, source: "control_room_customer_email", simulated: true,
        recipient_type: type,
        changes: { kind: change.kind, old_value: change.from, new_value: change.to, time_window_id: windowId,
          conversation_id: thread.id, message_id: latest.sent.id, reply_message_id: reply?.id ?? null },
      } })
    return { success: true, simulated: true, eventId, kind: change.kind, from: change.from, to: change.to, appliedAt: iso(now) }
  })
}

/** Saves the operator's note of a phone call as an internal note on the email thread with that recipient. */
export async function logPhoneCall(orderId: string, type: RecipientType, note: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new CustomerEmailError("Order not found.", 404)
    const thread = await emailThread(tx, orderId, type)
    if (!thread) throw new CustomerEmailError("There is no email to this recipient to attach the call to.", 409)
    const now = await nextActionTime(tx)
    const at = iso(now)
    const messageId = `msg-${randomUUID()}`
    await tx.insert(messages).values({ id: messageId, orderId, conversationId: thread.id, authorType: "operator", body: note,
      authoredAt: now, details: {
        id: messageId, body: note, channel: "internal_note", language: "en", order_id: orderId,
        author_id: OPERATOR_ID, author_type: "operator", visibility: "INTERNAL", authored_at: at,
        recipient_id: "ops-shift", recipient_type: "operator", conversation_id: thread.id,
        call_note: true, email_recipient_type: type, called_id: thread.details.counterparty_id ?? null,
      } })
    await tx.update(conversations).set({ updatedAt: now, details: { ...thread.details, updated_at: at } }).where(eq(conversations.id, thread.id))
    const eventId = `evt-${randomUUID()}`
    await tx.insert(operationalEvents).values({ id: eventId, orderId, command: "customer_email.call_logged",
      targetType: "conversation", targetId: thread.id, recordedAt: now, details: {
        actor_type: "operator", actor_id: OPERATOR_ID, source: "control_room_customer_email", recipient_type: type,
        changes: { message_id: messageId, conversation_id: thread.id },
      } })
    return { success: true, messageId, eventId, loggedAt: at }
  })
}

export const COST_DECISION_COMMAND = "operator.cost_option_chosen"

/** What to send after the pick: nothing, a confirmed delay to the customer, or a new handover time to the pickup site. */
export type CostSuggestion = "none" | "delivery_delay" | "site_pickup_time"
export type CostDecision = { at: string; optionId: string; what: string; costText: string; arrivalText: string
  meetsPromise: boolean | null; reason: string; suggestion: CostSuggestion }

function suggestionFor(option: { kind: string; meetsTarget: boolean | null; target: { label: string } | null }): CostSuggestion {
  if (option.kind === "move_pickup") return "site_pickup_time"
  if (option.meetsTarget !== false) return "none"
  // Late driver travel moves the pickup; a late car crossing misses the delivery promise.
  return option.target?.label === "the pickup slot starts" ? "site_pickup_time" : "delivery_delay"
}

async function latestCostDecision(orderId: string): Promise<CostDecision | null> {
  const [event] = await db.select().from(operationalEvents).where(and(eq(operationalEvents.orderId, orderId),
    eq(operationalEvents.command, COST_DECISION_COMMAND))).orderBy(desc(operationalEvents.recordedAt)).limit(1)
  if (!event) return null
  const c = (event.details.changes ?? {}) as Record<string, unknown>
  return { at: event.recordedAt.toISOString(), optionId: String(c.option_id ?? ""), what: String(c.what ?? ""), costText: String(c.cost_text ?? ""),
    arrivalText: String(c.arrival_text ?? ""), meetsPromise: typeof c.meets_target === "boolean" ? c.meets_target : null,
    reason: String(c.reason ?? ""),
    suggestion: c.suggestion === "site_pickup_time" || c.suggestion === "delivery_delay" ? c.suggestion : c.meets_target === false ? "delivery_delay" : "none" }
}

/**
 * Stores the operator's pick of a cost option. The option is re-read from the current quotes, so only an
 * option the data still offers can be picked. Nothing is booked: this records a decision, not a purchase.
 */
export async function chooseCostOption(orderId: string, optionId: string, reason: string) {
  const loaded = await loadOrder(orderId)
  if (!loaded) throw new CustomerEmailError("Order not found.", 404)
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new CustomerEmailError("Order not found.", 404)
    const options = costOptions(loaded.bundle, await currentTime(tx))
    const option = options?.options.find((entry) => entry.id === optionId)
    if (!options || !option) throw new CustomerEmailError("That option is no longer available. Reload the order.", 409)
    const now = await nextActionTime(tx)
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: COST_DECISION_COMMAND,
      targetType: "travel_option", targetId: option.id, recordedAt: now, details: {
        actor_type: "operator", actor_id: OPERATOR_ID, source: "control_room_cost_decision", simulated: true,
        changes: { option_id: option.id, labels: option.labels, what: option.what, cost_cents: option.costCents, currency: option.currency,
          cost_text: option.costText, arrival_text: option.arrivalText, meets_target: option.meetsTarget, customer_must_agree: option.customerMustAgree,
          recommended: options.recommendation?.optionId === option.id, reason, booked: false, kind: option.kind, suggestion: suggestionFor(option) },
      } })
    return { success: true, at: now.toISOString(), meetsPromise: option.meetsTarget, suggestion: suggestionFor(option) }
  })
}
