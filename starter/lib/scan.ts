// Orders that may have a problem but have no alert. Triage flags them for the agent
// (agent_investigate) but nothing would show them to a person. A scan, started by a person
// ("Check all" or per order), lets the agent check one order:
//   - a position, check-in or positioning doubt → the agent asks the driver (a driver_chat message,
//     so the order is Pending as usual); a scripted driver reply comes back at once;
//   - then it judges from the facts: cleared, needs a person, or unsure.
// Every step is an event (agent.scan_started / agent.scan_cleared / agent.scan_escalated).

import { randomUUID } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import { nextActionTime } from "./clock"
import { db } from "./db"
import { generateWithModel } from "./model-call"
import { chosenWindows } from "./present/attention"
import { num, str, type Bundle } from "./present/bundle"
import { loadOrder } from "./present/load"
import { partiesFor } from "./present/names"
import { fmtDateTime, fmtLocal } from "./present/time"
import { SCRIPTED_DRIVER_REPLIES } from "./simulated-reply"
import { conversations, messages, operationalEvents } from "./schema"
import { evaluateTriage, type TriageAssessment, type TriageCheck } from "./triage"
import { readAppPositions } from "./triage-read"

export const SCAN_COMMANDS = ["agent.scan_started", "agent.scan_cleared", "agent.scan_escalated"]
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
  | { outcome: "cleared"; reason: string }
  | { outcome: "escalated"; kind: "found" | "unsure"; reason: string }

type Verdict = { verdict: "fine" | "needs_person" | "unsure"; reason: string }

async function judge(reference: string, facts: Record<string, unknown>): Promise<Verdict> {
  const prompt = `You check one fictional car delivery for a control room. Facts: ${JSON.stringify(facts)}
Return only JSON: {"verdict": "fine" | "needs_person" | "unsure", "reason": one short plain sentence}.
"fine" only if the facts show where the car is and that it will arrive inside the delivery promise. If something is missing, say "unsure".`
  const result = await generateWithModel({ model: process.env.OLLAMA_MODEL || "llama3.2", stream: false, format: "json", prompt,
    options: { temperature: 0, num_predict: 120 } }, 120_000, reference)
  if (!result.ok) return { verdict: "unsure", reason: result.reason }
  try {
    const raw = (result.output as { response?: unknown }).response
    const parsed = JSON.parse(typeof raw === "string" ? raw : "") as { verdict?: unknown; reason?: unknown }
    const verdict = parsed.verdict === "fine" || parsed.verdict === "needs_person" || parsed.verdict === "unsure" ? parsed.verdict : null
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : null
    return verdict && reason ? { verdict, reason } : { verdict: "unsure", reason: "the model's answer was not a clear verdict" }
  } catch { return { verdict: "unsure", reason: "the model's answer was not a clear verdict" } }
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
async function driverChat(orderId: string, driver: { id: string | null; name: string }, from: "agent" | "driver", body: string, at: Date) {
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
      visibility: "PUBLIC", authored_at: iso, recipient_id: "local-agent", recipient_type: "agent", conversation_id: threadId, simulated: true } })
  return { id, threadId, at: iso }
}

/** The agent checks one order with a possible problem and no alert. Never throws for model problems. */
export async function scanOrder(orderId: string): Promise<ScanOutcome> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return { outcome: "nothing" }
  const { bundle } = loaded
  const check = scanIssue(bundle, evaluateTriage(bundle))
  if (!check) return { outcome: "nothing" }
  const issue = plainIssue(check, bundle)
  const started = await record(orderId, "agent.scan_started", { rule: check.rule, issue })

  const windows = chosenWindows(bundle)
  const eta = str(readAppPositions(bundle).find((row) => str(row.details.estimated_delivery_at))?.details.estimated_delivery_at)
  const promiseEnd = windows.promise?.end ?? null
  const sources: string[] = []
  const latest = readAppPositions(bundle)[0]
  if (latest) sources.push(`Driver app position, ${fmtDateTime(str(latest.details.observed_at))}${num(latest.details.distance_remaining_km) !== null ? `, ${latest.details.distance_remaining_km} km to go` : ""}`)
  if (windows.promise) sources.push(`Delivery promise ends ${fmtLocal(windows.promise.end, windows.promise.zone)}`)

  // The data alone says it will be late: a person must decide, no need to ask anyone first.
  if (check.rule === "eta_vs_promise" && eta && promiseEnd && Date.parse(eta) > Date.parse(promiseEnd)) {
    const reason = `${issue}; the promise will be missed unless something changes`
    await record(orderId, "agent.scan_escalated", { kind: "found", reason, rule: check.rule, sources })
    return { outcome: "escalated", kind: "found", reason }
  }

  let driverReply: string | null = null
  if (DRIVER_RULES.has(check.rule)) {
    const party = partiesFor(bundle).driver
    if (!party) {
      const reason = "there is no driver on file to ask"
      await record(orderId, "agent.scan_escalated", { kind: "unsure", reason, rule: check.rule })
      return { outcome: "escalated", kind: "unsure", reason }
    }
    const asked = await driverChat(orderId, party, "agent", question(check), started)
    const scripted = SCRIPTED_DRIVER_REPLIES[bundle.order.reference]
    if (!scripted) return { outcome: "asked_driver", driver: party.name }
    // A scripted driver answers straight away, a minute after the question.
    const answeredAt = new Date(Date.parse(asked.at) + 60_000)
    driverReply = `${scripted} (simulated)`
    await driverChat(orderId, party, "driver", driverReply, answeredAt)
    sources.unshift(`Driver ${party.name}, ${fmtDateTime(answeredAt.toISOString())}: “${scripted}”`)
  }

  const verdict = await judge(bundle.order.reference, {
    order: bundle.order.reference, what_looks_wrong: issue, driver_reply: driverReply,
    latest_app_eta: eta ? fmtDateTime(eta) : null, delivery_promise_ends: promiseEnd ? fmtDateTime(promiseEnd) : null,
    eta_inside_promise: eta && promiseEnd ? Date.parse(eta) <= Date.parse(promiseEnd) : null,
  })
  if (verdict.verdict === "fine") {
    await record(orderId, "agent.scan_cleared", { reason: verdict.reason, rule: check.rule, sources })
    return { outcome: "cleared", reason: verdict.reason }
  }
  const kind = verdict.verdict === "needs_person" ? "found" : "unsure"
  await record(orderId, "agent.scan_escalated", { kind, reason: verdict.reason, rule: check.rule, sources })
  return { outcome: "escalated", kind, reason: verdict.reason }
}
