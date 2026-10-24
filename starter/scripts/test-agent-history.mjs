import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('next/dist/build/swc')
const source = await readFile(new URL('../app/components/record/sections.tsx', import.meta.url), 'utf8')
const { code } = transformSync(source, { filename: 'sections.tsx', jsc: { parser: { syntax: 'typescript', tsx: true },
  transform: { react: { runtime: 'automatic' } }, target: 'es2022' }, module: { type: 'commonjs' } })
const dependencies = (name) => {
  if (name === '@/lib/present/time') return require('../lib/present/time.ts')
  if (name === '../ui') return {
    SectionHead: ({ title, count }) => React.createElement('h2', {}, title + ' ' + count),
    Chip: ({ children }) => React.createElement('span', {}, children),
    Empty: ({ children }) => React.createElement('p', {}, children),
    When: ({ at }) => React.createElement('time', {}, at),
  }
  if (name === '../icons' || name === './files') return {}
  return require(name)
}
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(dependencies, loaded, loaded.exports)
const { DecisionsSection } = loaded.exports
const previousProposal = { investigation_summary: ['Evidence.'], proposed_action: 'Compare ferry options.', decision_button_text: 'Approve follow-up' }
const feedback = [
  { id: 'approved', decision: 'APPROVE', outcome: 'APPROVED' },
  { id: 'rejected', decision: 'REJECT', outcome: 'REJECTED' },
  { id: 'takeover', decision: 'TAKEOVER', outcome: 'MANUAL_TAKEOVER' },
  { id: 'edited', decision: 'OVERRIDE', outcome: 'APPLIED', correction: 'Check trains instead of ferries', replacementProposal: { ...previousProposal, proposed_action: 'Compare train options.' } },
].map((entry) => ({ correction: null, replacementProposal: null, previousProposal, operatorId: 'operator', createdAt: '2026-10-24T10:00:00Z', ...entry }))
const html = renderToStaticMarkup(React.createElement(DecisionsSection, { view: { proposals: [] }, feedback }))
for (const text of ['Prior agent work 4', 'Proposal approved', 'Proposal rejected', 'Manual control taken over', 'Check trains instead of ferries', 'Compare ferry options.', 'Compare train options.', '2026-10-24T10:00:00Z']) assert.ok(html.includes(text), 'Missing history detail: ' + text)
assert.ok(!html.includes('No agent work has been reviewed'))
const corrected = renderToStaticMarkup(React.createElement(DecisionsSection, { view: { proposals: [] }, feedback: [{
  id: 'repair', decision: 'CORRECT_WAITING', outcome: 'CORRECTED', operatorId: 'system', createdAt: '2026-10-24T10:00:00Z',
  correction: 'Removed an unrelated waiting event.', previousProposal: { ...previousProposal, waiting_on_description: 'Signed handover proof.' },
  replacementProposal: { ...previousProposal, waiting_on_description: 'Current ferry capacity confirmation.' },
}] }))
for (const text of ['Follow-up waiting event corrected', 'Corrected', 'Previous waiting event:', 'Signed handover proof.', 'Current ferry capacity confirmation.']) assert.ok(corrected.includes(text))
assert.ok(!corrected.includes('Rejected'))
console.log('Verified Prior agent work renders approvals, rejections, takeovers, corrections, reviewed/revised plans, and timestamps.')
