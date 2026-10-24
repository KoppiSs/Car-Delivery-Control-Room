import { executableFields } from "./fixtures/proposal.cjs"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"

// Load the actual route and validator without a Next server or a running model.
const asModule = (source) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64")
const contractUrl = asModule(await readFile(new URL("../lib/agent.ts", import.meta.url), "utf8"))
const storeUrl = asModule(`
  export const state = { cached: null, missing: false, loadError: false, saveError: false, saves: 0, competing: null, mode: 'AGENT', revision: 0, feedback: [] };
  export class AgentReviewConflict extends Error {}
  export async function beginAgentOverride(id, correction, expected) {
    if (state.mode !== 'AGENT' || JSON.stringify(expected) !== JSON.stringify(state.cached)) throw new AgentReviewConflict('Proposal changed');
    state.revision++;
    state.feedback.push({ correction, previous: state.cached, outcome: 'REQUESTED' });
    return { feedbackId: 'feedback-test', revision: state.revision, previous: state.cached };
  }
  export async function finishAgentFeedback(id, outcome) { state.feedback.at(-1).outcome = outcome; }
  export async function loadAgentOrder(id) {
    if (state.loadError) throw new Error('Database unavailable');
    return state.missing ? null : { id, agentProposal: state.cached, agentMode: state.mode, agentRevision: state.revision };
  }
  export async function saveAgentProposal(id, proposal) {
    if (state.saveError) throw new Error('Save failed');
    state.saves++;
    state.cached = state.competing ?? proposal;
    return state.cached;
  }
`)
const { state } = await import(storeUrl)
const jobsUrl = asModule(await readFile(new URL("../lib/agent-jobs.ts", import.meta.url), "utf8"))
const routeSource = (await readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"))
  .replace('"@/lib/agent"', JSON.stringify(contractUrl))
  .replace('"@/lib/agent-store"', JSON.stringify(storeUrl))
  .replace('"@/lib/agent-jobs"', JSON.stringify(jobsUrl))
const { POST } = await import(asModule(routeSource))
const { isAgentProposal, parseAgentOutput } = await import(contractUrl)
const proposal = {
  ...executableFields,
  investigation_summary: ["Event ev-1 records a missed check-in; no replacement booking is evidenced."],
  proposed_action: "Ask the driver for their current situation and bring replacement travel options to an operator for approval.",
  decision_button_text: "Approve follow-up",
}
const originalFetch = globalThis.fetch
const originalModel = process.env.OLLAMA_MODEL
const request = (body) => new Request("http://localhost/api/agent", { method: "POST", body: JSON.stringify(body && !Array.isArray(body) ? { orderId: "ord-00593", ...body } : body) })
let calls = 0
try {
  process.env.OLLAMA_MODEL = "test-model"
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, "http://127.0.0.1:11434/api/generate")
    const payload = JSON.parse(options.body)
    assert.equal(payload.model, "test-model")
    assert.equal(payload.format.type, "object")
    assert.equal(payload.format.additionalProperties, false)
    assert.deepEqual(payload.format.required, ["investigation_summary", "proposed_action", "decision_button_text", "executable_tool_call", "waiting_on_description"])
    assert.equal(payload.options.temperature, 0)
    assert.equal(payload.stream, false)
    assert.match(payload.system, /NEVER contact customers autonomously/)
    assert.match(payload.system, /EXACTLY these five keys/)
    assert.match(payload.prompt, /ev-1/)
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json({ response: JSON.stringify(proposal) })
  }
  const valid = await POST(request({ events: [{ id: "ev-1", command: "ferry.missed" }] }))
  assert.equal(valid.status, 200)
  assert.deepEqual(await valid.json(), proposal)
  assert.equal(state.saves, 1)
  globalThis.fetch = async () => { throw new Error("Cached requests must not call Ollama") }
  const cached = await POST(request({}))
  assert.equal(cached.status, 200)
  assert.deepEqual(await cached.json(), proposal)
  assert.equal(state.saves, 1, "Cache hits must not write")
  state.cached = null
  for (const body of [null, [], {}, { orderId: null, events: [] }, { orderId: "", events: [] }, { events: "bad" }, { events: [null] }, { events: Array(201).fill({}) }]) {
    assert.equal((await POST(request(body))).status, 400)
  }
  assert.equal((await POST(new Request("http://localhost/api/agent", { method: "POST", body: "{" }))).status, 400)
  assert.equal((await POST(request({ events: [], context: "a".repeat(200_001) }))).status, 413)
  assert.equal(calls, 1, "Invalid requests must not call Ollama")
  state.missing = true
  assert.equal((await POST(request({ events: [] }))).status, 404)
  state.missing = false
  state.loadError = true
  assert.equal((await POST(request({ events: [] }))).status, 500)
  state.loadError = false
  for (const output of [{ ...proposal, extra: true }, { ...proposal, investigation_summary: "not an array" }, { ...proposal, decision_button_text: " " }, { ...proposal, investigation_summary: [] },
    { ...proposal, executable_tool_call: { action_type: "TEST", payload: [] } }, { ...proposal, waiting_on_description: " " }, null]) {
    assert.equal(isAgentProposal(output), false)
    globalThis.fetch = async () => Response.json({ response: JSON.stringify(output) })
    assert.equal((await POST(request({ events: [] }))).status, 502)
  }
  const { executable_tool_call, waiting_on_description, ...legacy } = proposal
  assert.equal(isAgentProposal(legacy), true, "Historical plans must remain readable")
  assert.equal(parseAgentOutput({ response: JSON.stringify(legacy) }), null, "New generation must include an executable action and waiting description")
  globalThis.fetch = async () => Response.json({ response: "not json" })
  assert.equal((await POST(request({ events: [] }))).status, 502)
  globalThis.fetch = async () => new Response("model not found", { status: 404 })
  assert.equal((await POST(request({ events: [] }))).status, 503)
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED") }
  assert.equal((await POST(request({ events: [] }))).status, 503)
  globalThis.fetch = async () => Response.json({ response: JSON.stringify(proposal) })
  state.saveError = true
  assert.equal((await POST(request({ events: [] }))).status, 500)
  state.saveError = false
  state.competing = { ...proposal, proposed_action: "Already saved by another request." }
  const concurrent = await POST(request({ events: [] }))
  assert.deepEqual(await concurrent.json(), state.competing)
  state.cached = null
  state.competing = null
  let releaseModel
  let signalToModel
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  let generationCalls = 0
  globalThis.fetch = async (_url, options) => {
    generationCalls++
    signalToModel = options.signal
    markStarted()
    return new Promise((resolve) => { releaseModel = () => resolve(Response.json({ response: JSON.stringify(proposal) })) })
  }
  const drawer = new AbortController()
  const firstReview = POST(new Request("http://localhost/api/agent", { method: "POST", signal: drawer.signal,
    body: JSON.stringify({ orderId: "ord-00593", events: [] }) }))
  await started
  drawer.abort()
  assert.equal(signalToModel.aborted, false, "Closing a drawer must not abort generation")
  const reopened = POST(request({ events: [] }))
  const busy = await POST(request({ orderId: "another-order", events: [] }))
  assert.equal(busy.status, 503, "Other orders must receive a bounded busy response instead of joining an unlimited model queue")
  releaseModel()
  for (const response of await Promise.all([firstReview, reopened])) {
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), proposal)
  }
  assert.equal(generationCalls, 1, "Reopening an order must reuse generation")
  assert.deepEqual(state.cached, proposal, "Generation should persist after the drawer closes")
  state.cached = null
  const nativeSetTimeout = globalThis.setTimeout
  try {
    globalThis.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms === 180_000 ? 20 : ms, ...args)
    globalThis.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) })
    assert.equal((await POST(request({ events: [] }))).status, 504, "Even a stuck model response body must time out")
  } finally { globalThis.setTimeout = nativeSetTimeout }
  globalThis.fetch = async () => Response.json({ response: JSON.stringify(proposal), done_reason: "length" })
  assert.equal((await POST(request({ events: [] }))).status, 200, "Complete valid JSON must be accepted even at the token limit")
  state.cached = null
  globalThis.fetch = async () => Response.json({ response: '{"investigation_summary": [', done_reason: "length" })
  assert.equal((await POST(request({ events: [] }))).status, 502)
  assert.equal(state.cached, null, "Incomplete output must not be saved")
  let attempts = 0
  globalThis.fetch = async (_url, options) => {
    attempts++
    const body = JSON.parse(options.body)
    if (attempts === 1) return Response.json({ response: JSON.stringify({ ...proposal, investigation_summary: "wrong type" }) })
    assert.equal(body.options.num_predict, 1280)
    assert.match(body.prompt, /previous response was incomplete or invalid/)
    return Response.json({ response: JSON.stringify(proposal) })
  }
  assert.equal((await POST(request({ events: [] }))).status, 200)
  assert.equal(attempts, 2, "Invalid output should receive one bounded retry")
  state.cached = null
  globalThis.fetch = async () => Response.json({ response: JSON.stringify(proposal) })
  assert.equal((await POST(request({ events: [] }))).status, 200, "Timeouts must release the order for retry")
  globalThis.fetch = async (_url, options) => {
    assert.match(JSON.parse(options.body).prompt, /Check trains instead of ferries/)
    return Response.json({ response: JSON.stringify({ ...proposal, proposed_action: "Compare trains and bring the options to an operator." }) })
  }
  const edited = await POST(request({ events: [], correction: "Check trains instead of ferries", previousProposal: proposal }))
  assert.equal(edited.status, 200)
  assert.equal(state.feedback.length, 1)
  assert.equal(state.feedback[0].outcome, "APPLIED")
  assert.deepEqual(state.feedback[0].previous, proposal)
  state.mode = "MANUAL"
  assert.equal((await POST(request({ events: [] }))).status, 409, "Manual orders must not regenerate proposals")
  console.log("Verified agent route: cache, persistence, validation, drawer cancellation, duplicate generation, busy handling, stalled-body timeout, truncation, and retries.")
} finally {
  globalThis.fetch = originalFetch
  if (originalModel === undefined) delete process.env.OLLAMA_MODEL
  else process.env.OLLAMA_MODEL = originalModel
}
