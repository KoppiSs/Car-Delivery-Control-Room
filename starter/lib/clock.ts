// The single source of "now" for everything simulated in the Control Room.
// Never the computer's clock: the snapshot time (NOW, shared with triage),
// plus every recorded "Skip ahead" jump, plus a few minutes per simulated action.
// It is derived from stored records only, so it is the same for every viewer and survives a refresh.

import { randomUUID } from "node:crypto"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { NOW } from "./case"
import { db } from "./db"
import { operationalEvents, relatedRecords } from "./schema"

export const ACTION_STEP_MINUTES = 2

/** Event commands that each move the clock on by one step. */
export const CLOCK_ACTIONS = [
  "customer_email.sent_simulated", "customer_email.reply_simulated", "customer_email.call_logged",
  "order.slot_change_simulated", "agent.follow_up_started", "agent.action_approved", "agent.follow_up_reply_simulated",
  "manual_control.started", "manual_control.ended", "manual.note_added", "manual.resolution_recorded", "operator.cost_option_chosen", "agent.proposal_rejected", "agent.proposal_revised", "agent.scan_started", "agent.scan_cleared", "agent.scan_escalated",
]

/**
 * operational_events requires an order, and a clock jump belongs to no order, so jumps are kept
 * in related_records (order_id empty) under this collection, each with command "demo.clock_advanced".
 */
export const CLOCK_COLLECTION = "demo_clock"
export const CLOCK_COMMAND = "demo.clock_advanced"

type Reader = Pick<typeof db, "select">

/** Current business time: NOW + recorded jumps + one step per simulated action so far. */
export async function currentTime(tx: Reader = db): Promise<Date> {
  const [[jumps], [actions]] = await Promise.all([
    tx.select({ minutes: sql<string>`coalesce(sum((${relatedRecords.details} ->> 'minutes')::int), 0)` }).from(relatedRecords)
      .where(and(eq(relatedRecords.collection, CLOCK_COLLECTION), isNull(relatedRecords.orderId))),
    tx.select({ count: sql<string>`count(*)` }).from(operationalEvents).where(inArray(operationalEvents.command, CLOCK_ACTIONS)),
  ])
  const minutes = Number(jumps?.minutes ?? 0) + Number(actions?.count ?? 0) * ACTION_STEP_MINUTES
  return new Date(Date.parse(NOW) + minutes * 60_000)
}

/** The time to stamp on the next simulated action. Call it once per action, inside the action's transaction. */
export async function nextActionTime(tx: Reader = db): Promise<Date> {
  return new Date((await currentTime(tx)).getTime() + ACTION_STEP_MINUTES * 60_000)
}

/** Demo control: move the shared business clock forward. Recorded, so everyone sees the same time. */
export async function advanceClock(minutes: number): Promise<Date> {
  return db.transaction(async (tx) => {
    // One jump at a time, so two clicks never read the same starting time.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CLOCK_COLLECTION}))`)
    const from = await currentTime(tx)
    const to = new Date(from.getTime() + minutes * 60_000)
    const id = `clock-${randomUUID()}`
    await tx.insert(relatedRecords).values({ collection: CLOCK_COLLECTION, id, orderId: null, details: {
      id, command: CLOCK_COMMAND, minutes, from: from.toISOString(), to: to.toISOString(),
      actor_type: "operator", simulated: true, source: "demo_controls",
    } })
    return to
  })
}
