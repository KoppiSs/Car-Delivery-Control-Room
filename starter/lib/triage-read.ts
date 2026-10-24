import { NOW } from "./case"
import { finalDeliveryPoint, num, obj, rows, str, strings, type Bundle, type EventRow, type RelatedRow } from "./present/bundle"

export const HOUR_MS = 3_600_000

export function time(value: unknown): number | null {
  const result = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(result) ? result : null
}

/** Missing/invalid evidence times are unknown, not a substitute for NOW. */
export function knownBySnapshot(value: unknown): boolean {
  const at = time(value)
  return at !== null && at <= Date.parse(NOW)
}

function optionalTimeKnown(value: unknown): boolean {
  return value == null || knownBySnapshot(value)
}

const byId = (a: RelatedRow, b: RelatedRow) => a.id.localeCompare(b.id)

export function readCurrentAssignments(bundle: Bundle): RelatedRow[] {
  const activePlan = str(bundle.order.details.active_plan_id)
  const segments = rows(bundle, "transport_segments").filter((row) => row.details.plan_id === activePlan)
  const activeSegmentIds = new Set(segments.map((row) => row.id))
  return rows(bundle, "work_assignments").filter(({ details: d }) => ["ASSIGNED", "IN_PROGRESS"].includes(String(d.status))
    && optionalTimeKnown(d.accepted_at)
    && (!activeSegmentIds.size || strings(d.segment_ids).some((id) => activeSegmentIds.has(id))))
    .sort(byId)
}

function forAssignment(d: Record<string, unknown>, assignment: RelatedRow): boolean {
  return d.assignment_id ? d.assignment_id === assignment.id : strings(assignment.details.segment_ids).includes(String(d.segment_id))
}

/** Age uses observed_at. received_at only decides whether a late upload was
 * available by NOW; a fresh upload never refreshes an old observation. */
export function readAppPositions(bundle: Bundle, assignment?: RelatedRow): RelatedRow[] {
  const current = assignment ? [assignment] : readCurrentAssignments(bundle)
  return rows(bundle, "tracking_observations").filter(({ details: d }) => d.source === "driver_app"
    && d.location_quality !== "INFERRED" && knownBySnapshot(d.observed_at) && knownBySnapshot(d.received_at)
    && (!current.length || current.some((entry) => forAssignment(d, entry))))
    .sort((a, b) => time(b.details.observed_at)! - time(a.details.observed_at)! || byId(a, b))
}

export function readDeliveryPromise(bundle: Bundle): RelatedRow | null {
  const final = finalDeliveryPoint(bundle)
  const candidates = rows(bundle, "time_windows").filter(({ details: d }) => d.purpose === "CUSTOMER_DELIVERY_PROMISE"
    && d.is_selected === true && time(d.end_at) !== null).sort(byId)
  return candidates.find((row) => row.details.point_id === final?.id) ?? candidates[0] ?? null
}

export function readPickupEvents(bundle: Bundle, assignment?: RelatedRow): EventRow[] {
  const current = assignment ? [assignment] : readCurrentAssignments(bundle)
  const pointIds = new Set(rows(bundle, "transport_segments").filter((segment) =>
    current.some((entry) => strings(entry.details.segment_ids).includes(segment.id)))
    .map((segment) => str(segment.details.from_point_id)).filter((id): id is string => !!id))
  return bundle.events.filter((event) => event.command === "vehicle.picked_up" && knownBySnapshot(event.recordedAt)
    && knownBySnapshot(obj(event.details.changes)?.occurred_at ?? event.recordedAt)
    && (!current.length || current.some((entry) => forAssignment(obj(event.details.changes) ?? {}, entry)) || pointIds.has(event.targetId)))
    .sort((a, b) => time(obj(b.details.changes)?.occurred_at ?? b.recordedAt)!
      - time(obj(a.details.changes)?.occurred_at ?? a.recordedAt)! || a.id.localeCompare(b.id))
}

export function readIsMoving(bundle: Bundle): boolean {
  if (["DELIVERED", "CANCELLED"].includes(bundle.order.status.toUpperCase())) return false
  const pickedUp = readPickupEvents(bundle)[0]
  const delivered = bundle.events.filter((event) => event.command === "vehicle.delivered" && knownBySnapshot(event.recordedAt)
    && knownBySnapshot(obj(event.details.changes)?.occurred_at ?? event.recordedAt))
    .sort((a, b) => time(obj(b.details.changes)?.occurred_at ?? b.recordedAt)! - time(obj(a.details.changes)?.occurred_at ?? a.recordedAt)!)[0]
  if (pickedUp && (!delivered || time(obj(pickedUp.details.changes)?.occurred_at ?? pickedUp.recordedAt)!
    > time(obj(delivered.details.changes)?.occurred_at ?? delivered.recordedAt)!)) return true
  return bundle.order.status === "IN_TRANSIT" && bundle.order.lane === "moving"
}

export function readTravel(bundle: Bundle) {
  const assignments = new Set(readCurrentAssignments(bundle).map((row) => row.id))
  return {
    options: rows(bundle, "travel_options").filter(({ details: d }) => assignments.has(String(d.assignment_id)) && knownBySnapshot(d.checked_at)).sort(byId),
    reservations: rows(bundle, "travel_reservations").filter(({ details: d }) => assignments.has(String(d.assignment_id)) && knownBySnapshot(d.booked_at)).sort(byId),
    gateEvents: rows(bundle, "ferry_terminal_events").filter(({ details: d }) => knownBySnapshot(d.occurred_at)
      && knownBySnapshot(d.recorded_at)).sort(byId),
  }
}

export function readGateCheckIn(bundle: Bundle, reservation: RelatedRow): string[] {
  return [
    ...readTravel(bundle).gateEvents.filter(({ details: d }) => d.reservation_id === reservation.id
      && d.assignment_id === reservation.details.assignment_id && d.kind === "CHECK_IN_ACCEPTED").map((row) => row.id),
    ...bundle.events.filter((event) => event.command === "travel.check_in_confirmed" && event.targetId === reservation.id
      && event.details.source === "terminal_gate" && knownBySnapshot(event.recordedAt)).map((event) => event.id),
  ].sort()
}

/** A later booking must cover the same current assignment and kind of journey.
 * Explicit source-option links take precedence over schedule matching. */
export function readReplacementBookings(bundle: Bundle, option: RelatedRow): RelatedRow[] {
  const travel = readTravel(bundle)
  return travel.reservations.filter(({ details: d }) => {
    if (d.status !== "BOOKED" || d.assignment_id !== option.details.assignment_id || d.kind !== option.details.kind) return false
    if (d.source_option_id === option.id) return true
    const quoted = travel.options.find((row) => row.id === d.source_option_id)
    const departure = time(d.departure_at)
    const failedDeparture = time(option.details.departure_at)
    if (departure === null || failedDeparture === null || departure <= failedDeparture) return false
    if (quoted) return quoted.details.from_city === option.details.from_city && quoted.details.to_city === option.details.to_city
    // Ferry reservations name terminals rather than cities; do not guess that
    // two different terminal labels describe the same route.
    return !!str(d.from_city) && !!str(d.to_city) && d.from_city === option.details.from_city && d.to_city === option.details.to_city
  })
}

export function readDriverMessages(bundle: Bundle, assignment: RelatedRow) {
  const threads = new Set(bundle.conversations.filter((thread) => {
    const named = str(thread.details.assignment_id)
    const multiple = strings(thread.details.assignment_ids)
    return named === assignment.id || multiple.includes(assignment.id) || (!named && !multiple.length)
  }).map((thread) => thread.id))
  return bundle.messages.filter((message) => message.orderId === bundle.order.id && message.authorType === "driver"
    && message.details.author_id === assignment.details.driver_id && threads.has(message.conversationId)
    && knownBySnapshot(message.authoredAt))
    .sort((a, b) => time(b.authoredAt)! - time(a.authoredAt)! || a.id.localeCompare(b.id))
}

export function readDriverDelayMessages(bundle: Bundle, assignment: RelatedRow, since?: string) {
  const lowerBound = time(since)
  // Only explicit English terminal/travel delay reports are recognized. Other
  // languages or ambiguous text remain agent investigations, never diagnoses.
  const delay = /\b(?:i|we)\s+(?:(?:am|are|have been)\s+(?:still\s+)?(?:stuck|delayed|running late)|(?:cannot|can't)\s+reach)\b|\b(?:i'm|we're)\s+(?:still\s+)?(?:stuck|delayed|running late)\b|\bmay close before (?:i|we) reach\b|\bqueue\b.{0,60}\b(?:barely moved|not moving|hasn't moved)\b/i
  const travel = /\b(?:terminal|check[ -]?in|crossing|ferry)\b/i
  const denied = /\b(?:not delayed|no delay|not stuck|not running late)\b/i
  return readDriverMessages(bundle, assignment).filter((message) => (lowerBound === null || time(message.authoredAt)! >= lowerBound)
    && travel.test(message.body) && delay.test(message.body) && !denied.test(message.body))
}

export function readDriverActivity(bundle: Bundle, assignment?: RelatedRow) {
  const current = assignment ? [assignment] : readCurrentAssignments(bundle)
  const drivers = new Set(current.map((row) => str(row.details.driver_id)))
  return bundle.events.filter((event) => ["vehicle.picked_up", "vehicle.delivered", "expense.submitted"].includes(event.command)
    && knownBySnapshot(event.recordedAt) && event.details.actor_type === "driver" && drivers.has(str(event.details.actor_id)))
    .sort((a, b) => time(b.recordedAt)! - time(a.recordedAt)! || a.id.localeCompare(b.id))
}

export function readOrderContext(bundle: Bundle) {
  return { order: bundle.order, customer: bundle.customer, assignments: readCurrentAssignments(bundle),
    promise: readDeliveryPromise(bundle), moving: readIsMoving(bundle) }
}

export function readDistance(position: RelatedRow | undefined): number | null {
  const km = num(position?.details.distance_remaining_km)
  return km !== null && km >= 0 ? km : null
}
