// Orders that may have a problem but have no alert. Triage flags them for the agent
// (agent_investigate) but nothing would show them to a person. A scan, started by a person
// ("Check all" or per order), lets the agent check one order:
//   - a position, check-in or positioning doubt → the agent asks the driver (a driver_chat message,
//     so the order is Pending as usual); a scripted driver reply comes back at once;
//   - then it judges from the facts: cleared, needs a person, or unsure.
// Every step is an event (agent.scan_started / agent.scan_cleared / agent.scan_escalated).

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray } from "drizzle-orm"
import { currentTime, nextActionTime } from "./clock"
import { costOptions } from "./cost-options"
import { db } from "./db"
import { generateWithModel } from "./model-call"
import { chosenWindows } from "./present/attention"
import { num, str, type Bundle } from "./present/bundle"
import { loadOrder } from "./present/load"
import { partiesFor } from "./present/names"
import { REPLY_SOURCE_LABELS, type ReplySource } from "./present/names-text"
import { fmtDateTime, fmtLocal } from "./present/time"
import { SCRIPTED_DRIVER_REPLIES } from "./simulated-reply"
import { conversations, messages, operationalEvents } from "./schema"
import { evaluateTriage, type TriageAssessment, type TriageCheck } from "./triage"
import { readAppPositions } from "./triage-read"

export const SCAN_COMMANDS = ["agent.scan_started", "agent.scan_cleared", "agent.scan_escalated", "agent.scan_reopened"]
const DRIVER_RULES = new Set(["tracking_stale", "tracking_missing", "progress_plateau", "ferry_cutoff", "positioning_risk"])

/** The failing check that puts an order in the strip: triage wants the agent to look, and no alert is open. */
export function scanIssue(bundle: Bundle, assessment: TriageAssessment): TriageCheck | null {
  if (assessment.classification !== "agent_investigate") return null
  if (bundle.alerts.some((alert) => alert.status === "OPEN" || alert.status === "ACKNOWLEDGED")) return null
  return assessment.checks.find((check) => check.outcome === "fail" && check.classification === "agent_investigate") ?? null
}

/** What looks wrong, in plain words: "Last position 6.8 h old". */
export function plainIssue(check: TriageCheck, bundle: Bundle): string {
  const snapshot = Date.parse(bundle.snapshotAt ?? "")
  const at = check.evidence[0]?.timestamp
  const ago = at && Number.isFinite(snapshot) ? (snapshot - Date.parse(at)) / 3_600_000 : null
  const promise = chosenWindows(bundle).promise
  switch (check.rule) {
    case "tracking_stale": return `Last position ${ago === null ? "is old" : `${ago.toFixed(1)} h old`}`
    case "tracking_missing": return `No position since the pickup${ago === null ? "" : ` ${ago < 1 ? `${Math.round(ago * 60)} min` : `${ago.toFixed(1)} h`} ago`}`
    case "progress_plateau": return "The distance left has not changed between the last two positions"
    case "ferry_cutoff": return `Ferry check-in closes ${check.deadline ? fmtDateTime(check.deadline.at) : "soon"}; no check-in recorded`
    case "positioning_risk": return "How the driver gets to the next pickup is not on file"
    case "eta_vs_promise": {
      const eta = str(readAppPositions(bundle).find((row) => str(row.details.estimated_delivery_at))?.details.estimated_delivery_at)
      if (!eta || !promise?.end) return "The arrival estimate is close to the promise"
      const minutes = Math.round((Date.parse(eta) - Date.parse(promise.end)) / 60_000)
      return minutes > 0 ? `ETA ${minutes} min after the promise ends` : minutes === 0 ? "ETA exactly at the end of the promise" : `ETA only ${-minutes} min inside the promise`
    }
    default: return check.detail
  }
}

function question(check: TriageCheck): string {
  switch (check.rule) {
    case "ferry_cutoff": return `Hi, this is the control room. Have you checked in for the ferry? Check-in closes ${check.deadline ? fmtDateTime(check.deadline.at) : "soon"}.`
    case "positioning_risk": return "Hi, this is the control room. How and when will you get to your next pickup?"
    default: return "Hi, this is the control room. We have no recent position from your app. Where are you now, and are you still on time for the delivery?"
  }
}

export type ScanOutcome =
  | { outcome: "nothing" }
  | { outcome: "asked_driver"; driver: string }
  | { outcome: "cleared"; reason: string; checked: string; verdict: VerdictWord }
  | { outcome: "escalated"; kind: "found" | "unsure"; reason: string; checked: string; verdict: VerdictWord }

/** The agent's verdict as one word. Only this is shown; the model's own sentence stays in the event (agent_thinks) for debugging. */
export type VerdictWord = "fine" | "needs_person" | "unsure"

/** fromModel: false when the "reason" is our own failure text, not the model's view. */
type Verdict = { verdict: "fine" | "needs_person" | "unsure"; reason: string; fromModel: boolean }

async function judge(reference: string, facts: Record<string, unknown>): Promise<Verdict> {
  const prompt = `You check one fictional car delivery for a control room. Facts: ${JSON.stringify(facts)}
Return only JSON: {"verdict": "fine" | "needs_person" | "unsure", "reason": one short plain sentence}.
"fine" only if the facts show where the car is and that it will arrive inside the delivery promise. If something is missing, say "unsure".`
  const result = await generateWithModel({ model: process.env.OLLAMA_MODEL || "llama3.2", stream: false, format: "json", prompt,
    options: { temperature: 0, num_predict: 120 } }, 120_000, reference)
  if (!result.ok) return { verdict: "unsure", reason: result.reason, fromModel: false }
  try {
    const raw = (result.output as { response?: unknown }).response
    const parsed = JSON.parse(typeof raw === "string" ? raw : "") as { verdict?: unknown; reason?: unknown }
    const verdict = parsed.verdict === "fine" || parsed.verdict === "needs_person" || parsed.verdict === "unsure" ? parsed.verdict : null
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : null
    return verdict && reason ? { verdict, reason, fromModel: true } : { verdict: "unsure", reason: "the model's answer was not a clear verdict", fromModel: false }
  } catch { return { verdict: "unsure", reason: "the model's answer was not a clear verdict", fromModel: false } }
}

async function record(orderId: string, command: string, changes: Record<string, unknown>, at?: Date) {
  return db.transaction(async (tx) => {
    const now = at ?? await nextActionTime(tx)
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command, targetType: "order", targetId: orderId, recordedAt: now,
      details: { actor_type: "agent", actor_id: "local-agent", source: "control_room_scan", simulated: true, changes } })
    return now
  })
}

/** Writes one message in the order's driver chat (creating it if needed). */
async function driverChat(orderId: string, driver: { id: string | null; name: string }, from: "agent" | "driver", body: string, at: Date, replySource?: ReplySource) {
  const [existing] = await db.select().from(conversations).where(and(eq(conversations.orderId, orderId), eq(conversations.channel, "driver_chat")))
    .orderBy(desc(conversations.updatedAt)).limit(1)
  const threadId = existing?.id ?? `conv-${randomUUID()}`
  const iso = at.toISOString()
  if (!existing) {
    await db.insert(conversations).values({ id: threadId, orderId, channel: "driver_chat", category: "agent_check", status: "OPEN", updatedAt: at, details: {
      id: threadId, channel: "driver_chat", category: "agent_check", status: "OPEN", order_id: orderId, started_at: iso, updated_at: iso,
      counterparty_id: driver.id, counterparty_type: "driver", counterparty_name_snapshot: driver.name, simulated: true } })
  } else {
    await db.update(conversations).set({ updatedAt: at, status: "OPEN" }).where(eq(conversations.id, threadId))
  }
  const id = `msg-${randomUUID()}`
  await db.insert(messages).values({ id, orderId, conversationId: threadId, authorType: from, body, authoredAt: at, details: from === "agent"
    ? { id, body, channel: "driver_chat", language: "en", order_id: orderId, author_id: "local-agent", author_type: "agent", visibility: "PUBLIC",
      authored_at: iso, recipient_id: driver.id, recipient_type: "driver", recipient_name_snapshot: driver.name, conversation_id: threadId, simulated: true }
    : { id, body, channel: "driver_chat", language: "en", order_id: orderId, author_id: driver.id, author_type: "driver", author_name_snapshot: driver.name,
      visibility: "PUBLIC", authored_at: iso, recipient_id: "local-agent", recipient_type: "agent", conversation_id: threadId, simulated: true,
      reply_source: replySource ?? "scripted" } })
  return { id, threadId, at: iso }
}

/** The agent checks one order with a possible problem and no alert. Never throws for model problems. */
/** The agent may close alone only with at least this much margin: the same 15 minutes triage uses for ETA vs promise. */
export const CLOSE_MARGIN_MINUTES = 15

function gap(minutes: number): string {
  const value = Math.round(Math.abs(minutes))
  return value >= 120 ? `${Math.floor(value / 60)} h ${value % 60} min` : `${value} min`
}

export async function scanOrder(orderId: string): Promise<ScanOutcome> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return { outcome: "nothing" }
  const { bundle } = loaded
  const check = scanIssue(bundle, evaluateTriage(bundle))
  if (!check) return { outcome: "nothing" }
  const issue = plainIssue(check, bundle)
  const started = await record(orderId, "agent.scan_started", { rule: check.rule, issue })

  // What was checked is built from the records only. The model never writes a fact.
  const windows = chosenWindows(bundle)
  const zone = windows.promise?.zone ?? null
  const eta = str(readAppPositions(bundle).find((row) => str(row.details.estimated_delivery_at))?.details.estimated_delivery_at)
  const promiseEnd = windows.promise?.end ?? null
  const margin = eta && promiseEnd ? (Date.parse(promiseEnd) - Date.parse(eta)) / 60_000 : null
  const latest = readAppPositions(bundle)[0]
  const facts: string[] = []
  const sources: string[] = []
  if (eta) facts.push(`latest app ETA ${fmtLocal(eta, zone)}${margin === null ? ""
    : margin >= 0 ? `, ${gap(margin)} inside the delivery promise ending ${fmtLocal(promiseEnd, zone)}`
    : `, ${gap(margin)} after the delivery promise ends (${fmtLocal(promiseEnd, zone)})`}`)
  else facts.push("no app ETA on file")
  if (latest) {
    const km = num(latest.details.distance_remaining_km)
    facts.push(`last app position ${fmtDateTime(str(latest.details.observed_at))}${km !== null ? `, ${km} km to go` : ""}`)
    sources.push(`Driver app position, ${fmtDateTime(str(latest.details.observed_at))}`)
  }
  if (windows.promise) sources.push(`Delivery promise ends ${fmtLocal(windows.promise.end, zone)}`)
  const checked = () => facts.join("; ")
  const escalate = async (kind: "found" | "unsure", reason: string, agentThinks: string | null = null, verdict: VerdictWord = kind === "found" ? "needs_person" : "unsure") => {
    await record(orderId, "agent.scan_escalated", { kind, reason, checked: checked(), verdict, agent_thinks: agentThinks, rule: check.rule, sources })
    return { outcome: "escalated" as const, kind, reason, checked: checked(), verdict }
  }

  // An ETA problem can never meet the closing margin: a person decides, no need to ask anyone first.
  if (check.rule === "eta_vs_promise") {
    return escalate("found", margin !== null && margin < 0
      ? `ETA ${gap(margin)} after the promise ends; the promise will be missed unless something changes`
      : `ETA only ${margin === null ? "an unknown time" : gap(margin)} inside the promise; under ${CLOSE_MARGIN_MINUTES} min, so a person decides`)
  }

  let driverReply: string | null = null
  if (DRIVER_RULES.has(check.rule)) {
    const party = partiesFor(bundle).driver
    if (!party) return escalate("unsure", "there is no driver on file to ask")
    const asked = await driverChat(orderId, party, "agent", question(check), started)
    const scripted = SCRIPTED_DRIVER_REPLIES[bundle.order.reference]
    if (!scripted) return { outcome: "asked_driver", driver: party.name }
    // A scripted driver answers straight away, a minute after the question. Quoted word for word.
    const answeredAt = new Date(Date.parse(asked.at) + 60_000)
    driverReply = `${scripted} (simulated)`
    await driverChat(orderId, party, "driver", driverReply, answeredAt, "scripted")
    facts.unshift(`${party.name} replied ${fmtDateTime(answeredAt.toISOString())}: “${scripted}” (${REPLY_SOURCE_LABELS.scripted})`)
    sources.unshift(`Driver ${party.name}, ${fmtDateTime(answeredAt.toISOString())}`)
  }

  // The model gives a verdict; its own sentence is stored as agent_thinks for debugging and never shown.
  const verdict = await judge(bundle.order.reference, {
    order: bundle.order.reference, what_looks_wrong: issue, driver_reply: driverReply,
    latest_app_eta: eta ? fmtDateTime(eta) : null, delivery_promise_ends: promiseEnd ? fmtDateTime(promiseEnd) : null,
    minutes_inside_promise: margin === null ? null : Math.round(margin),
  })
  const thinks = verdict.verdict === "unsure" && !verdict.fromModel ? null : verdict.reason
  if (verdict.verdict === "needs_person") return escalate("found", issue, thinks)
  if (verdict.verdict === "unsure") return escalate("unsure", margin === null ? "no app ETA on file to confirm the delivery promise"
    : verdict.fromModel ? "the agent is not sure from these facts" : verdict.reason, thinks)
  // "Fine" closes it only with the margin, no cost and no date change; otherwise a person decides.
  if (margin === null) return escalate("unsure", "no app ETA on file to confirm the delivery promise", thinks)
  // The model said fine, but the rules do not let the agent close it: the verdict stays "fine", the reason says why a person decides.
  if (margin < CLOSE_MARGIN_MINUTES) return escalate("found", `ETA only ${gap(margin)} inside the promise; under ${CLOSE_MARGIN_MINUTES} min, so a person decides`, thinks, "fine")
  if (costOptions(bundle, await currentTime())) return escalate("found", "a paid change may be needed, so a person decides", thinks, "fine")
  await record(orderId, "agent.scan_cleared", { reason: checked(), checked: checked(), verdict: "fine", agent_thinks: thinks, rule: check.rule, sources })
  return { outcome: "cleared", reason: checked(), checked: checked(), verdict: "fine" }
}

/** A person reopens an order whose warning the agent cleared: it goes to Needs a review, tagged "Reopened by operator". */
export async function reopenScan(orderId: string): Promise<{ success: boolean; error?: string }> {
  const [latest] = await db.select({ command: operationalEvents.command }).from(operationalEvents)
    .where(and(eq(operationalEvents.orderId, orderId), inArray(operationalEvents.command, SCAN_COMMANDS)))
    .orderBy(desc(operationalEvents.recordedAt), desc(operationalEvents.id)).limit(1)
  if (latest?.command !== "agent.scan_cleared") return { success: false, error: "Only an order whose warning the agent cleared can be reopened." }
  await db.transaction(async (tx) => {
    const now = await nextActionTime(tx)
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: "agent.scan_reopened", targetType: "order",
      targetId: orderId, recordedAt: now, details: { actor_type: "operator", actor_id: "operator", source: "control_room_scan", changes: {} } })
  })
  return { success: true }
}
