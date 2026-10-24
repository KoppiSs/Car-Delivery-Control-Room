import 'dotenv/config'
import { createRequire } from 'node:module'
const { buildAgentGenerationRequest, parseAgentOutput } = createRequire(import.meta.url)('../lib/agent.ts')
const orderId = process.env.AGENT_BENCHMARK_ORDER_ID ?? 'ord-00702'
const base = process.env.APP_URL ?? 'http://localhost:3000'
const detailResponse = await fetch(`${base}/api/orders/${orderId}`)
if (!detailResponse.ok) throw new Error('Could not load benchmark order')
const detail = await detailResponse.json()
const input = buildAgentGenerationRequest(detail.events, {
  order: { id: detail.order.id, reference: detail.order.reference }, status: detail.order.status,
  snapshot_at: detail.view.snapshotAt, alerts: detail.view.alerts, attention: detail.view.attention,
}, process.env.OLLAMA_MODEL || 'llama3.2')
const start = performance.now()
console.log(JSON.stringify({ order: detail.order.reference, promptCharacters: input.system.length + input.prompt.length, context: input.options.num_ctx, maxOutput: input.options.num_predict }))
const response = await fetch('http://127.0.0.1:11434/api/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(180_000),
})
const output = await response.json()
const proposal = parseAgentOutput(output, detail.events.map((event) => event.id))
console.log(JSON.stringify({ status: response.status, elapsedSeconds: Math.round((performance.now() - start) / 1000),
  promptTokens: output.prompt_eval_count, outputTokens: output.eval_count,
  promptSeconds: Math.round((output.prompt_eval_duration ?? 0) / 1e9), generationSeconds: Math.round((output.eval_duration ?? 0) / 1e9),
  valid: !!proposal, findings: proposal?.investigation_summary.length, doneReason: output.done_reason }))
if (!response.ok || !proposal) process.exitCode = 1
