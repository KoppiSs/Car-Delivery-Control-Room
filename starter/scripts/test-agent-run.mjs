import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
const { AGENT_TOOLS } = createRequire(import.meta.url)('../lib/agent/tools.ts')
const moduleUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64')
const toolsUrl = moduleUrl(`
  export const AGENT_TOOLS = ${JSON.stringify(AGENT_TOOLS)};
  export const calls = [];
  export async function runTool(name, args, orderId) {
    calls.push({ name, args, orderId });
    return name === 'message_driver' ? 'Location sharing off, near Jyväskylä, on time.' : name + ' executed';
  }
`)
const { calls } = await import(toolsUrl)
const source = (await readFile(new URL('../lib/agent/run.ts', import.meta.url), 'utf8')).replace('"./tools.ts"', JSON.stringify(toolsUrl))
const { runAgent } = await import(moduleUrl(source))
const nativeFetch = globalThis.fetch
const inputs = []
let replies = []
const question = { tool_call: { name: 'message_driver', args: { question: 'Where are you, and are you on time?' } } }
const closed = { tool_call: { name: 'close_case', args: { reason: 'Driver confirmed progress.', facts: 'Location sharing off; near Jyväskylä; on time.' } } }
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat')
    const input = JSON.parse(options.body)
    assert.equal(input.model, 'llama3.2')
    assert.equal(input.stream, false)
    assert.equal(input.format, 'json')
    assert.equal(input.messages[0].role, 'system')
    assert.ok(input.messages[0].content.includes(JSON.stringify(AGENT_TOOLS)))
    inputs.push(input)
    return Response.json({ message: { content: JSON.stringify(replies.shift()) } })
  }
  replies = [question, closed]
  assert.deepEqual(await runAgent('CD-420806', { issue: 'Stale tracking' }), closed)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].orderId, 'CD-420806')
  assert.deepEqual(calls[0].args, question.tool_call.args)
  assert.equal(calls[1].orderId, 'CD-420806')
  assert.equal(inputs[0].messages[1].content, JSON.stringify({ issue: 'Stale tracking' }))
  assert.equal(inputs[1].messages[2].role, 'assistant')
  assert.equal(inputs[1].messages[3].content, JSON.stringify('Location sharing off, near Jyväskylä, on time.'))
  const handoff = { tool_call: { name: 'hand_to_person', args: { headline: 'Check arrival', facts: 'No confirmed ETA.', suggestion: 'Review with the driver.', options: ['Confirm ETA', 'Review route'] } } }
  replies = [handoff]
  assert.deepEqual(await runAgent('CD-421013', {}), handoff)
  replies = [{ resolution: 'No further action needed.' }]
  assert.deepEqual(await runAgent('CD-420806', {}), { resolution: 'No further action needed.' })
  const before = calls.length
  for (const invalid of [{ tool_call: { name: 'unknown', args: {} } },
    { tool_call: { name: 'message_driver', args: { question: 'Where?', orderId: 'other-order' } } },
    { tool_call: { name: 'close_case', args: { reason: 'Done' } } }, { ...closed, resolution: 'Both are forbidden' }]) {
    replies = [invalid]
    await assert.rejects(runAgent('CD-420806', {}))
  }
  assert.equal(calls.length, before, 'Invalid calls must never execute')
  const inputCount = inputs.length
  replies = [question, question, question, closed]
  await assert.rejects(runAgent('CD-420806', {}), /three turns/)
  assert.equal(inputs.length - inputCount, 3)
  assert.equal(calls.length - before, 3)
  console.log('Verified agent loop: driver/tool history, terminal tools, direct resolution, strict arguments, caller-owned order scope and the three-turn limit.')
} finally { globalThis.fetch = nativeFetch }
