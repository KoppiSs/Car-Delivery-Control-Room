import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { executableFields } from './fixtures/proposal.cjs'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('next/dist/build/swc')
const agent = require('../lib/agent.ts')
async function load(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { code } = transformSync(source, { filename: path, jsc: { parser: { syntax: 'typescript', tsx: true },
    transform: { react: { runtime: 'automatic' } }, target: 'es2022' }, module: { type: 'commonjs' } })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', code)((name) => dependencies[name] ?? require(name), loaded, loaded.exports)
  return loaded.exports
}

let agentMounts = 0
const information = ({ view }) => React.createElement('p', {}, view.title)
const { OrderPane } = await load('../app/components/order-detail.tsx', {
  '@/lib/agent': agent,
  './agent-proposal': { AgentProposalCard() { agentMounts++; return React.createElement('button', {}, 'Generate proposal') } },
  './record/header': { RecordHero: information, Tiles: () => null },
  './record/records': { RecordsPanel: information },
  './record/sections': Object.fromEntries(['ActivitySection', 'ConversationsSection', 'DecisionsSection', 'EvidenceSection', 'RouteStrip'].map((name) => [name, information])),
})
const proposal = { ...executableFields, investigation_summary: [{ text: 'Recorded evidence.', source_event_ids: ['evt-1'] }],
  proposed_action: 'Check the route.', decision_button_text: 'Approve follow-up' }
const detail = { order: { id: 'test', reference: 'TEST', agentProposal: proposal, agentDecision: 'REJECTED' },
  view: { title: 'Delivery facts', tiles: [] }, events: [] }
for (const order of [detail.order, { ...detail.order, agentProposal: null },
  { ...detail.order, agentMode: 'MANUAL' }, { ...detail.order, status: 'follow_up', agentProposal: null, waitingOnDescription: 'A confirmed arrival.' }]) {
  const html = renderToStaticMarkup(React.createElement(OrderPane, { detail: { ...detail, order }, readOnly: true }))
  assert.ok(html.includes('Delivery facts'))
  assert.ok(!/<(button|form|textarea|input|select)\b/.test(html), 'Informational pane must not render mutation controls')
  if (order.agentProposal) {
    assert.ok(html.includes('Recorded evidence.'))
    assert.ok(html.includes('Check the route.'))
    assert.ok(html.includes('rejected'))
  }
  if (order.waitingOnDescription) assert.ok(html.includes(order.waitingOnDescription))
}
assert.equal(agentMounts, 0, 'Read-only details must never mount the component that generates or changes proposals')
renderToStaticMarkup(React.createElement(OrderPane, { detail }))
assert.equal(agentMounts, 1, 'Control Room must retain its interactive proposal card')

const { OrderDrawer } = await load('../app/components/order-drawer.tsx', {
  react: { ...React, useState(initial) { return React.useState(initial === null ? detail : initial) } },
  'next/link': { default: ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children) },
  './order-detail': { OrderPane },
})
const drawer = renderToStaticMarkup(React.createElement(OrderDrawer, { order: detail.order, readOnly: true, onDismiss() {} }))
assert.ok(drawer.includes('Delivery details · Read only'))
assert.ok(drawer.includes('Recorded evidence.'))
assert.ok(!drawer.includes('Open full page'))
assert.ok(!drawer.includes('Generate proposal'))
assert.equal(agentMounts, 1, 'Drawer must pass read-only mode through to its loaded pane')
const changedOrder = renderToStaticMarkup(React.createElement(OrderDrawer, { order: { id: 'another-order', reference: 'ANOTHER' }, readOnly: true, onDismiss() {} }))
assert.ok(changedOrder.includes('ANOTHER'))
assert.ok(!changedOrder.includes('Recorded evidence.'), 'A previously loaded order must not render under another order reference')
assert.ok(changedOrder.includes('Loading order'))
const { groupDeliveries } = await load('../lib/present/deliveries.ts', { './labels': require('../lib/present/labels.ts') })
const cards = ['DELIVERED', 'follow_up', 'NEW', 'IN_TRANSIT', 'WAITING_FOR_PICKUP', 'CANCELLED', 'BLOCKED', 'FUTURE_STATE', 'NEW'].map((status, index) => ({
  id: `delivery-${index}`, reference: `REF-${index}`, status, statusLabel: status, displayLane: 'moving',
  vehicle: `Vehicle ${index}`, customer: 'Fictional customer', from: { city: 'Helsinki' }, to: { city: 'Hamburg' }, routeKindLabel: 'International',
}))
const groups = groupDeliveries(cards)
assert.deepEqual(groups.map((group) => group.state), ['NEW', 'WAITING_FOR_PICKUP', 'IN_TRANSIT', 'BLOCKED', 'FOLLOW_UP', 'DELIVERED', 'CANCELLED', 'FUTURE_STATE'])
assert.equal(groups[0].orders.length, 2)
assert.equal(new Set(groups.flatMap((group) => group.orders.map((order) => order.id))).size, cards.length, 'Grouping must not drop or duplicate deliveries')
let stateIndex = 0
const { default: DeliveriesPage } = await load('../app/deliveries/page.tsx', {
  react: { ...React, useState(initial) {
    const index = stateIndex++
    return React.useState(index === 1 ? { total: cards.length, visible: cards } : index === 2 ? false : initial)
  } },
  '@/lib/present/time': require('../lib/present/time.ts'),
  '@/lib/present/deliveries': { groupDeliveries },
  '../components/app-frame': { AppFrame: ({ children }) => children },
  '../components/icons': { Icon: () => null },
  '../components/order-drawer': { OrderDrawer },
})
const page = renderToStaticMarkup(React.createElement(DeliveriesPage))
assert.equal((page.match(/class="delivery-group-heading"/g) ?? []).length, groups.length)
assert.equal((page.match(/class="delivery-row"/g) ?? []).length, cards.length)
assert.ok(page.includes('id="delivery-state-FOLLOW_UP"'))
console.log('Verified read-only delivery drawer for saved, ungenerated, manual and follow-up orders; editable controls remain available only in Control Room.')
console.log('Verified separate delivery state sections, counts and all cards, including future statuses and Follow-up independent of display lane.')
