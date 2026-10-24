import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { executableFields } from './fixtures/proposal.cjs'
const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('next/dist/build/swc')
const source = await readFile(new URL('../app/components/control-order-card.tsx', import.meta.url), 'utf8')
const { code } = transformSync(source, { filename: 'control-order-card.tsx', jsc: { parser: { syntax: 'typescript', tsx: true },
  transform: { react: { runtime: 'automatic' } }, target: 'es2022' }, module: { type: 'commonjs' } })
const dependencies = (name) => {
  if (name === 'next/link') return ({ children, href, className }) => React.createElement('a', { href, className }, children)
  if (name === '@/lib/present/time') return require('../lib/present/time.ts')
  if (name === '@/lib/present/review') return require('../lib/present/review.ts')
  if (name === './icons') return { Icon: () => null }
  return require(name)
}
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(dependencies, loaded, loaded.exports)
const card = { id: 'test-order', reference: 'TEST', status: 'follow_up', agentDecision: 'APPROVED', agentMode: 'AGENT',
  problemTitle: 'Tracking gap', problemDetail: 'A current report is needed.', waitingOnDescription: executableFields.waiting_on_description,
  openAlerts: [], acknowledgedAlerts: [], attention: [], vehicle: 'Test vehicle', from: { city: 'Hamburg' }, to: { city: 'Helsinki' }, customer: 'Fictional dealer' }
const html = renderToStaticMarkup(React.createElement(loaded.exports.ControlOrderCard, { card, onOpen() {} }))
assert.ok(html.includes('follow-up-waiting'))
assert.ok(html.includes('Waiting on'))
assert.ok(html.includes(executableFields.waiting_on_description))
assert.ok(html.includes('Tracking gap'), 'The original problem must stay visible')
for (const override of [{ problemSeverity: 'critical' }, { problemSeverity: 'high', agentDecision: 'PENDING' },
  { status: 'FOLLOW_UP', problemSeverity: 'critical', openAlerts: ['critical'], attention: [{ kind: 'incident', tone: 'danger' }] },
  { status: 'IN_TRANSIT', agentMode: 'MANUAL', problemSeverity: 'high' },
  { status: 'WAITING_FOR_PICKUP', agentDecision: 'PENDING', acknowledgedAlerts: ['high'], problemSeverity: 'high' }]) {
  const output = renderToStaticMarkup(React.createElement(loaded.exports.ControlOrderCard, { card: { ...card, ...override }, onOpen() {} }))
  assert.ok(!output.includes('Priority review'), 'Owned Follow-up/Manual cards must not display an old priority badge')
  assert.ok(!output.includes('control-badge urgent'))
}
console.log('Verified Follow-up card prominently renders waiting-on text while retaining the problem title.')
