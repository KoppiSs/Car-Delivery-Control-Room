// An open safety stop (red warning light): a VEHICLE_WARNING incident or a SAFETY_STOP alert that
// triage counts as open. The car stays put. The proposal model is told the domain rule, and the
// guard (lib/proposal-guard.ts) refuses any plan that has the car driven on.

import type { Bundle } from "./present/bundle"
import { evaluateTriage, type TriageAssessment } from "./triage"

export type SafetyStop = { open: boolean; photoReceived: boolean }

/** Photo states that mean the dashboard photo is in our hands. Anything else (REQUESTED, missing) is not. */
const PHOTO_RECEIVED = new Set(["RECEIVED", "SUBMITTED", "ATTACHED", "REVIEWED", "VERIFIED", "ACCEPTED"])

export function safetyStopFor(bundle: Bundle, assessment: TriageAssessment = evaluateTriage(bundle)): SafetyStop {
  // Same reading as triage's safety check, so the table, the card and the model agree.
  const open = assessment.checks.some((check) => check.rule === "safety_stop" && check.outcome === "fail")
  const incidents = bundle.related.incidents ?? []
  const photoReceived = incidents.some((row) => row.details.kind === "VEHICLE_WARNING"
    && PHOTO_RECEIVED.has(String(row.details.warning_photo_status ?? "").toUpperCase()))
  return { open, photoReceived }
}

/** The domain rule added to the proposal instructions when the order has an open safety stop. */
export function safetyRule(stop: SafetyStop): string {
  return [
    "SAFETY RULE: this order has an open safety stop (red warning light).",
    "The car stays where it is. Never suggest that the driver continues, resumes or drives on, and never ask whether the driver can or may drive.",
    stop.photoReceived
      ? "The dashboard warning photo has been received."
      : "The dashboard warning photo has not been received: the next step is to get it from the driver.",
    stop.photoReceived
      ? "The next step is to ask the customer (the dealer) whether they send roadside assistance or want the car towed. A person approves that message before it is sent."
      : "After the photo, ask the customer (the dealer) whether they send roadside assistance or want the car towed. A person approves that message before it is sent.",
    "The delivery will be late.",
  ].join(" ")
}
