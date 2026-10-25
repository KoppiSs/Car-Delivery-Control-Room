// Money decisions are the operator's, not the system's. For a case that will cost extra
// (sold-out travel, a ferry connection at risk, a driver who needs repositioning), this
// builds the choices from the order's own quotes only: "Reliable" (best keeps the promise,
// whatever it costs) and "Lower cost" (cheapest still possible, even if later). It never
// invents an option or a price: a missing price is "Cost not known", a missing alternative is said so.

import { chosenWindows } from "./present/attention"
import { num, rows, str, type Bundle, type RelatedRow } from "./present/bundle"
import { label } from "./present/labels"
import { fmtLocal, zoneCity } from "./present/time"
import { evaluateTriage } from "./triage"
import { readCurrentAssignments } from "./triage-read"

/** Problems that can only be solved by spending money on travel. */
const COST_SIGNALS = new Set(["FERRY_SOLD_OUT", "FERRY_CONNECTION_RISK", "POSITIONING_AT_RISK", "DRIVER_AVAILABILITY_RISK"])
const COST_RULES = new Set(["travel_sold_out", "ferry_cutoff", "positioning_risk"])
/** The assigned driver cannot make the pickup: the first answers are internal (another driver, driver travel, a later pickup). */
const DRIVER_SIGNALS = new Set(["POSITIONING_AT_RISK", "DRIVER_AVAILABILITY_RISK"])
/** Records that show another driver has confirmed or said they are available. Views and passes do not count. */
const DRIVER_YES = new Set(["ACCEPT", "ACCEPTED", "CONFIRMED", "AVAILABLE"])

export type OptionLabel = "reliable" | "lower_cost" | "only" | "best" | "driver_swap" | "move_pickup"

export type CostOption = {
  id: string
  kind: "travel" | "driver_swap" | "move_pickup"
  /** "Reliable" / "Lower cost" between two quotes; "Only option" when the data holds one. */
  labels: OptionLabel[]
  what: string
  costCents: number | null
  currency: string | null
  /** "€387.00 · Quoted, not booked" or "Cost not known". */
  costText: string
  arrivesAt: string
  /** What the arrival is compared with: the delivery promise for the car, the pickup slot for a driver's own travel. */
  target: { label: string; at: string } | null
  /** "arrives Sun 25 Oct 18:00, 2 days before the promise ends" */
  arrivalText: string
  meetsTarget: boolean | null
  customerMustAgree: boolean
  agreementText: string
}

export type CostOptions = {
  reason: string
  options: CostOption[]
  /** Set when the data holds a single possible travel option: say so, and what else is not on file. */
  onlyOne: { note: string; missing: string } | null
  /** Options the case could have but the data does not support, said in words ("no quote on file"). */
  notOnFile: string[]
  /** "Recommended: …" on the Reliable option, for key accounts only. */
  recommendation: { optionId: string; text: string } | null
  keyAccount: boolean
}

/** "Thu 22 Oct 12:00 CEST": always with the zone, since pickup and delivery can be in different zones. */
const dayTime = (at: string, zone: string | null) => fmtLocal(at, zone)
/** "pickup site time (Berlin)" */
const zoneNote = (zone: string | null, where: string) => zone && zone !== "UTC" ? ` (${where} time, ${zoneCity(zone)})` : ""

function gapText(minutes: number): string {
  const value = Math.abs(minutes)
  if (value >= 48 * 60) return `${Math.round(value / (24 * 60))} days`
  if (value >= 60) return `${Math.round(value / 60)} h`
  return `${Math.round(value)} min`
}

function money(cents: number, currency: string | null): string {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency ?? "EUR" }).format(cents / 100) }
  catch { return `${(cents / 100).toFixed(2)} ${currency ?? ""}`.trim() }
}

/** The cost choices for this order at business time `now`, or null when the case involves no extra cost or no quote. */
export function costOptions(bundle: Bundle, now: Date): CostOptions | null {
  if (["DELIVERED", "CANCELLED"].includes(bundle.order.status.toUpperCase())) return null
  const failed = evaluateTriage(bundle).checks.filter((check) => check.outcome === "fail" && COST_RULES.has(check.rule))
  const alerts = bundle.alerts.filter((alert) => (alert.status === "OPEN" || alert.status === "ACKNOWLEDGED") && COST_SIGNALS.has(alert.signal))
  if (!failed.length && !alerts.length) return null
  const driverCase = failed.some((check) => check.rule === "positioning_risk") || alerts.some((alert) => DRIVER_SIGNALS.has(alert.signal))

  const assignments = new Set(readCurrentAssignments(bundle).map((row) => row.id))
  const quotes = rows(bundle, "travel_options").filter((row) => !str(row.details.assignment_id) || !assignments.size
    || assignments.has(String(row.details.assignment_id)))
  // A sold-out crossing is replaced by the same kind of travel; otherwise every quote counts.
  const soldOut = quotes.find((row) => row.details.status === "SOLD_OUT")
  const sameKind = soldOut ? quotes.filter((row) => row.details.kind === soldOut.details.kind) : quotes
  const possible = sameKind.filter((row) => row.details.status === "AVAILABLE_QUOTE" && str(row.details.arrival_at)
    && Date.parse(String(row.details.departure_at ?? row.details.arrival_at)) > now.getTime()
    && (!str(row.details.check_in_cutoff_at) || Date.parse(String(row.details.check_in_cutoff_at)) > now.getTime()))
  if (!possible.length && !driverCase) return null

  const windows = chosenWindows(bundle)
  // Times at the pickup end in the pickup site's zone; the car's arrival in the delivery zone.
  const pickupZone = windows.pickupSlot?.zone ?? windows.promise?.zone ?? null
  const deliveryZone = windows.promise?.zone ?? pickupZone
  const reason = soldOut ? `The planned ${label(str(soldOut.details.kind)).toLowerCase() || "travel"} is sold out`
    : driverCase ? "The assigned driver may not make the pickup in time"
    : alerts[0] ? label(alerts[0].signal) : "The current plan needs paid travel"

  const describe = (row: RelatedRow): Omit<CostOption, "labels"> => {
    const d = row.details
    const kind = label(str(d.kind)).toLowerCase() || "travel"
    const carTravel = d.kind === "FERRY"
    // A ferry carries the car, so it is measured against the delivery promise; a train or flight
    // carries the driver to the pickup, so it is measured against the pickup slot.
    const target = carTravel
      ? windows.promise?.end ? { label: "the promise ends", at: windows.promise.end } : null
      : windows.pickupSlot?.start ? { label: "the pickup slot starts", at: windows.pickupSlot.start } : null
    const arrivesAt = String(d.arrival_at)
    const gap = target ? (Date.parse(target.at) - Date.parse(arrivesAt)) / 60_000 : null
    const meetsTarget = gap === null ? null : gap >= 0
    const cents = num(d.quote_cents)
    const who = carTravel ? "arrives" : "driver arrives"
    const zone = carTravel ? deliveryZone : pickupZone
    return {
      id: row.id, kind: "travel",
      what: `${str(d.provider) ? `${d.provider} ` : ""}${kind} departing ${dayTime(String(d.departure_at), pickupZone)}${str(d.capacity_note) ? ` (${d.capacity_note})` : ""}`,
      costCents: cents, currency: str(d.currency),
      costText: cents === null ? "Cost not known" : `${money(cents, str(d.currency))} · Quoted, not booked`,
      arrivesAt, target,
      arrivalText: gap === null ? `${who} ${dayTime(arrivesAt, zone)}; nothing on file to compare it with`
        : gap >= 0 ? `${who} ${dayTime(arrivesAt, zone)}, ${gapText(gap)} before ${target!.label}`
        : `${who} ${dayTime(arrivesAt, zone)}, ${gapText(gap)} after ${target!.label}`,
      meetsTarget,
      customerMustAgree: meetsTarget === false,
      agreementText: meetsTarget === false ? (carTravel ? "The customer must agree a new delivery window" : "The pickup moves: the site and the customer must agree")
        : meetsTarget === null ? "Whether the customer must agree is not known" : "No customer agreement needed",
    }
  }

  // Reliable: keeps the target, earliest arrival first; if none keeps it, the least late.
  const byArrival = [...possible].sort((a, b) => Date.parse(String(a.details.arrival_at)) - Date.parse(String(b.details.arrival_at)))
  const reliable = byArrival[0] ?? null
  // Lower cost: the cheapest still possible with a known price.
  const priced = possible.filter((row) => num(row.details.quote_cents) !== null)
    .sort((a, b) => num(a.details.quote_cents)! - num(b.details.quote_cents)! || Date.parse(String(a.details.arrival_at)) - Date.parse(String(b.details.arrival_at)))
  const cheapest = priced[0] ?? null

  // One option is "Only option"; two different ones are "Reliable" and "Lower cost".
  const options: CostOption[] = !reliable ? []
    : cheapest && cheapest.id !== reliable.id
      ? [{ ...describe(reliable), labels: ["reliable"] }, { ...describe(cheapest), labels: ["lower_cost"] }]
      // Several quotes where one is both earliest and cheapest: "Earliest and cheapest", not "Only option".
      : [{ ...describe(reliable), labels: [possible.length > 1 ? "best" : "only"] }]
  const notOnFile: string[] = []
  const kind = label(str((soldOut ?? reliable)?.details.kind)).toLowerCase() || "travel"
  const onlyOne = possible.length === 1 && !driverCase
    ? { note: "Only one option found in the data", missing: `Wait for a later ${kind === "ferry" ? "sailing" : kind}: no quote on file` }
    : options.length === 1 && possible.length > 1 ? { note: `${possible.length} quotes on file; this one is both the earliest and the cheapest`, missing: "" }
    : options.length === 1 ? { note: "Only one option found in the data", missing: "" } : null

  if (driverCase) {
    // Another driver: only one the records show has confirmed or is available, never a guess.
    const assigned = new Set(readCurrentAssignments(bundle).map((row) => str(row.details.driver_id)))
    const confirmed = [...rows(bundle, "market_offer_exposures"), ...rows(bundle, "market_offer_demand_signals")].find((row) =>
      str(row.details.driver_id) && !assigned.has(str(row.details.driver_id))
      && (DRIVER_YES.has(String(row.details.status ?? "")) || DRIVER_YES.has(String(row.details.kind ?? "")) || DRIVER_YES.has(String(row.details.response ?? ""))))
    if (confirmed) {
      const name = bundle.dir.driverName(confirmed.details.driver_id) ?? "Another driver"
      options.unshift({ id: `swap:${confirmed.id}`, kind: "driver_swap", labels: ["driver_swap"],
        what: `Swap to ${name}, who confirmed in the records`, costCents: null, currency: null, costText: "Cost not known",
        arrivesAt: windows.pickupSlot?.start ?? "", target: windows.pickupSlot?.start ? { label: "the pickup slot starts", at: windows.pickupSlot.start } : null,
        arrivalText: "keeps the current pickup slot", meetsTarget: true, customerMustAgree: false, agreementText: "No customer agreement needed" })
    } else notOnFile.push("Swap to another driver: no driver on file has confirmed or is available")
    if (!possible.length) notOnFile.push("Book driver travel: no quote on file")
    const positioning = readCurrentAssignments(bundle).map((row) => row.details.positioning as Record<string, unknown> | undefined).find((entry) => entry)
    const earliest = str(positioning?.driver_reported_earliest_departure_at) ?? str(positioning?.earliest_positioning_departure_at)
    options.push({ id: "move_pickup", kind: "move_pickup", labels: ["move_pickup"],
      what: `Move the pickup time${earliest ? `; the driver can start travelling from ${dayTime(earliest, pickupZone)}${zoneNote(pickupZone, "pickup site")}` : ""}`,
      costCents: null, currency: null, costText: "No travel booked", arrivesAt: "", target: null,
      arrivalText: windows.pickupSlot?.start ? `replaces the pickup slot ${dayTime(windows.pickupSlot.start, pickupZone)}; the new time is not agreed yet` : "the new time is not agreed yet",
      meetsTarget: false, customerMustAgree: true, agreementText: "The pickup site, then the customer, must agree the new time" })
  }
  const keyAccount = bundle.customer.tier === "key"
  const recommendable = options.find((option) => option.labels.some((name) => name === "reliable" || name === "only" || name === "best"))
  return {
    reason, options, onlyOne, notOnFile, keyAccount,
    recommendation: keyAccount && recommendable && recommendable.kind === "travel"
      ? { optionId: recommendable.id, text: "Recommended: on-time delivery matters most for key accounts" } : null,
  }
}
