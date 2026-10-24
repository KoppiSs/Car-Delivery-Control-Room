import { executableFields } from "./fixtures/proposal.cjs"
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const React = require('react')
const runtime = require('react/jsx-runtime')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('next/dist/build/swc')
const { investigationText, isAgentProposal, isExecutableAgentProposal } = require('../lib/agent.ts')
const source = await readFile(new URL('../app/components/agent-proposal.tsx', import.meta.url), 'utf8')
const { code } = transformSync(source, { filename: 'agent-proposal.tsx', jsc: {
  parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022',
}, module: { type: 'commonjs' } })
let effects = []
let buttons = []
const findings = []
let calls = 0
let refreshes = 0
let finish
const proposal = { ...executableFields, investigation_summary: [{ text: 'Evidence gathered.', source_event_ids: ['evt-source-1', 'evt-source-2'] }], proposed_action: 'Operator review.', decision_button_text: 'Approve follow-up' }
const captureJsx = (fn) => (...args) => {
  if (args[0] === 'button') buttons.push(args[1])
  if (args[0] === 'li') findings.push(args[1])
  return fn(...args)
}
const dependencies = (name) => {
  if (name === 'next/navigation') return { useRouter: () => ({ refresh() { refreshes++ } }) }
  if (name === 'react') return { ...React, useEffect(effect) { effects.push(effect) } }
  if (name === 'react/jsx-runtime') return { ...runtime, jsx: captureJsx(runtime.jsx), jsxs: captureJsx(runtime.jsxs) }
  if (name === '@/lib/agent') return { investigationText, isAgentProposal, isExecutableAgentProposal }
  if (name === '@/lib/present/time') return require('../lib/present/time.ts')
  if (name === '@/lib/agent-request') return { fetchAgentProposal(payload) {
    calls++
    assert.equal(payload.orderId, 'test-order')
    return new Promise((resolve) => { finish = () => resolve(proposal) })
  } }
  return require(name)
}
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(dependencies, loaded, loaded.exports)
const { AgentProposalCard } = loaded.exports
const detail = { order: { id: 'test-order', reference: 'TEST', agentProposal: null }, events: [], view: { attention: [], alerts: [], header: {} } }
const html = renderToStaticMarkup(React.createElement(AgentProposalCard, { detail }))
assert.ok(html.includes('Generate proposal'))
assert.ok(!html.includes('Investigating the order history'))
assert.ok(html.includes('aria-busy="false"'))
const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
assert.equal(calls, 0, 'Opening and mounting an order must not request generation')
const button = buttons.find((button) => button.children === 'Generate proposal')
const pending = button.onClick()
await button.onClick()
assert.equal(calls, 1, 'Generation starts on click and double clicks must not duplicate it')
finish()
await pending
for (const cleanup of cleanups) cleanup()
effects = []
buttons = []
const cached = renderToStaticMarkup(React.createElement(AgentProposalCard, { detail: { ...detail, order: { ...detail.order, agentProposal: proposal } } }))
for (const effect of effects) effect()
assert.ok(cached.includes('Evidence gathered.'))
assert.ok(!cached.includes('Generate proposal'))
assert.ok(cached.includes('Edit Proposal'))
assert.ok(cached.includes('Take Over'))
const finding = findings[0]
assert.equal(finding.children, 'Evidence gathered.')
assert.equal(finding.tabIndex, undefined)
assert.equal(finding.onMouseEnter, undefined)
assert.equal(finding.onFocus, undefined)
const approveButton = buttons.find((button) => button.children === 'Approve follow-up')
assert.equal(approveButton.disabled, false)
const nativeFetch = globalThis.fetch
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/agent/execute')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.executable_tool_call, proposal.executable_tool_call)
    assert.equal(body.waiting_on_description, proposal.waiting_on_description)
    return Response.json({ success: true, status: 'follow_up', waiting_on_description: proposal.waiting_on_description, decidedAt: '2026-10-24T10:00:00Z' })
  }
  approveButton.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(refreshes, 1, 'Approval must trigger router.refresh()')
} finally { globalThis.fetch = nativeFetch }
const renderDecision = (decision) => renderToStaticMarkup(React.createElement(AgentProposalCard, { detail: {
  ...detail, order: { ...detail.order, agentProposal: proposal, agentDecision: decision, agentDecisionAt: '2026-10-24T10:00:00Z' },
} }))
assert.ok(renderDecision('APPROVED').includes('Approve follow-up'))
assert.ok(renderDecision('APPROVED').includes('Approval saved'))
assert.ok(renderDecision('REJECTED').includes('Rejection saved'))
assert.ok(renderDecision('REJECTED').includes('Rejection is saved.'))
assert.equal(calls, 1, 'Cached proposals must not start another generation')
effects = []
buttons = []
const manual = renderToStaticMarkup(React.createElement(AgentProposalCard, { detail: { ...detail, order: { ...detail.order, agentMode: 'MANUAL' } } }))
for (const effect of effects) effect()
assert.ok(manual.includes('Manual control'))
assert.ok(manual.includes('Save note'))
assert.ok(manual.includes('Record manual resolution'))
assert.ok(!manual.includes('Generate proposal'))
assert.equal(calls, 1, 'Manual takeover must never start inference')
effects = []
buttons = []
const waiting = renderToStaticMarkup(React.createElement(AgentProposalCard, { detail: { ...detail, order: {
  ...detail.order, status: 'follow_up', agentProposal: null, waitingOnDescription: proposal.waiting_on_description,
} } }))
assert.ok(waiting.includes(proposal.waiting_on_description))
assert.ok(waiting.includes('Waiting on'))
assert.ok(!waiting.includes('Generate proposal'))
const { executable_tool_call, waiting_on_description, ...legacy } = proposal
buttons = []
const legacyHtml = renderToStaticMarkup(React.createElement(AgentProposalCard, { detail: { ...detail, order: { ...detail.order, agentProposal: legacy } } }))
assert.ok(legacyHtml.includes('Prepare follow-up'))
assert.equal(buttons.find((button) => button.children === 'Approve follow-up').disabled, true, 'Legacy plans cannot execute invented tool calls')
console.log('Verified Agent Proposal card: idle on open, no mount request, explicit generation click, duplicate-click protection, and immediate cached display.')
