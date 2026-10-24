import { NOW, type Case, type Deadline, type Evidence, type Fact, type Route } from "./case"
import { obj, rows, str, type Bundle, type RelatedRow } from "./present/bundle"
import {
  HOUR_MS, knownBySnapshot, readAppPositions, readCurrentAssignments, readDeliveryPromise,
  readDistance, readDriverActivity, readDriverDelayMessages, readGateCheckIn, readIsMoving, readPickupEvents,
  readReplacementBookings, readTravel, time,
} from "./triage-read"

// Rule diagnostics stay separate from the shared Case: its route is a journey.
export type Classification = Route
export type Rule = "safety_stop" | "ferry_cutoff" | "travel_sold_out" | "positioning_risk"
  | "tracking_missing" | "tracking_stale" | "eta_vs_promise" | "progress_plateau" | "tracking_fresh" | "other_desk"
export type { Evidence, Deadline } from "./case"
export type TriageCheck = {
  rule: Rule
  passed: boolean
  outcome: "pass" | "fail" | "unknown" | "not_applicable"
  detail: string
  evidence: Evidence[]
  classification?: Exclude<Classification, "fine">
  deadline?: Deadline
}
export type TriageAssessment = {
  orderId: string
  reference: string
  classification: Classification
  status: "fine" | "agent_working" | "needs_person"
  priority: number
  headline: string
  deadline: Deadline | null
  checks: TriageCheck[]
}

const ROUTE_RANK = { fine: 0, agent_investigate: 1, person_now: 2 }
const OTHER_DESK = new Set(["PROOF_REVIEW", "PICKUP_PROOF_REJECTED", "INVOICE_REFERENCE_QUERY", "CONDITION_CLAIM",
  "CONDITION_CLAIM_REVIEW", "RELEASE_DOCUMENT_UNCLEAR", "SITE_ACCESS_UNCONFIRMED", "SITE_ACCESS_CONFLICT", "DELIVERY_ACCESS_RISK"])
const activeAlert = (status: string) => status === "OPEN" || status === "ACKNOWLEDGED"
const evidence = (collection: string, recordId: string, timestamp: unknown): Evidence => ({
  collection, recordId, timestamp: time(timestamp) === null ? null : String(timestamp),
})
const fromRow = (collection: string, row: RelatedRow, at: unknown) => evidence(collection, row.id, at)
const deadline = (collection: string, row: RelatedRow | null, field: string, label: string): Deadline | undefined =>
  row && time(row.details[field]) !== null ? { collection, recordId: row.id, at: String(row.details[field]), label } : undefined

export function issuePriority(check: Pick<TriageCheck, "rule" | "deadline">): number {
  if (check.rule === "safety_stop") return 100
  const at = time(check.deadline?.at)
  if (at === null) return 20
  const remaining = at - Date.parse(NOW)
  return remaining < 3 * HOUR_MS ? 80 : remaining < 24 * HOUR_MS ? 50 : 20
}

/** Every rule runs. Missing optional evidence is unknown, never a passing check;
 * only established rule failures affect classification. No writes or model calls. */
export function evaluateTriage(bundle: Bundle): TriageAssessment {
  const now = Date.parse(NOW)
  const checks: TriageCheck[] = []
  function add(rule: Rule, outcome: TriageCheck["outcome"], detail: string, sources: Evidence[] = [],
    classification?: TriageCheck["classification"], due?: Deadline) {
    checks.push({ rule, outcome, passed: outcome === "pass", detail, evidence: sources,
      ...(classification ? { classification } : {}), ...(due ? { deadline: due } : {}) })
  }
  const warningCandidates = rows(bundle, "incidents").filter(({ details: d }) => d.kind === "VEHICLE_WARNING")
  const openIncidents = warningCandidates.filter(({ details: d }) => knownBySnapshot(d.opened_at)
    && (!["RESOLVED", "CLOSED", "CANCELLED"].includes(String(d.status)) || (time(d.resolved_at) !== null && time(d.resolved_at)! > now))
    && (d.resolved_at == null || (time(d.resolved_at) !== null && time(d.resolved_at)! > now)))
  const stops = bundle.alerts.filter((alert) => alert.signal === "SAFETY_STOP" && knownBySnapshot(alert.triggeredAt)
    && (activeAlert(alert.status) || (time(alert.details.resolved_at) !== null && time(alert.details.resolved_at)! > now)))
  const safety = [...openIncidents.map((row) => fromRow("incidents", row, row.details.opened_at)),
    ...stops.map((alert) => evidence("alerts", alert.id, alert.triggeredAt))]
  const unknownSafety = warningCandidates.some(({ details: d }) => time(d.opened_at) === null)
    || bundle.alerts.some((alert) => alert.signal === "SAFETY_STOP" && activeAlert(alert.status) && time(alert.triggeredAt) === null)
  add("safety_stop", safety.length ? "fail" : unknownSafety ? "unknown" : "pass", safety.length
    ? "Open vehicle-warning report or safety-stop signal: a person must review recovery; diagnosis remains unverified."
    : unknownSafety ? "Safety evidence has no valid source time; its availability at NOW cannot be established."
      : "No open VEHICLE_WARNING incident or active SAFETY_STOP alert at the snapshot.", safety, safety.length ? "person_now" : undefined)

  const assignments = readCurrentAssignments(bundle)
  const travel = readTravel(bundle)
  const completed = ["DELIVERED", "CANCELLED"].includes(bundle.order.status.toUpperCase())
  let ferryCount = 0
  for (const booking of travel.reservations) {
    const d = booking.details
    const cutoff = time(d.check_in_cutoff_at)
    if (completed || d.kind !== "FERRY" || d.status !== "BOOKED" || cutoff === null || cutoff < now || cutoff - now > 3 * HOUR_MS) continue
    ferryCount++
    const gateIds = readGateCheckIn(bundle, booking)
    const assignment = assignments.find((entry) => entry.id === d.assignment_id)!
    const reports = readDriverDelayMessages(bundle, assignment, str(d.booked_at) ?? undefined)
    const sources = [fromRow("travel_reservations", booking, d.booked_at),
      ...reports.map((message) => evidence("messages", message.id, message.authoredAt))]
    for (const id of gateIds) {
      const gate = travel.gateEvents.find((entry) => entry.id === id)
      const event = bundle.events.find((entry) => entry.id === id)
      sources.push(evidence(gate ? "ferry_terminal_events" : "operational_events", id, gate?.details.occurred_at ?? event?.recordedAt))
    }
    add("ferry_cutoff", gateIds.length ? "pass" : "fail", gateIds.length ? "Accepted gate check-in matches this ferry booking."
      : `Booked ferry check-in closes ${d.check_in_cutoff_at} (${((cutoff - now) / HOUR_MS).toFixed(2)} h away, within 3 h); no accepted gate check-in${reports.length ? "; driver reports terminal delay" : "; no explicit driver delay report"}.`,
      sources, gateIds.length ? undefined : reports.length ? "person_now" : "agent_investigate",
      deadline("travel_reservations", booking, "check_in_cutoff_at", "Ferry check-in cutoff"))
  }
  if (!ferryCount) add("ferry_cutoff", "not_applicable", "No current booked ferry has a check-in cutoff within the next 3 h.")

  const sold = completed ? [] : travel.options.filter((option) => option.details.status === "SOLD_OUT")
  for (const option of sold) {
    const replacement = readReplacementBookings(bundle, option)
    add("travel_sold_out", replacement.length ? "pass" : "fail", replacement.length
      ? "The current assignment has a booked replacement for this sold-out journey."
      : "Travel option for the current assignment is SOLD_OUT; no valid replacement booking. A quote is not a booking; a person must approve spending.",
      [fromRow("travel_options", option, option.details.checked_at), ...replacement.map((row) => fromRow("travel_reservations", row, row.details.booked_at))],
      replacement.length ? undefined : "person_now",
      deadline("travel_options", option, time(option.details.check_in_cutoff_at) === null ? "departure_at" : "check_in_cutoff_at", "Travel check-in or departure"))
  }
  if (!sold.length) add("travel_sold_out", "not_applicable", "No SOLD_OUT option for a current assignment.")

  let positioningCount = 0
  for (const assignment of completed ? [] : assignments) {
    const d = obj(assignment.details.positioning)
    if (!d || !["DRIVER_REPORTED_UNWORKABLE", "POSITIONING_NOT_EVIDENCED"].includes(String(d.assessment))) continue
    positioningCount++
    const start = time(d.next_pickup_start_at)
    if (start === null) { add("positioning_risk", "unknown", "Positioning assessment exists, but the next pickup time is missing or invalid."); continue }
    if (start < now || start - now > 48 * HOUR_MS) {
      add("positioning_risk", "not_applicable", "Positioning assessment is outside the next-48-hour pickup window."); continue
    }
    const reported = d.assessment === "DRIVER_REPORTED_UNWORKABLE"
    if (reported && !knownBySnapshot(d.driver_reported_at)) {
      add("positioning_risk", "unknown", "Driver-reported positioning assessment has no report available by the snapshot."); continue
    }
    const report = bundle.messages.find((message) => message.id === d.driver_report_message_id && message.authorType === "driver"
      && message.details.author_id === assignment.details.driver_id && knownBySnapshot(message.authoredAt))
    add("positioning_risk", "fail", reported ? "Driver reports positioning for the next pickup within 48 h is unworkable."
      : "Positioning for the next pickup within 48 h is not evidenced; the planned previous endpoint is not a current driver location.",
      [fromRow("work_assignments", assignment, reported ? d.driver_reported_at : assignment.details.accepted_at),
        ...(report ? [evidence("messages", report.id, report.authoredAt)] : [])], reported ? "person_now" : "agent_investigate",
      time(d.next_pickup_start_at) === null ? undefined : { collection: "work_assignments", recordId: assignment.id, at: String(d.next_pickup_start_at), label: "Next pickup" })
  }
  if (!positioningCount) add("positioning_risk", "not_applicable", "No current assignment has one of the two specified positioning-risk assessments.")

  const isMoving = readIsMoving(bundle)
  const positions = readAppPositions(bundle)
  const pickup = readPickupEvents(bundle)[0]
  const pickupAt = time(pickup ? obj(pickup.details.changes)?.occurred_at ?? pickup.recordedAt : null)
  const promise = readDeliveryPromise(bundle)
  const due = deadline("time_windows", promise, "end_at", "Selected customer delivery promise")
  const latest = positions[0]
  const latestEvidence = latest ? [fromRow("tracking_observations", latest, latest.details.observed_at)] : []
  const missing = isMoving && pickupAt !== null && now - pickupAt > HOUR_MS && positions.length === 0
  add("tracking_missing", !isMoving ? "not_applicable" : positions.length ? "pass" : pickupAt === null ? "unknown" : missing ? "fail" : "pass",
    !isMoving ? "Not applicable: no current moving journey." : positions.length ? `${positions.length} app observations available for the current journey.`
      : pickupAt === null ? "No app observations and no valid pickup event; the 60-minute threshold cannot be evaluated."
        : `Zero app observations; pickup occurred ${((now - pickupAt) / 60_000).toFixed(2)} min ago (must exceed 60 min).`,
    pickup ? [evidence("operational_events", pickup.id, obj(pickup.details.changes)?.occurred_at ?? pickup.recordedAt)] : latestEvidence,
    missing ? "agent_investigate" : undefined, due)

  const age = latest ? now - time(latest.details.observed_at)! : null
  const stale = isMoving && age !== null && age > 2 * HOUR_MS
  const freshDetail = latest ? `Last app observation ${latest.details.observed_at}, ${(age! / HOUR_MS).toFixed(2)} h old; uploaded ${latest.details.received_at}. Threshold: older than 2 h.`
    : "No available app position; freshness cannot be established."
  add("tracking_stale", !isMoving ? "not_applicable" : age === null ? "unknown" : stale ? "fail" : "pass",
    isMoving ? freshDetail : "Not applicable: order is not currently moving.", latestEvidence, stale ? "agent_investigate" : undefined, due)
  if (isMoving && latest && !stale) add("tracking_fresh", "pass", freshDetail, latestEvidence)

  const etaPosition = positions.find((position) => time(position.details.estimated_delivery_at) !== null)
  const eta = time(etaPosition?.details.estimated_delivery_at)
  const end = time(promise?.details.end_at)
  const margin = eta !== null && end !== null ? (end - eta) / 60_000 : null
  const etaRisk = isMoving && margin !== null && margin < 15
  add("eta_vs_promise", !isMoving ? "not_applicable" : margin === null ? "unknown" : etaRisk ? "fail" : "pass",
    !isMoving ? "Not applicable: no current moving journey." : margin === null ? "A valid app ETA and selected delivery promise are required; margin is unknown."
      : margin < 0 ? `Latest valid app ETA is ${Math.abs(margin).toFixed(2)} min after the selected promise end.`
        : `Latest valid app ETA has ${margin.toFixed(2)} min margin; less than 15 min requires investigation.`,
    [...(etaPosition ? [fromRow("tracking_observations", etaPosition, etaPosition.details.observed_at)] : []),
      ...(promise ? [fromRow("time_windows", promise, null)] : [])], etaRisk ? "agent_investigate" : undefined, due)

  const distances = positions.filter((position) => readDistance(position) !== null)
  const lastDistance = distances[0]
  const previous = lastDistance ? distances.find((position) => position.id !== lastDistance.id
    && position.details.assignment_id === lastDistance.details.assignment_id && position.details.segment_id === lastDistance.details.segment_id
    && time(position.details.observed_at)! < time(lastDistance.details.observed_at)!) : undefined
  const plateau = isMoving && !!previous && readDistance(previous) === readDistance(lastDistance)
  add("progress_plateau", !isMoving ? "not_applicable" : !previous ? "unknown" : plateau ? "fail" : "pass",
    !isMoving ? "Not applicable: no current moving journey." : !previous ? "Two chronological observations with valid km remaining on the same leg are required."
      : plateau ? `Last two valid distances both show ${readDistance(lastDistance)} km remaining.`
        : `Distance remaining changed from ${readDistance(previous)} to ${readDistance(lastDistance)} km.`,
    [lastDistance, previous].filter((row): row is RelatedRow => !!row).map((row) => fromRow("tracking_observations", row, row.details.observed_at)),
    plateau ? "agent_investigate" : undefined, due)

  const others = bundle.alerts.filter((alert) => activeAlert(alert.status) && OTHER_DESK.has(alert.signal) && knownBySnapshot(alert.triggeredAt))
  if (others.length) add("other_desk", "not_applicable", "Handled by another desk", others.map((alert) => evidence("alerts", alert.id, alert.triggeredAt)))
  const fired = checks.filter((check) => check.classification)
  const classification = fired.reduce<Classification>((best, check) => ROUTE_RANK[check.classification!] > ROUTE_RANK[best] ? check.classification! : best, "fine")
  // Routing and issue ordering are independent: keep all failures, and select
  // the headline/deadline from the highest-priority relevant issue.
  const strongest = [...fired].sort((a, b) => issuePriority(b) - issuePriority(a)
    || ROUTE_RANK[b.classification!] - ROUTE_RANK[a.classification!]
    || (time(a.deadline?.at) ?? Infinity) - (time(b.deadline?.at) ?? Infinity)
    || a.rule.localeCompare(b.rule) || a.evidence.map((entry) => entry.recordId).join().localeCompare(b.evidence.map((entry) => entry.recordId).join()))[0]
  return { orderId: bundle.order.id, reference: bundle.order.reference, classification,
    status: classification === "person_now" ? "needs_person" : classification === "agent_investigate" ? "agent_working" : "fine",
    priority: (strongest ? issuePriority(strongest) : 20) + (bundle.customer.tier === "key" ? 10 : 0),
    headline: strongest?.detail ?? (others.length ? "Handled by another desk" : "No in-scope transport rule fired; inspect checks for unknown evidence."),
    deadline: strongest?.deadline ?? null, checks }
}

export function evaluateBundles(bundles: Bundle[]): TriageAssessment[] {
  return bundles.map(evaluateTriage).sort((a, b) => a.orderId.localeCompare(b.orderId))
}

/** Read-only diagnostics; never overwrite B's persisted investigations. */
export async function assessAllOrders(): Promise<TriageAssessment[]> {
  const { loadBoardBundles } = await import("./present/load")
  const { bundles } = await loadBoardBundles()
  return evaluateBundles(bundles)
}

/** Facts are source statements/observations, not the rule engine's conclusions.
 * In particular, windows have no authored timestamp in this dataset: retain
 * their record-linked deadline, but do not fabricate a dated promise Fact. */
export function readFacts(bundle: Bundle): Fact[] {
  const facts: Fact[] = []
  function add(text: string, source: string, at: unknown, recordId: string) {
    if (knownBySnapshot(at)) facts.push({ text, source, at: String(at), recordId })
  }
  const latest = readAppPositions(bundle)[0]
  if (latest) {
    const km = readDistance(latest)
    const eta = str(latest.details.estimated_delivery_at)
    add(`Driver-app observation${km === null ? "" : `: ${km} km remaining`}${time(eta) === null ? "" : `; reported ETA ${eta}`}. Location remains unverified.`,
      "tracking_observations:driver_app", latest.details.observed_at, latest.id)
  }
  for (const event of readPickupEvents(bundle)) {
    add("Vehicle pickup recorded by the source.", `operational_events:${str(event.details.source) ?? "source unknown"}`,
      obj(event.details.changes)?.occurred_at ?? event.recordedAt, event.id)
  }
  for (const event of readDriverActivity(bundle).filter((entry) => entry.command === "expense.submitted")) {
    add("Driver expense submission recorded; approval and payment are not established.", "operational_events:expense.submitted", event.recordedAt, event.id)
  }
  const travel = readTravel(bundle)
  for (const option of travel.options) {
    add(`${str(option.details.kind) ?? "Travel"} option check returned ${str(option.details.status) ?? "unknown status"}; this is not a booking.`,
      "travel_options", option.details.checked_at, option.id)
  }
  for (const booking of travel.reservations.filter((entry) => entry.details.status === "BOOKED")) {
    add(`${str(booking.details.kind) ?? "Travel"} booking recorded; travel or boarding is not established by the booking.`,
      "travel_reservations", booking.details.booked_at, booking.id)
  }
  for (const incident of rows(bundle, "incidents").filter((entry) => entry.details.kind === "VEHICLE_WARNING")) {
    add(`Vehicle warning report opened${str(incident.details.reported_symptom) ? `: ${incident.details.reported_symptom}` : ""}; diagnosis is not established.`,
      "incidents", incident.details.opened_at, incident.id)
  }
  for (const alert of bundle.alerts.filter((entry) => entry.signal === "SAFETY_STOP")) {
    add(`Safety-stop signal raised: ${alert.summary}`, "alerts", alert.triggeredAt, alert.id)
  }
  for (const assignment of readCurrentAssignments(bundle)) {
    const positioning = obj(assignment.details.positioning)
    if (positioning?.assessment === "DRIVER_REPORTED_UNWORKABLE") {
      add("Assigned driver reports positioning for the next pickup is unworkable.", "work_assignments.positioning:driver_report",
        positioning.driver_reported_at, assignment.id)
    }
    for (const message of readDriverDelayMessages(bundle, assignment)) {
      add(`Driver report: ${message.body}`, "messages:driver", message.authoredAt, message.id)
    }
  }
  return [...new Map(facts.map((fact) => [`${fact.source}:${fact.recordId}`, fact])).values()]
    .sort((a, b) => time(b.at)! - time(a.at)! || a.source.localeCompare(b.source) || a.recordId.localeCompare(b.recordId))
}

export function triageBundle(bundle: Bundle): Case {
  const assessment = evaluateTriage(bundle)
  const from = bundle.places.get(bundle.order.pickupAddressId)
  const to = bundle.places.get(bundle.order.deliveryAddressId)
  const place = (value: typeof from) => value ? [value.city, value.country].filter(Boolean).join(", ") : "Place not recorded"
  return { id: assessment.orderId, reference: assessment.reference, status: assessment.status, priority: assessment.priority,
    headline: assessment.headline, route: `${place(from)} → ${place(to)}`, facts: readFacts(bundle), deadline: assessment.deadline,
    checks: assessment.checks.map(({ rule, passed, outcome, detail, evidence }) => ({ rule, passed, outcome, detail, evidence })) }
}

/** All orders, including healthy ones. This operation performs reads only and
 * keeps its classifications separate from B's stored agent/review state. */
export async function triageAll(): Promise<Case[]> {
  const { loadBoardBundles } = await import("./present/load")
  const { bundles } = await loadBoardBundles()
  return bundles.map(triageBundle).sort((a, b) => a.id.localeCompare(b.id))
}
