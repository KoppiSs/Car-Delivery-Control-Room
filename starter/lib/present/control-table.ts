// Where each order sits in the control table, derived only from stored records:
// triage, the agent proposal columns, agent_mock_actions, email threads and their
// messages, simulated change events and "reply seen" events. Time is the shared
// business clock (lib/clock.ts), never the computer's clock, so every viewer sees
// the same table and it survives a refresh.

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { NOW } from "../case"
import { currentTime } from "../clock"
import { SLOT_CHANGE_COMMAND, appliedNote, buildEmailCase, threadFor, type EmailCase } from "../customer-email"
import { db } from "../db"
import { agentMockActions, conversations, messages, operationalEvents, orders } from "../schema"
import { RECIPIENT_TYPES, TEMPLATES } from "../templates"
import { evaluateTriage, type TriageAssessment } from "../triage"
import { chosenWindows } from "./attention"
import { buildBoardCard } from "./board"
import type { Bundle } from "./bundle"
import { loadBoardBundles, loadOrder } from "./load"
import { readingFor } from "./statements"
import { followUpRecipient } from "../follow-up-reply"
import { namesFor, partiesFor, withNames } from "./names"

/** When a request we are waiting on goes back to "Needs a decision" as "No reply yet". */
export const WAITING_LIMITS = {
  /** The related deadline is closer than this... */
  deadlineWithinHours: 2,
  /**
   * ...and we have already waited at least this long. Without it, asking about an order whose
   * deadline is already close would bounce straight back as "No reply yet" before anyone could answer.
   */
  minimumWaitMinutes: 30,
  /** We have waited longer than this. */
  waitedMoreThanHours: 4,
  /** Shown in the section header as "close to their deadline". */
  closeWithinHours: 6,
}

export const REPLY_SEEN_COMMAND = "control_room.reply_seen"
const EMAIL_CHANNELS = ["customer_email", "site_email"]
const REPLY_AUTHORS = ["customer", "site_contact", "handoff_contact", "driver"]
const HOUR = 3_600_000

/** At most one box per order. Manual control beats Pending, which beats Needs a review. */
export type ControlSection = "review" | "pending" | "manual"
export type Urgency = "Now" | "Today" | "Later"
export type ControlFlag = { kind: "new_reply" | "no_reply" | "agreed" | "declined" | "replied"; text: string; at: string | null }
export type ControlWaiting = { who: string; about: string; since: string; needBy: { at: string; label: string } | null }

export type ControlRow = {
  id: string
  reference: string
  vehicle: string
  from: string
  to: string
  customer: string
  section: ControlSection
  priority: number
  urgency: Urgency
  deadline: { at: string; label: string } | null
  firstSeenAt: string | null
  /** One line on the situation, with its kind so the UI can label it. */
  line: { kind: "reading" | "status"; text: string }
  /** The agent's suggestion for a review row; null means "No suggestion yet". */
  suggestion: string | null
  flag: ControlFlag | null
  waiting: ControlWaiting | null
}

/** Where an order stands, also for orders that are not in the table. */
export type ControlState = { row: ControlRow | null; note: string }

export const SECTION_LABELS: Record<ControlSection, string> = {
  review: "Needs a review", pending: "Pending", manual: "Manual control",
}

export function urgencyOf(priority: number): Urgency {
  return priority >= 80 ? "Now" : priority >= 50 ? "Today" : "Later"
}

const iso = (value: Date) => value.toISOString()
const short = (text: string, max = 90) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

type Supplement = {
  threads: (typeof conversations.$inferSelect)[]
  threadMessages: Map<string, (typeof messages.$inferSelect)[]>
  applied: { messageId: string; at: Date }[]
  seen: Map<string, Date>
  /** When manual control last ended; anything we were waiting for before that is closed. */
  manualEnded: Map<string, { at: Date; choice: string | null; note: string | null }>
  mock: Map<string, typeof agentMockActions.$inferSelect>
}

/** Email threads, mock actions and seen markers for these orders, in a handful of queries. */
async function loadSupplement(orderIds: string[]): Promise<Supplement> {
  const ids = orderIds.length ? orderIds : ["-"]
  const related = sql`exists (select 1 from jsonb_array_elements_text(coalesce(${conversations.details} -> 'related_order_ids', '[]'::jsonb)) as linked(id) where linked.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`
  const threads = await db.select().from(conversations).where(and(inArray(conversations.channel, EMAIL_CHANNELS),
    sql`(${inArray(conversations.orderId, ids)} or ${related})`))
  const threadIds = threads.map((thread) => thread.id)
  const [threadMessageRows, applied, seen, mocks, manualEnded] = await Promise.all([
    threadIds.length ? db.select().from(messages).where(inArray(messages.conversationId, threadIds)) : Promise.resolve([]),
    db.select({ at: operationalEvents.recordedAt, messageId: sql<string>`${operationalEvents.details} -> 'changes' ->> 'message_id'` })
      .from(operationalEvents).where(and(eq(operationalEvents.command, SLOT_CHANGE_COMMAND), inArray(operationalEvents.orderId, ids))),
    db.select({ orderId: operationalEvents.orderId, at: sql<Date>`max(${operationalEvents.recordedAt})` }).from(operationalEvents)
      .where(and(eq(operationalEvents.command, REPLY_SEEN_COMMAND), inArray(operationalEvents.orderId, ids))).groupBy(operationalEvents.orderId),
    db.select().from(agentMockActions).where(inArray(agentMockActions.orderId, ids)).orderBy(desc(agentMockActions.createdAt)),
    db.select({ orderId: operationalEvents.orderId, at: operationalEvents.recordedAt, details: operationalEvents.details }).from(operationalEvents)
      .where(and(eq(operationalEvents.command, "manual_control.ended"), inArray(operationalEvents.orderId, ids))).orderBy(desc(operationalEvents.recordedAt)),
  ])
  const threadMessages = new Map<string, (typeof messages.$inferSelect)[]>()
  for (const message of threadMessageRows) threadMessages.set(message.conversationId, [...(threadMessages.get(message.conversationId) ?? []), message])
  for (const list of threadMessages.values()) list.sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime() || a.id.localeCompare(b.id))
  const mock = new Map<string, typeof agentMockActions.$inferSelect>()
  for (const action of mocks) if (!mock.has(action.orderId)) mock.set(action.orderId, action)
  return { threads, threadMessages, applied, seen: new Map(seen.map((row) => [row.orderId, new Date(row.at)])), mock,
    // The latest ending per order (rows come newest first).
    manualEnded: new Map([...manualEnded].reverse().map((row) => {
      const changes = (row.details.changes ?? {}) as Record<string, unknown>
      return [row.orderId, { at: new Date(row.at), choice: typeof changes.choice === "string" ? changes.choice : null,
        note: typeof changes.note === "string" ? changes.note : null }]
    })) }
}

/** The deadline by which we need an answer about this template's question. */
function needByFor(bundle: Bundle, assessment: TriageAssessment, emailCase: EmailCase): { at: string; label: string } | null {
  const windows = chosenWindows(bundle)
  const aboutPickup = ["pickup_change", "site_pickup_time", "site_readiness"].includes(emailCase.templateId)
    || (emailCase.templateId === "site_access" && emailCase.recipientType === "pickup_site")
  const window = aboutPickup ? windows.pickupSlot : windows.promise
  if (window?.start) return { at: window.start, label: aboutPickup ? "Pickup slot" : "Delivery promise" }
  return assessment.deadline ? { at: assessment.deadline.at, label: assessment.deadline.label } : null
}

function firstSeen(bundle: Bundle, assessment: TriageAssessment): string | null {
  const times = [
    ...assessment.checks.filter((check) => check.outcome === "fail").flatMap((check) => check.evidence.map((entry) => entry.timestamp)),
    ...bundle.alerts.filter((alert) => alert.status === "OPEN" || alert.status === "ACKNOWLEDGED").map((alert) => alert.triggeredAt),
  ].filter((value): value is string => !!value && !Number.isNaN(Date.parse(value)))
  return times.sort()[0] ?? null
}

function stateFor(bundle: Bundle, supplement: Supplement, now: Date): ControlState {
  const id = bundle.order.id
  const assessment = evaluateTriage(bundle)
  const card = buildBoardCard(bundle)
  const threads = supplement.threads.filter((thread) => thread.orderId === id
    || (Array.isArray(thread.details.related_order_ids) && thread.details.related_order_ids.includes(id)))
  const cases = RECIPIENT_TYPES.map((type) => {
    const thread = threadFor(threads, id, type)
    return thread ? buildEmailCase(thread.id, type, supplement.threadMessages.get(thread.id) ?? [],
      (messageId) => supplement.applied.find((entry) => entry.messageId === messageId)?.at ?? null) : null
  }).filter((entry): entry is EmailCase => !!entry).sort((a, b) => b.sentAt.localeCompare(a.sentAt))
  const seenAt = supplement.seen.get(id)?.getTime() ?? 0
  const mock = supplement.mock.get(id)
  const activeAlerts = bundle.alerts.filter((alert) => alert.status === "OPEN" || alert.status === "ACKNOWLEDGED")
  const failed = assessment.checks.filter((check) => check.outcome === "fail")

  const names = namesFor(bundle, [mock?.waitingOnDescription, String(bundle.order.details.agent_proposal_action ?? "")])

  // Replies nobody has opened yet: on an email we sent, or an outside message after an approved follow-up started.
  const unseenEmailReply = cases.find((entry) => entry.reply && entry.stage !== "applied" && Date.parse(entry.reply.at) > seenAt)
  const mockReply = mock ? bundle.messages.filter((message) => REPLY_AUTHORS.includes(message.authorType)
    && Date.parse(message.authoredAt) >= mock.createdAt.getTime() && Date.parse(message.authoredAt) > seenAt).at(-1) : undefined

  // What we are still waiting for, and from whom.
  const waitingItems: ControlWaiting[] = cases.filter((entry) => entry.stage === "waiting").map((entry) => ({
    who: entry.recipientName, about: TEMPLATES[entry.templateId].about, since: entry.sentAt, needBy: needByFor(bundle, assessment, entry),
  }))
  if (mock && mock.status === "WAITING" && bundle.order.status === "follow_up" && !mockReply) {
    const promise = chosenWindows(bundle).promise
    const party = followUpRecipient(mock.payload, partiesFor(bundle))
    waitingItems.push({ who: party?.name ?? "not recorded", about: withNames(mock.waitingOnDescription, names), since: iso(mock.createdAt),
      needBy: assessment.deadline ? { at: assessment.deadline.at, label: assessment.deadline.label }
        : promise?.start ? { at: promise.start, label: "Delivery promise" } : null })
  }
  // A message we typed to a driver, customer or site in any conversation (not an email, not an internal note)
  // asks them something: waiting until a later message from them in that conversation.
  const snapshot = Date.parse(NOW)
  const asked = new Map<string, (typeof bundle.messages)[number]>()
  for (const message of bundle.messages) {
    const ours = message.authorType === "operator" || message.authorType === "agent"
    const channel = String(message.details.channel ?? "")
    if (!ours || Date.parse(message.authoredAt) <= snapshot || EMAIL_CHANNELS.includes(channel) || channel === "internal_note"
      || message.details.visibility === "INTERNAL" || !REPLY_AUTHORS.includes(String(message.details.recipient_type))) continue
    asked.set(message.conversationId, message)
  }
  let typedReply: (typeof bundle.messages)[number] | undefined
  for (const message of asked.values()) {
    const answer = bundle.messages.find((entry) => entry.conversationId === message.conversationId && REPLY_AUTHORS.includes(entry.authorType)
      && Date.parse(entry.authoredAt) > Date.parse(message.authoredAt))
    if (answer) { if (Date.parse(answer.authoredAt) > seenAt) typedReply = answer; continue }
    const who = typeof message.details.recipient_name_snapshot === "string" ? message.details.recipient_name_snapshot
      : bundle.dir.resolve(message.details.recipient_id, message.details.recipient_type).name
    waitingItems.push({ who, about: short(withNames(message.body, names), 80), since: message.authoredAt,
      needBy: assessment.deadline ? { at: assessment.deadline.at, label: assessment.deadline.label } : null })
  }
  const waited = (item: ControlWaiting) => now.getTime() - Date.parse(item.since)
  const overdue = (item: ControlWaiting) => waited(item) > WAITING_LIMITS.waitedMoreThanHours * HOUR
    || (!!item.needBy && Date.parse(item.needBy.at) - now.getTime() < WAITING_LIMITS.deadlineWithinHours * HOUR
      && waited(item) >= WAITING_LIMITS.minimumWaitMinutes * 60_000)
  // Ending manual control closes whatever we were waiting for before it.
  const ended = supplement.manualEnded.get(id)
  const manualEndedAt = ended?.at.getTime() ?? 0
  // Closed by a person: "Problem solved" ends it, unless something new happens afterwards.
  const closedByOperator = ended?.choice === "solved"
    && !activeAlerts.some((alert) => Date.parse(alert.triggeredAt) > manualEndedAt)
  const waiting = waitingItems.filter((item) => Date.parse(item.since) > manualEndedAt).sort((a, b) => (a.needBy?.at ?? "9").localeCompare(b.needBy?.at ?? "9"))[0] ?? null

  const latest = cases[0]
  const pendingProposal = bundle.order.agentMode === "AGENT" && !!bundle.order.details.agent_proposal_present
    && bundle.order.agentDecision === "PENDING"
  const settled = latest?.stage === "applied" && latest.applied
    && !activeAlerts.some((alert) => Date.parse(alert.triggeredAt) > Date.parse(latest.applied!.at))
  const openProblem = assessment.classification === "person_now" || activeAlerts.length > 0 || pendingProposal

  let section: ControlSection | null = null
  let flag: ControlFlag | null = null
  let note = ""
  if (bundle.order.agentMode === "MANUAL") {
    // Stays here whatever happens until a person ends manual control.
    section = "manual"
  } else if (unseenEmailReply?.reply && Date.parse(unseenEmailReply.reply.at) > manualEndedAt) {
    section = "review"
    flag = { kind: "new_reply", at: unseenEmailReply.reply.at,
      text: `New reply from ${unseenEmailReply.recipientName}: “${short(unseenEmailReply.reply.body, 60)}”` }
  } else if ((mockReply ?? typedReply) && Date.parse((mockReply ?? typedReply)!.authoredAt) > manualEndedAt) {
    section = "review"
    const reply = (mockReply ?? typedReply)!
    const author = bundle.dir.resolve(reply.details.author_id, reply.authorType)
    const name = typeof reply.details.author_name_snapshot === "string" ? reply.details.author_name_snapshot : author.name
    flag = { kind: "new_reply", at: reply.authoredAt, text: `New reply from ${name}: “${short(reply.body, 60)}”` }
  } else if (waiting) {
    if (overdue(waiting)) {
      section = "review"
      flag = { kind: "no_reply", at: null, text: `No reply yet${waiting.who ? ` from ${waiting.who}` : ""}: still waiting for ${waiting.about}` }
    } else section = "pending"
  } else if (closedByOperator) {
    note = `Closed by operator ${ended!.at.toISOString().slice(11, 16)}: ${ended!.note ?? "problem solved"}`
  } else if (settled) {
    note = appliedNote(latest) ?? "Change recorded (simulated)"
  } else if (latest?.stage === "agreed" && latest.change) {
    section = "review"
    flag = { kind: "agreed", at: latest.reply?.at ?? null, text: `${latest.recipientName} agreed. Record the ${latest.change.kind} change.` }
  } else if (latest?.stage === "declined") {
    section = "review"
    flag = { kind: "declined", at: latest.reply?.at ?? null, text: `${latest.recipientName} declined` }
  } else if (latest?.stage === "replied" && latest.reply) {
    section = "review"
    flag = { kind: "replied", at: latest.reply.at, text: `${latest.recipientName} replied: “${short(latest.reply.body, 60)}”` }
  } else if (openProblem) {
    section = "review"
  }

  if (!section) {
    return { row: null, note: note || (assessment.classification === "agent_investigate" ? `The agent is checking: ${failed[0] ? readingFor(failed[0]) : "open questions"}`
      : "Nothing needs a person") }
  }

  const proposal = bundle.order.details.agent_proposal_action
  const alertLine = activeAlerts[0] ? card.problemTitle ?? activeAlerts[0].summary : null
  const line: ControlRow["line"] = failed[0] ? { kind: "reading", text: readingFor(failed[0]) }
    : { kind: "status", text: alertLine ?? card.problemTitle ?? card.statusLabel }
  const deadline = section === "pending" && waiting?.needBy ? waiting.needBy
    : assessment.deadline ? { at: assessment.deadline.at, label: assessment.deadline.label } : null
  const row: ControlRow = {
    id, reference: bundle.order.reference, vehicle: card.vehicle, from: card.from.city, to: card.to.city, customer: card.customer,
    section, priority: assessment.priority, urgency: urgencyOf(assessment.priority), deadline, firstSeenAt: firstSeen(bundle, assessment),
    line, suggestion: pendingProposal && typeof proposal === "string" ? withNames(proposal, names) : null,
    flag, waiting: section === "pending" || flag?.kind === "no_reply" ? waiting : null,
  }
  return { row, note: SECTION_LABELS[section] }
}

/** The proposal columns live on the order row, not in the board bundle; fold the two facts the table needs into it. */
async function withProposalFacts(bundles: Bundle[]): Promise<Bundle[]> {
  const ids = bundles.map((bundle) => bundle.order.id)
  const rows = ids.length ? await db.select({ id: orders.id, proposal: orders.agentProposal }).from(orders).where(inArray(orders.id, ids)) : []
  const byId = new Map(rows.map((row) => [row.id, row.proposal]))
  return bundles.map((bundle) => {
    const proposal = byId.get(bundle.order.id) as { proposed_action?: unknown } | null | undefined
    return { ...bundle, order: { ...bundle.order, details: { ...bundle.order.details,
      agent_proposal_present: !!proposal, agent_proposal_action: typeof proposal?.proposed_action === "string" ? proposal.proposed_action : null } } }
  })
}

export async function controlStates(bundles: Bundle[]): Promise<{ now: Date; states: Map<string, ControlState> }> {
  const [now, enriched] = await Promise.all([currentTime(), withProposalFacts(bundles)])
  const supplement = await loadSupplement(enriched.map((bundle) => bundle.order.id))
  return { now, states: new Map(enriched.map((bundle) => [bundle.order.id, stateFor(bundle, supplement, now)])) }
}

/** Priority number first (a safety stop is always on top), then a new reply, then the soonest deadline, then the oldest problem. */
function byUrgency(a: ControlRow, b: ControlRow): number {
  const deadline = (row: ControlRow) => row.deadline ? Date.parse(row.deadline.at) : Infinity
  const seen = (row: ControlRow) => row.firstSeenAt ? Date.parse(row.firstSeenAt) : Infinity
  return b.priority - a.priority
    || Number(b.flag?.kind === "new_reply") - Number(a.flag?.kind === "new_reply")
    || deadline(a) - deadline(b)
    || seen(a) - seen(b)
    || a.reference.localeCompare(b.reference)
}

function byNeedBy(a: ControlRow, b: ControlRow): number {
  const needBy = (row: ControlRow) => row.deadline ? Date.parse(row.deadline.at) : Infinity
  return needBy(a) - needBy(b) || Date.parse(a.waiting?.since ?? "") - Date.parse(b.waiting?.since ?? "") || a.reference.localeCompare(b.reference)
}

export type ControlTable = {
  now: string
  snapshotAt: string | null
  sections: Record<ControlSection, ControlRow[]>
  waitingCloseToDeadline: number
}

export async function controlTable(): Promise<ControlTable> {
  const { snapshotAt, bundles } = await loadBoardBundles()
  const { now, states } = await controlStates(bundles)
  const rows = [...states.values()].map((state) => state.row).filter((row): row is ControlRow => !!row)
  const waiting = rows.filter((row) => row.section === "pending").sort(byNeedBy)
  return {
    now: iso(now), snapshotAt,
    sections: {
      review: rows.filter((row) => row.section === "review").sort(byUrgency),
      pending: waiting,
      manual: rows.filter((row) => row.section === "manual").sort(byUrgency),
    },
    waitingCloseToDeadline: waiting.filter((row) => row.deadline
      && Date.parse(row.deadline.at) - now.getTime() < WAITING_LIMITS.closeWithinHours * HOUR).length,
  }
}

/** One order's place in the control table, for the order page. */
export async function controlStateFor(orderId: string): Promise<ControlState | null> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  return (await controlStates([loaded.bundle])).states.get(orderId) ?? null
}

/**
 * Records that someone opened the order after a reply arrived, so "New reply" clears for everyone.
 * Writes only when there is an unseen reply. Returns whether it wrote.
 */
export async function markRepliesSeen(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) return false
    const now = await currentTime(tx)
    const [[seen], [reply]] = await Promise.all([
      tx.select({ at: sql<Date | null>`max(${operationalEvents.recordedAt})` }).from(operationalEvents)
        .where(and(eq(operationalEvents.orderId, orderId), eq(operationalEvents.command, REPLY_SEEN_COMMAND))),
      tx.select({ at: sql<Date | null>`max(${messages.authoredAt})` }).from(messages)
        .where(and(eq(messages.orderId, orderId), inArray(messages.authorType, REPLY_AUTHORS))),
    ])
    const seenAt = seen?.at ? new Date(seen.at).getTime() : 0
    const replyAt = reply?.at ? new Date(reply.at).getTime() : 0
    // Only replies recorded after the snapshot are new; the dataset's own messages are history.
    if (!replyAt || replyAt <= Date.parse(NOW) || replyAt <= seenAt || replyAt > now.getTime()) return false
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: REPLY_SEEN_COMMAND,
      targetType: "order", targetId: orderId, recordedAt: now, details: {
        actor_type: "operator", actor_id: "operator", source: "control_room", changes: { reply_at: new Date(replyAt).toISOString() },
      } })
    return true
  })
}
