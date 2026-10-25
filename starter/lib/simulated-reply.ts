// Suggests the text of a simulated reply to a waiting follow-up, so the demo answers the
// question that was asked instead of a bare "agrees / declines". The person always sees
// and can edit the text before it is recorded; nothing is sent anywhere.
//
// Driver: the scripted replies first (the same facts the agent's message_driver tool
// answers with, in lib/agent/driver-sim.ts), else the local model in the driver's role,
// using only this order's records. Customer and site: an agreement as a starting point.

import { desc, eq } from "drizzle-orm"
import { chosenWindows } from "./present/attention"
import { db } from "./db"
import { finalDeliveryPoint, num, str } from "./present/bundle"
import { loadOrder } from "./present/load"
import { partiesFor, withNames, namesFor } from "./present/names"
import { fmtDateTime } from "./present/time"
import { followUpRecipient } from "./follow-up-reply"
import { readAppPositions } from "./triage-read"
import { agentMockActions } from "./schema"

/**
 * Scripted driver facts, keyed by order reference. Kept in step with the facts in
 * lib/agent/driver-sim.ts (owned by the agent code); written here as plain replies.
 */
const SCRIPTED_DRIVER_REPLIES: Record<string, string> = {
  "CD-420806": "Location sharing was switched off on my phone. I'm near Jyväskylä and on time.",
  "CD-421013": "I logged out of the app after the pickup. I'm on the motorway, all fine.",
}

export const SIMULATED_MARK = "(simulated)"

export type ReplySuggestion = {
  /** Who answers, by name, and what kind of party they are. */
  from: string
  recipientType: string
  /** What we asked, in plain words. */
  question: string
  text: string
  source: "scripted" | "model" | "template"
  /** Quick picks are offered for customers and sites, where the question is usually yes or no. */
  quickPicks: boolean
}

const marked = (text: string) => text.includes(SIMULATED_MARK) ? text : `${text.trim()} ${SIMULATED_MARK}`

async function driverReplyFromModel(question: string, facts: Record<string, unknown>): Promise<string | null> {
  const prompt = `You are the delivery driver of one fictional car transport, answering your dispatcher's message.
Answer the question with a short, plain reply of at most 25 words, in the first person. Use only the facts below;
if they do not answer the question, say briefly what you can check. Do not invent places, times or problems. Return only the reply.
Facts: ${JSON.stringify(facts)}
Dispatcher's question: ${JSON.stringify(question)}`
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL || "llama3.2", stream: false, prompt, options: { temperature: 0.3, num_predict: 80 } }),
    })
    if (!response.ok) return null
    const output = await response.json() as { response?: unknown }
    const text = typeof output.response === "string" ? output.response.trim().replace(/^["']|["']$/g, "") : ""
    return text ? text.slice(0, 300) : null
  } catch { return null }
}

export async function suggestFollowUpReply(orderId: string): Promise<ReplySuggestion | null> {
  const loaded = await loadOrder(orderId)
  if (!loaded) return null
  const { bundle } = loaded
  const [action] = await db.select().from(agentMockActions).where(eq(agentMockActions.orderId, orderId))
    .orderBy(desc(agentMockActions.createdAt)).limit(1)
  if (!action || action.status !== "WAITING") return null
  const party = followUpRecipient(action.payload, partiesFor(bundle))
  if (!party) return null
  const names = namesFor(bundle, [action.waitingOnDescription, String(action.payload.description ?? "")])
  const question = withNames(String(action.payload.description ?? action.waitingOnDescription), names)
  const about = withNames(action.waitingOnDescription, names)

  if (party.type !== "driver") {
    return { from: party.name, recipientType: party.type, question, quickPicks: true, source: "template",
      text: party.type === "customer" ? "Yes, that works for us." : "Yes, that works." }
  }
  const scripted = SCRIPTED_DRIVER_REPLIES[bundle.order.reference]
  if (scripted) return { from: party.name, recipientType: "driver", question, quickPicks: false, source: "scripted", text: marked(scripted) }

  // Only this order's records: the car, the route, the times and the driver's own last messages.
  const windows = chosenWindows(bundle)
  const latest = readAppPositions(bundle)[0]
  const vehicle = bundle.items[0]?.vehicle
  const facts = {
    order: bundle.order.reference,
    car: vehicle ? `${vehicle.make} ${vehicle.model}` : null,
    from: bundle.places.get(bundle.order.pickupAddressId)?.city ?? null,
    to: bundle.places.get(bundle.order.deliveryAddressId)?.city ?? finalDeliveryPoint(bundle)?.details.city ?? null,
    pickup_slot: windows.pickupSlot ? fmtDateTime(windows.pickupSlot.start, windows.pickupSlot.zone) : null,
    delivery_promise: windows.promise ? fmtDateTime(windows.promise.start, windows.promise.zone) : null,
    last_app_position: latest ? { observed: fmtDateTime(str(latest.details.observed_at)), km_left: num(latest.details.distance_remaining_km),
      eta: str(latest.details.estimated_delivery_at) ? fmtDateTime(str(latest.details.estimated_delivery_at)) : null } : null,
    my_last_messages: bundle.messages.filter((message) => message.authorType === "driver").slice(-2).map((message) => message.body.slice(0, 200)),
  }
  const generated = await driverReplyFromModel(question, facts)
  return { from: party.name, recipientType: "driver", question, quickPicks: false,
    source: generated ? "model" : "template",
    text: marked(generated ?? `I got your message about ${about.toLowerCase()}. I'll check and get back to you shortly.`) }
}
