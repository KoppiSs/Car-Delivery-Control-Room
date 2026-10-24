import { NextResponse } from "next/server"
import { loadOrder } from "@/lib/present/load"
import { buildRecordView } from "@/lib/present/record"
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
  })
}
