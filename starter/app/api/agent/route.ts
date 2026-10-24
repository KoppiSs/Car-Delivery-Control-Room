import { buildAgentGenerationRequest, isAgentProposal, parseAgentOutput } from "@/lib/agent"
import { AgentReviewConflict, beginAgentOverride, finishAgentFeedback, loadAgentOrder, saveAgentProposal } from "@/lib/agent-store"

import { runAgentJob } from "@/lib/agent-jobs"

export const runtime = "nodejs"

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 200_000) return Response.json({ error: "Order history is too large." }, { status: 413 })
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid body")
    body = parsed as Record<string, unknown>
  } catch {
    return Response.json({ error: "Send a JSON object with orderId and an events array." }, { status: 400 })
  }
  if (typeof body.orderId !== "string" || !body.orderId.trim() || body.orderId.length > 200) {
    return Response.json({ error: "orderId is required." }, { status: 400 })
  }
  const orderId = body.orderId
  const correction = typeof body.correction === "string" ? body.correction.trim() : null
  if (body.correction !== undefined && (!correction || correction.length > 2000 || !isAgentProposal(body.previousProposal))) {
    return Response.json({ error: "Provide a correction of 1–2000 characters and the proposal being edited." }, { status: 400 })
  }
  let review: Awaited<ReturnType<typeof loadAgentOrder>> | null = null
  try {
    const order = await loadAgentOrder(orderId)
    if (!order) return Response.json({ error: "Order not found." }, { status: 404 })
    review = order
    if (order.status === "follow_up") return Response.json({ error: "This order is already awaiting a follow-up event." }, { status: 409 })
    if (order.agentMode && order.agentMode !== "AGENT") return Response.json({ error: "This order is under manual control." }, { status: 409 })
    if (!correction && order.agentProposal !== null) return Response.json(order.agentProposal)
  } catch {
    return Response.json({ error: "Could not load the saved proposal. Please retry." }, { status: 500 })
  }
  if (!Array.isArray(body.events) || body.events.length > 200 || body.events.some((event) => !event || typeof event !== "object" || Array.isArray(event))) {
    return Response.json({ error: "events must be an array of up to 200 event objects." }, { status: 400 })
  }

  const result = await runAgentJob(orderId, async () => {
    let revision = review?.agentRevision ?? 0
    let feedbackId: string | undefined
    let previousAction = ""
    let previousWaitingOn: string | undefined
    if (correction && isAgentProposal(body.previousProposal)) {
      try {
        const override = await beginAgentOverride(orderId, correction, body.previousProposal)
        if (!override) return { status: 404, body: { error: "Order not found." } }
        revision = override.revision
        feedbackId = override.feedbackId
        previousAction = override.previous.proposed_action
        previousWaitingOn = override.previous.waiting_on_description
      } catch (error) {
        return { status: error instanceof AgentReviewConflict ? 409 : 500,
          body: { error: error instanceof AgentReviewConflict ? error.message : "Could not record the correction. Please retry." } }
      }
    }
    const controller = new AbortController()
    const timedOut = { status: 504, body: { error: "The agent took too long. Please retry." } }
    let onTimeout: () => void = () => {}
    const deadline = new Promise<typeof timedOut>((resolve) => {
      onTimeout = () => resolve(timedOut)
      controller.signal.addEventListener("abort", onTimeout, { once: true })
    })
    const timer = setTimeout(() => controller.abort(), 180_000)
    const generate = async () => {
      let proposal: ReturnType<typeof parseAgentOutput> = null
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // A drawer closing must not discard work another review can reuse.
            signal: controller.signal,
            body: JSON.stringify(buildAgentGenerationRequest(body.events as unknown[], body.context ?? null,
              process.env.OLLAMA_MODEL || "llama3.2", attempt, correction ? { correction, previousAction, previousWaitingOn } : undefined)),
          })
          if (!response.ok) return { status: 503, body: { error: "The local model is unavailable. Check that OLLAMA_MODEL names an installed model." } }
          const output = await response.json()
          proposal = parseAgentOutput(output, (body.events as Record<string, unknown>[]).flatMap((event) => typeof event.id === "string" ? [event.id] : []), correction)
          if (proposal) break
          if (attempt === 1) return { status: 502, body: { error: "The agent couldn't prepare a complete proposal. Please retry the investigation." } }
        }

      } catch {
        return controller.signal.aborted ? timedOut : { status: 503, body: { error: "Could not reach the local agent. Check that Ollama is running." } }
      }
      if (controller.signal.aborted) return timedOut
      if (!proposal) return { status: 502, body: { error: "The agent returned an invalid proposal. Please retry." } }
      try {
        const saved = await saveAgentProposal(orderId, proposal, revision, feedbackId)
        if (!saved) return { status: 409, body: { error: "This review changed while the agent was working. Reopen the order to see the latest state." } }
        return { status: 200, body: saved }
      } catch {
        return { status: 500, body: { error: "Could not save the proposal. Please retry." } }
      }
    }
    try {
      const outcome = await Promise.race([generate(), deadline])
      if (feedbackId) await finishAgentFeedback(feedbackId, outcome.status === 200 ? "APPLIED" : outcome.status === 409 ? "SUPERSEDED" : "FAILED")
      return outcome
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener("abort", onTimeout)
    }
  }, correction ?? "")
  return Response.json(result.body, { status: result.status })
}
