// Every statement in the case summary is one of three kinds, so an operator can
// tell what a record says from what the agent concluded and what it proposes:
//   fact        — a record says it; carries who said it and when.
//   reading     — the agent's conclusion from facts; carries the facts it rests on.
//   suggestion  — what the agent proposes to do.
// Anything the records cannot establish is stated as "not known".
// Facts come from the triage checks' evidence (collection, record id, timestamp).

import { evaluateTriage, type Rule, type TriageCheck } from "../triage"
import { str, num, type Bundle } from "./bundle"
import { humanize, label } from "./labels"
import { fmtDateTime, fmtMoney, fmtRange } from "./time"
import { windowSource } from "./attention"

/** Who said something and when. `at` is null when the record carries no time; the UI says so. */
export type SourceRef = { who: string; what: string; at: string | null; collection: string; recordId: string }

export type FactStatement = { kind: "fact"; source: SourceRef }
export type ReadingStatement = { kind: "reading"; text: string; basedOn: SourceRef[] }
export type UnknownStatement = { kind: "unknown"; subject: string; note: string | null; basedOn: SourceRef[] }
export type SuggestionStatement = { kind: "suggestion"; text: string }

export type CaseStatements = {
  facts: FactStatement[]
  readings: ReadingStatement[]
  unknowns: UnknownStatement[]
  suggestions: SuggestionStatement[]
  /** The saved agent proposal's source ids, resolved to who and when. Null where the id is not on this order. */
  proposalSources: Record<string, SourceRef | null>
}

const short = (text: string, max = 140) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
const when = (value: unknown) => str(value) ?? null

/** Reads one record on the order and says who stated what, and when. Null when the id is not on this order. */
export function describeRecord(bundle: Bundle, recordId: string, collection?: string): SourceRef | null {
  const event = bundle.events.find((entry) => entry.id === recordId)
  if (event && (!collection || collection === "operational_events")) {
    const changes = (event.details.changes ?? {}) as Record<string, unknown>
    const actor = bundle.dir.resolve(event.details.actor_id, event.details.actor_type)
    const via = str(event.details.source) === "driver_app" ? " (driver app)" : ""
    const kind = str(changes.kind)
    return { collection: "operational_events", recordId, at: when(changes.occurred_at) ?? event.recordedAt,
      who: `${actor.kind === "system" ? "System" : actor.role === "driver" ? "Driver" : actor.name}${via}`,
      what: `${humanize(event.command.replaceAll(".", " "))}${kind ? ` (${label(kind).toLowerCase()})` : ""}` }
  }
  const message = bundle.messages.find((entry) => entry.id === recordId)
  if (message && (!collection || collection === "messages")) {
    const author = bundle.dir.resolve(message.details.author_id, message.authorType)
    const name = str(message.details.author_name_snapshot) ?? (author.role === "driver" ? "Driver" : author.name)
    return { collection: "messages", recordId, at: message.authoredAt, who: name, what: `“${short(message.body)}”` }
  }
  const alert = bundle.alerts.find((entry) => entry.id === recordId)
  if (alert && (!collection || collection === "alerts")) {
    return { collection: "alerts", recordId, at: alert.triggeredAt, who: "Alert", what: short(alert.summary) }
  }
  for (const [name, list] of Object.entries(bundle.related)) {
    if (collection && collection !== name) continue
    const row = list?.find((entry) => entry.id === recordId)
    if (row) return describeRelated(name, row.id, row.details)
  }
  return null
}

function describeRelated(collection: string, recordId: string, d: Record<string, unknown>): SourceRef {
  const base = { collection, recordId }
  switch (collection) {
    case "tracking_observations": {
      const km = num(d.distance_remaining_km)
      const eta = str(d.estimated_delivery_at)
      return { ...base, who: "Driver app", at: when(d.observed_at),
        what: `Position${d.location_quality === "COARSE" ? " (approximate)" : ""}${km === null ? "" : `, ${km} km to go`}${eta ? `, ETA ${fmtDateTime(eta)}` : ""}` }
    }
    case "travel_options": {
      const provider = str(d.provider)
      const price = num(d.quote_cents)
      const status = str(d.status)
      return { ...base, who: `${provider ?? "Travel"} ${status === "SOLD_OUT" ? "availability check" : "quote"}`, at: when(d.checked_at),
        what: `${label(str(d.kind)) || "Travel"} departing ${fmtDateTime(str(d.departure_at))}: ${status === "SOLD_OUT" ? "sold out"
          : `${price === null ? "quoted" : `quoted at ${fmtMoney(price, str(d.currency))}`}, not booked`}` }
    }
    case "travel_reservations":
      return { ...base, who: `${label(str(d.kind)) || "Travel"} booking`, at: when(d.booked_at),
        what: `Booked${str(d.departure_at) ? `, departs ${fmtDateTime(str(d.departure_at))}` : ""}${str(d.check_in_cutoff_at) ? `, check-in closes ${fmtDateTime(str(d.check_in_cutoff_at))}` : ""}` }
    case "ferry_terminal_events":
      return { ...base, who: "Ferry terminal", at: when(d.occurred_at), what: label(str(d.kind) ?? str(d.event_type)) || "Terminal event" }
    case "incidents":
      return { ...base, who: "Driver report", at: when(d.opened_at),
        what: `${label(str(d.kind)) || "Incident"}${str(d.reported_symptom) ? `: ${short(String(d.reported_symptom))}` : ""}` }
    case "work_assignments": {
      const positioning = (d.positioning ?? null) as Record<string, unknown> | null
      if (positioning?.assessment === "DRIVER_REPORTED_UNWORKABLE") {
        return { ...base, who: "Driver", at: when(positioning.driver_reported_at),
          what: `Can't reach the next pickup${str(positioning.next_pickup_city) ? ` in ${positioning.next_pickup_city}` : ""} in time` }
      }
      return { ...base, who: "Dispatch", at: when(d.accepted_at) ?? when(d.assigned_at), what: `Driver assignment ${label(str(d.status)).toLowerCase()}` }
    }
    case "time_windows":
      return { ...base, who: `${label(str(d.purpose)) || "Time window"} (${windowSource(str(d.source))})`, at: null,
        what: fmtRange(str(d.start_at), str(d.end_at), str(d.timezone)) }
    default:
      return { ...base, who: humanize(collection), what: humanize(str(d.kind) ?? str(d.status) ?? collection),
        at: when(d.observed_at) ?? when(d.recorded_at) ?? when(d.occurred_at) ?? when(d.created_at) ?? when(d.opened_at) }
  }
}

function sourcesOf(bundle: Bundle, check: TriageCheck): SourceRef[] {
  return check.evidence.map((entry) => {
    const found = describeRecord(bundle, entry.recordId, entry.collection)
    return found ? { ...found, at: found.at ?? entry.timestamp } : {
      collection: entry.collection, recordId: entry.recordId, at: entry.timestamp, who: humanize(entry.collection), what: "Record",
    }
  })
}

/** The agent's reading of one failed rule, in plain words. Never stated as certain. */
export function readingFor(check: TriageCheck): string {
  switch (check.rule) {
    case "safety_stop": return "The car may not be safe to drive. A person needs to decide on recovery."
    case "ferry_cutoff": return `The driver may miss the ferry check-in${check.deadline ? ` at ${fmtDateTime(check.deadline.at)}` : ""}.`
    case "travel_sold_out": return "The planned crossing is sold out and nothing replaces it yet."
    case "positioning_risk": return "The driver probably can't reach the next pickup in time."
    case "tracking_missing": return "The driver app may be off: no position since the pickup."
    case "tracking_stale": return "The last known position is too old to rely on."
    case "eta_vs_promise": return /after the selected promise end/.test(check.detail)
      ? "The car will probably arrive after the delivery promise."
      : "The car may arrive at the very end of the delivery promise, with no margin."
    case "progress_plateau": return "The car may have stopped: the distance left has not changed."
    default: return humanize(check.rule)
  }
}

const SUGGESTIONS: Partial<Record<Rule, string>> = {
  safety_stop: "A person calls the driver and the dealer and decides on recovery.",
  ferry_cutoff: "Call the driver now and, if needed, ask the ferry operator about a later crossing.",
  travel_sold_out: "Choose a replacement crossing. A person approves the cost before anything is booked.",
  positioning_risk: "Find another driver for the pickup, or agree a later pickup time with the site and the customer.",
  tracking_missing: "Ask the driver where they are and to switch the app back on.",
  tracking_stale: "Ask the driver for their current position.",
  eta_vs_promise: "Check the arrival time with the driver and prepare a customer update.",
  progress_plateau: "Ask the driver whether they have stopped and why.",
}

const UNKNOWN_SUBJECTS: Partial<Record<Rule, string>> = {
  safety_stop: "Safety situation",
  tracking_missing: "Driver location now",
  tracking_stale: "How fresh the position is",
  eta_vs_promise: "Arrival time against the promise",
  progress_plateau: "Whether the car is still moving",
  positioning_risk: "Whether the driver can reach the next pickup",
}

function hoursAgo(at: string | null, now: string | null): string | null {
  if (!at || !now) return null
  const hours = (Date.parse(now) - Date.parse(at)) / 3_600_000
  return Number.isFinite(hours) ? (hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`) : null
}

export function caseStatements(bundle: Bundle, proposal?: unknown): CaseStatements {
  const { checks } = evaluateTriage(bundle)
  const now = bundle.snapshotAt
  const relevant = checks.filter((check) => check.outcome !== "not_applicable" && check.rule !== "tracking_fresh")
  const failed = relevant.filter((check) => check.outcome === "fail")

  // Facts: every record the checks rest on, newest first, once each.
  const facts = new Map<string, FactStatement>()
  for (const check of relevant) for (const source of sourcesOf(bundle, check)) {
    facts.set(`${source.collection}:${source.recordId}`, { kind: "fact", source })
  }
  const factList = [...facts.values()].sort((a, b) => (b.source.at ?? "").localeCompare(a.source.at ?? ""))

  const readings: ReadingStatement[] = failed.map((check) => ({ kind: "reading", text: readingFor(check), basedOn: sourcesOf(bundle, check) }))

  // Unknowns: where the driver is now, plus every check the records could not settle.
  const unknowns: UnknownStatement[] = []
  const stale = checks.find((check) => check.rule === "tracking_stale")
  const missing = checks.find((check) => check.rule === "tracking_missing")
  if (missing?.outcome === "fail") {
    const pickup = sourcesOf(bundle, missing)[0]
    unknowns.push({ kind: "unknown", subject: "Driver location now", basedOn: pickup ? [pickup] : [],
      note: `no position since the pickup${pickup?.at ? ` ${hoursAgo(pickup.at, now)} ago` : ""}` })
  } else if (stale?.outcome === "fail") {
    const last = sourcesOf(bundle, stale)[0]
    unknowns.push({ kind: "unknown", subject: "Driver location now", basedOn: last ? [last] : [],
      note: last?.at ? `last position ${hoursAgo(last.at, now)} old` : null })
  }
  for (const incident of bundle.related.incidents ?? []) {
    if (incident.details.location_verified === false && !["RESOLVED", "CLOSED"].includes(String(incident.details.status))) {
      const source = describeRelated("incidents", incident.id, incident.details)
      unknowns.push({ kind: "unknown", subject: "Exact place the car stopped", basedOn: [source],
        note: str(incident.details.reported_stop_text) ? `the driver's description is not verified` : null })
    }
  }
  for (const check of relevant.filter((entry) => entry.outcome === "unknown")) {
    const subject = UNKNOWN_SUBJECTS[check.rule]
    if (subject && !unknowns.some((entry) => entry.subject === subject)) {
      unknowns.push({ kind: "unknown", subject, note: null, basedOn: sourcesOf(bundle, check) })
    }
  }

  const suggestions = [...new Set(failed.map((check) => SUGGESTIONS[check.rule]).filter((text): text is string => !!text))]
    .map((text): SuggestionStatement => ({ kind: "suggestion", text }))

  const proposalSources: Record<string, SourceRef | null> = {}
  const findings = proposal && typeof proposal === "object" && Array.isArray((proposal as Record<string, unknown>).investigation_summary)
    ? (proposal as { investigation_summary: unknown[] }).investigation_summary : []
  for (const finding of findings) {
    const ids = finding && typeof finding === "object" && Array.isArray((finding as Record<string, unknown>).source_event_ids)
      ? (finding as { source_event_ids: unknown[] }).source_event_ids : []
    for (const id of ids) if (typeof id === "string") proposalSources[id] = describeRecord(bundle, id)
  }

  return { facts: factList, readings, unknowns, suggestions, proposalSources }
}

/** One triage check in plain words, with the records it rests on. */
export type CheckLine = { rule: Rule; outcome: TriageCheck["outcome"]; text: string; sources: SourceRef[] }
export type DeliveryChecks = { summary: string; checks: CheckLine[] }

const CHECK_WORDS: Partial<Record<Rule, Partial<Record<TriageCheck["outcome"], string>>>> = {
  safety_stop: { pass: "no safety stop", fail: "safety stop open", unknown: "safety: not known" },
  ferry_cutoff: { pass: "ferry check-in confirmed", fail: "ferry check-in at risk" },
  travel_sold_out: { pass: "replacement travel booked", fail: "travel sold out" },
  positioning_risk: { fail: "driver can't reach the next pickup", unknown: "next pickup: not known" },
  tracking_missing: { fail: "no position since pickup", unknown: "position: not known" },
  tracking_stale: { pass: "tracking fresh", fail: "position out of date", unknown: "tracking: not known" },
  eta_vs_promise: { pass: "ETA inside promise", fail: "ETA at or past the promise", unknown: "ETA: not known" },
  progress_plateau: { pass: "car making progress", fail: "car not moving", unknown: "progress: not known" },
  other_desk: { not_applicable: "handled by another desk" },
}

/** The checks for the All deliveries list: a one-line summary and every check with its sources. */
export function deliveryChecks(bundle: Bundle): DeliveryChecks {
  const { checks } = evaluateTriage(bundle)
  const shown = checks.filter((check) => check.rule !== "tracking_fresh"
    && (check.outcome !== "not_applicable" || check.rule === "other_desk"))
  const lines: CheckLine[] = shown.map((check) => ({ rule: check.rule, outcome: check.outcome,
    text: check.outcome === "fail" ? readingFor(check) : CHECK_WORDS[check.rule]?.[check.outcome] ?? humanize(check.rule),
    sources: sourcesOf(bundle, check) }))
  const rank = { fail: 0, unknown: 1, pass: 2, not_applicable: 3 }
  const words = [...shown].sort((a, b) => rank[a.outcome] - rank[b.outcome])
    .map((check) => CHECK_WORDS[check.rule]?.[check.outcome]).filter((word): word is string => !!word)
  return { summary: words.length ? [...new Set(words)].slice(0, 3).join(", ") : "nothing to check at this stage", checks: lines }
}
