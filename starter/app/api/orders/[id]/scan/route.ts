import { scanOrder } from "@/lib/scan"

export const runtime = "nodejs"

/** A person asks the agent to check one order with a possible problem and no alert. Started on request only. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return Response.json(await scanOrder(id))
}
