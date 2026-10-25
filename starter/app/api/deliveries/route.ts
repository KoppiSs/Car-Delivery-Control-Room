import { NextRequest, NextResponse } from "next/server"
import { buildBoardCard } from "@/lib/present/board"
import { controlStates } from "@/lib/present/control-table"
import { loadBoardBundles } from "@/lib/present/load"
import { deliveryChecks } from "@/lib/present/statements"
import type { DeliveriesOverview } from "@/lib/present/types"

export const runtime = "nodejs"

/** An informational register of every delivery, including completed and quiet orders. */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? ""
  const { snapshotAt, bundles } = await loadBoardBundles()
  const all = bundles.map(buildBoardCard)
  const visible = (query ? all.filter((card) => [card.reference, card.customer, card.vehicle,
    card.origin, card.destination, card.plate ?? "", card.statusLabel,
  ].some((field) => field.toLowerCase().includes(query))) : all)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.reference.localeCompare(b.reference))
  // Checks and control-table state for each row; the page renders the details only when a row is expanded.
  const shownIds = new Set(visible.map((card) => card.id))
  const shownBundles = bundles.filter((bundle) => shownIds.has(bundle.order.id))
  const { now, states } = await controlStates(shownBundles)
  const checks = Object.fromEntries(shownBundles.map((bundle) => {
    const state = states.get(bundle.order.id)
    return [bundle.order.id, { ...deliveryChecks(bundle), table: state?.row ? state.note : null, notInTable: state?.row ? null : state?.note ?? null }]
  }))
  const body: DeliveriesOverview = { snapshotAt, total: all.length, visible, query, checkedAt: now.toISOString(), checks }
  return NextResponse.json(body)
}
