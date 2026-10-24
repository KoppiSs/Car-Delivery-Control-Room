import { NextRequest, NextResponse } from "next/server"
import { buildBoardCard } from "@/lib/present/board"
import { loadBoardBundles } from "@/lib/present/load"
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
  const body: DeliveriesOverview = { snapshotAt, total: all.length, visible, query }
  return NextResponse.json(body)
}
