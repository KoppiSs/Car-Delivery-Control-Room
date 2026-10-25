import { NextResponse } from "next/server"
import { loadOrder } from "@/lib/present/load"
import { buildRecordView } from "@/lib/present/record"
import { caseStatements } from "@/lib/present/statements"
import { controlStateFor } from "@/lib/present/control-table"
import { namesFor, partiesFor } from "@/lib/present/names"
import { safetyStopFor } from "@/lib/safety-stop"
import { desc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { agentProposalFeedback } from "@/lib/schema"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const loaded = await loadOrder(id)
  if (!loaded) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const { order, customer, pickup, delivery, pickupSite, deliverySite, items, alerts, threads, messages, events, related, bundleOrderRefs, drivers, bundle } = loaded
  // The raw records keep their shape for anyone reading the API. `view` is the
  // same information read out with labels, names and grouping for the interface.
  const view = buildRecordView(bundle)
  const agentFeedback = await db.select().from(agentProposalFeedback)
    .where(eq(agentProposalFeedback.orderId, id)).orderBy(desc(agentProposalFeedback.createdAt), desc(agentProposalFeedback.id))
  return NextResponse.json({
    order, customer, pickup, delivery, pickupSite, deliverySite, items, drivers, alerts, conversations: threads, messages, events,
    related, bundleOrderRefs, view, agentFeedback,
    // Facts, the agent's readings and suggestions, kept apart for the case summary and the proposal card.
    statements: caseStatements(bundle, order.agentProposal),
    // The same section the control table shows for this order, so the two never disagree.
    control: await controlStateFor(id),
    // Names for ids in the agent's text (shown instead of the ids), and everyone a follow-up can ask.
    names: namesFor(bundle, [JSON.stringify(order.agentProposal ?? ""), order.waitingOnDescription]),
    parties: partiesFor(bundle),
    // An open safety stop: the card refuses a stored suggestion that has the car driven on.
    safetyStop: safetyStopFor(bundle).open,
  })
}
