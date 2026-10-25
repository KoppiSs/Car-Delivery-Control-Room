import { generateProposal } from "@/lib/reject-regenerate"

export const runtime = "nodejs"

/**
 * "Generate proposal": asks the local model for a plan, guarded so that only an instruction for
 * the control room is saved. Outcomes: new, no_suggestion (with why), or failed (with why).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  let steer: string | undefined
  try {
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (typeof body.steer === "string" && body.steer.trim()) steer = body.steer.trim().slice(0, 1500)
  } catch { /* no steer */ }
  return Response.json(await generateProposal(id, steer))
}
