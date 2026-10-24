import { NextResponse } from "next/server"
import { runAgent } from "@/lib/agent/run"

export const runtime = "nodejs"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: orderId } = await params
    // Temporary case data until database-backed case loading is implemented.
    const triageCase = { status: "agent_investigate", headline: "Tracking missing" }
    const result = await runAgent(orderId, triageCase)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
