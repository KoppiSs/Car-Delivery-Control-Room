import { reopenScan } from "@/lib/scan"

export const runtime = "nodejs"

/** Reopens an order whose warning the agent cleared after a scan; it goes to Needs a review. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const result = await reopenScan(id)
  return result.success ? Response.json(result) : Response.json({ error: result.error }, { status: 409 })
}
