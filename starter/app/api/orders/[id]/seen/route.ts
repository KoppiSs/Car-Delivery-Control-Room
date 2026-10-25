import { NextResponse } from "next/server"
import { markRepliesSeen } from "@/lib/present/control-table"

export const runtime = "nodejs"

/** Opening an order with a new reply clears "New reply" for everyone. Writes only when there is one. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return NextResponse.json({ recorded: await markRepliesSeen(id) })
}
