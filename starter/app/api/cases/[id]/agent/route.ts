import { NextResponse } from "next/server"
import { runAgent } from "@/lib/agent/run"
import { triageOrder } from "@/lib/triage"

export const runtime = "nodejs"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: orderId } = await params
    const triageCase = await triageOrder(orderId)
    if (!triageCase) return NextResponse.json({ error: "Order not found." }, { status: 404 })
    const result = await runAgent(orderId, triageCase)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
