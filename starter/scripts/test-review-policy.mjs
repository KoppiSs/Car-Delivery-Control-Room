import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
const require = createRequire(import.meta.url)
const { transformSync } = require('next/dist/build/swc')
const modules = new Map()
function load(path) {
  const filename = resolve(path)
  if (modules.has(filename)) return modules.get(filename).exports
  const loaded = { exports: {} }
  modules.set(filename, loaded)
  const { code } = transformSync(readFileSync(filename, 'utf8'), { filename, jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } })
  new Function('require', 'module', 'exports', code)((name) => name.startsWith('.') ? load(resolve(dirname(filename), name + '.ts')) : require(name), loaded, loaded.exports)
  return loaded.exports
}
const { deriveAttention } = load('lib/present/attention.ts')
const { buildBoardCard } = load('lib/present/board.ts')
const { needsControlRoomReview, reviewType, reviewBadge } = load('lib/present/review.ts')
const assignment = { id: 'assignment-current', details: { id: 'assignment-current', status: 'IN_PROGRESS', segment_ids: ['segment-current'], driver_id: 'driver', started_at: '2026-10-20T06:00:00Z' } }
const tracking = (observed, received = observed, extra = {}) => ({ id: 'track-current', details: {
  source: 'driver_app', location_quality: 'COARSE', assignment_id: assignment.id, segment_id: 'segment-current', observed_at: observed, received_at: received, ...extra,
} })
const base = { snapshotAt: '2026-10-21T09:00:00Z', order: { id: 'order', reference: 'REF', status: 'IN_TRANSIT', lane: 'moving',
  agentMode: 'AGENT', agentDecision: 'PENDING', details: {}, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-21T09:00:00Z' },
  related: { work_assignments: [assignment] }, alerts: [], conversations: [], events: [], items: [], inboxThreads: [], places: new Map(), sites: new Map(),
  customer: { name: 'Fictional customer' }, dir: { title: () => null, driverName: () => 'Driver' } }
const bundle = (observations, extra = {}) => ({ ...base, ...extra, related: { ...base.related, tracking_observations: observations, ...extra.related } })
const checks = (value) => deriveAttention(value).filter((item) => item.kind === 'check')
assert.ok(checks(bundle([tracking('2026-10-21T02:12:00Z', '2026-10-21T02:16:00Z')])).some((item) => item.title === 'Driver-app tracking is stale'))
assert.equal(checks(bundle([tracking('2026-10-21T08:30:00Z')])).length, 0, 'Fresh coarse/unverified tracking is normal')
assert.equal(checks(bundle([tracking('2026-10-21T05:01:00Z')])).length, 0)
assert.equal(checks(bundle([tracking('2026-10-21T05:00:00Z')])).length, 1, 'Four-hour boundary must be explicit')
assert.equal(checks(bundle([tracking('2026-10-21T02:00:00Z', '2026-10-21T08:59:00Z')])).length, 1, 'Late uploads cannot refresh an old observation')
for (const rows of [[], [tracking('2026-10-21T08:30:00Z', '2026-10-21T09:01:00Z')],
  [tracking('2026-10-21T08:30:00Z', undefined, { source: 'system', location_quality: 'INFERRED' })],
  [tracking('2026-10-21T08:30:00Z', undefined, { assignment_id: 'completed-leg' })]]) {
  assert.ok(checks(bundle(rows)).some((item) => item.title === 'Moving with no driver-app position'), 'Only observations from the active assignment and available at the snapshot can fill a tracking gap')
}
for (const status of ['DELIVERED', 'CANCELLED']) {
  assert.equal(checks(bundle([tracking('2026-10-18T01:00:00Z')], { order: { ...base.order, status, lane: status.toLowerCase() } })).length, 0)
}
const ack = { id: 'alert', status: 'ACKNOWLEDGED', signal: 'TRACKING_GAP', severity: 'high', details: {}, triggeredAt: '2026-10-21T07:00:00Z' }
assert.equal(checks(bundle([], { alerts: [ack] })).length, 0, 'An owned tracking alert must not generate a duplicate derived gap')
assert.equal(reviewType(buildBoardCard(bundle([], { alerts: [ack] }))), 'followup')
const promise = { id: 'window', details: { purpose: 'CUSTOMER_DELIVERY_PROMISE', is_selected: true, start_at: '2026-10-21T10:00:00Z', end_at: '2026-10-21T11:00:00Z', source: 'CUSTOMER' } }
const late = bundle([tracking('2026-10-21T08:30:00Z', undefined, { estimated_delivery_at: '2026-10-21T12:00:00Z' })], { related: { time_windows: [promise] } })
assert.ok(checks(late).some((item) => item.title === 'Delivery promise needs review'))
assert.equal(reviewType(buildBoardCard(late)), 'priority')
const rejected = bundle([], { order: { ...base.order, status: 'DELIVERED', lane: 'delivered' }, related: { proofs: [{ id: 'proof', details: { required: true, status: 'REJECTED', kind: 'DELIVERY_PHOTOS', review_note: 'Wrong vehicle.' } }] } })
assert.ok(checks(rejected).some((item) => item.recordId === 'proof'))
assert.equal(needsControlRoomReview(buildBoardCard(rejected)), true)
const fresh = buildBoardCard(bundle([tracking('2026-10-21T08:30:00Z')]))
assert.equal(needsControlRoomReview(fresh), false)
assert.equal(needsControlRoomReview({ ...fresh, attention: [{ kind: 'conversation' }, { kind: 'inbox', requiresReview: false }] }), false)
assert.equal(needsControlRoomReview({ ...fresh, attention: [{ kind: 'inbox', requiresReview: true, owner: 'Support' }] }), true)
assert.equal(reviewType({ ...fresh, attention: [{ kind: 'waiting', owner: 'Ops', tone: 'neutral' }] }), 'followup')
assert.equal(reviewType({ ...fresh, attention: [{ kind: 'waiting', owner: 'Ops', tone: 'warn' }] }), 'review')
for (const status of ['follow_up', 'FOLLOW_UP']) {
  const card = { ...buildBoardCard(late), status, openAlerts: ['critical'], problemSeverity: 'critical' }
  assert.equal(reviewType(card), 'followup')
  assert.equal(reviewBadge(card), 'Follow-up')
}
assert.equal(needsControlRoomReview({ ...buildBoardCard(late), agentMode: 'MANUAL_COMPLETE' }), false)
assert.equal(needsControlRoomReview({ ...buildBoardCard(late), agentMode: 'MANUAL_COMPLETE', openAlerts: ['high'] }), true)
console.log('Verified evidence-based review policy: stale/fresh/delayed/inferred tracking, active-leg scope, completed journeys, rejected proofs, delivery timing, ownership and exclusive Follow-up classification.')
