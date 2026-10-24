// Offline dataset and pure-rule tests. No .env, database, server, model or writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { transformSync } = require('next/dist/build/swc')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modules = new Map()
let suppliedBundles = []
let loaderCalls = 0
function load(filename) {
  filename = resolve(root, filename)
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }
  modules.set(filename, module)
  const { code } = transformSync(readFileSync(filename, 'utf8'), { filename,
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } })
  new Function('require', 'module', 'exports', code)((name) => {
    if (name === './present/load') return { loadBoardBundles: async (options) => {
      loaderCalls++
      assert.equal(options, undefined, 'All-order triage must not ask for exception-only filtering')
      return { bundles: suppliedBundles }
    }, loadOrder: async (id) => {
      const bundle = suppliedBundles.find((entry) => entry.order.id === id)
      return bundle ? { bundle } : null
    } }
    return name.startsWith('.') ? load(resolve(dirname(filename), name + '.ts')) : require(name)
  }, module, module.exports)
  return module.exports
}
const { NOW, classifyCase } = load('lib/case.ts')
const { evaluateTriage, evaluateBundles, assessAllOrders, issuePriority, triageAll, triageBundle, triageOrder } = load('lib/triage.ts')
const { readAppPositions, readCurrentAssignments, readDriverActivity, readOrderContext, readDriverDelayMessages } = load('lib/triage-read.ts')
const { Directory } = load('lib/present/actors.ts')
const dataset = resolve(root, '../dataset/data')
const manifest = JSON.parse(readFileSync(resolve(dataset, 'manifest.json'), 'utf8'))
assert.equal(NOW, manifest.snapshot_at, 'Shared NOW must agree with the dataset snapshot')
const data = new Map(Object.keys(manifest.tables).map((name) => [name,
  readFileSync(resolve(dataset, `${name}.jsonl`), 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))]))
const all = (name) => data.get(name) ?? []
const dir = new Directory({ drivers: [], customers: [], operators: [], agents: [], sites: [], endpointDetails: [] })
const core = new Set(['orders', 'customers', 'alerts', 'messages', 'conversations', 'operational_events', 'sites', 'addresses', 'vehicles', 'drivers', 'order_items'])
const planOrders = new Map(all('transport_plans').map((row) => [row.id, row.order_id]))
const bundles = all('orders').map((order) => {
  const own = (name) => all(name).filter((row) => (row.order_id ?? planOrders.get(row.plan_id)) === order.id)
  const customer = all('customers').find((row) => row.id === order.customer_id)
  const threads = all('conversations').filter((row) => row.order_id === order.id || row.related_order_ids?.includes(order.id))
  const threadIds = new Set(threads.map((row) => row.id))
  return { snapshotAt: manifest.snapshot_at,
    order: { id: order.id, reference: order.reference, lane: order.display_lane, status: order.status, routeKind: order.route_kind,
      details: order, createdAt: order.created_at, updatedAt: order.updated_at, pickupAddressId: order.pickup_address_id,
      deliveryAddressId: order.delivery_address_id, pickupSiteId: order.pickup_site_id, deliverySiteId: order.delivery_site_id },
    customer: { id: customer.id, name: customer.name, tier: customer.account_tier, country: customer.country },
    alerts: own('alerts').map((details) => ({ id: details.id, status: details.status, signal: details.signal,
      severity: details.severity, summary: details.summary, triggeredAt: details.triggered_at, details })),
    events: own('operational_events').map((details) => ({ id: details.id, orderId: details.order_id,
      command: details.command, targetType: details.target_type, targetId: details.target_id, recordedAt: details.recorded_at, details })),
    conversations: threads.map((details) => ({ id: details.id, orderId: details.order_id, status: details.status,
      category: details.category, channel: details.channel, updatedAt: details.updated_at, details })),
    messages: all('messages').filter((row) => threadIds.has(row.conversation_id)).map((details) => ({ id: details.id,
      orderId: details.order_id, conversationId: details.conversation_id, authorType: details.author_type,
      authoredAt: details.authored_at, body: details.body, details })),
    related: Object.fromEntries([...data.keys()].filter((name) => !core.has(name)).map((name) => [name, own(name).map((details) => ({ id: details.id, details }))])),
    dir, items: [], places: new Map(all('addresses').map((entry) => [entry.id,
      { id: entry.id, name: entry.name, city: entry.city, country: entry.country, managedSiteId: entry.managed_site_id, details: entry }])),
    sites: new Map(), inboxThreads: [], bundleOrderRefs: {} }
})
const get = (reference) => {
  const bundle = bundles.find((entry) => entry.order.reference === reference)
  assert.ok(bundle, `Missing fixture ${reference}`)
  return { ...structuredClone({ ...bundle, dir: null }), dir }
}
const check = (bundle, rule) => {
  const value = evaluateTriage(bundle).checks.find((item) => item.rule === rule)
  assert.ok(value, `Missing rule ${rule}`)
  return value
}
const position = (bundle, values) => Object.assign(readAppPositions(bundle)[0].details, values)
const assignment = (bundle) => readCurrentAssignments(bundle)[0]
const row = (id, details) => ({ id, details })
const expected = [
  ['CD-420322', 'person_now'], ['CD-420603', 'person_now'], ['CD-420299', 'person_now'], ['CD-420399', 'person_now'],
  ['CD-421013', 'agent_investigate'], ['CD-420806', 'agent_investigate'], ['CD-420439', 'agent_investigate'],
  ['CD-420710', 'agent_investigate'], ['CD-420735', 'fine'], ['CD-420071', 'fine'],
]
const table = expected.map(([reference, expected]) => {
  const result = evaluateTriage(get(reference))
  return { reference, expected, actual: result.classification, status: result.status, priority: result.priority }
})
console.table(table)
for (const entry of table) assert.equal(entry.actual, entry.expected, entry.reference)
const results = evaluateBundles(bundles)
assert.equal(results.length, manifest.tables.orders)
assert.equal(new Set(results.map((entry) => entry.orderId)).size, results.length)
for (const result of results) {
  for (const rule of ['safety_stop', 'ferry_cutoff', 'travel_sold_out', 'positioning_risk', 'tracking_missing', 'tracking_stale', 'eta_vs_promise', 'progress_plateau']) {
    assert.ok(result.checks.some((item) => item.rule === rule), `${result.reference}: every rule must run`)
  }
  for (const item of result.checks) {
    assert.equal(item.passed, item.outcome === 'pass')
    if (item.classification) assert.equal(item.outcome, 'fail')
    for (const source of item.evidence) assert.ok(source.recordId && source.collection)
  }
}
suppliedBundles = bundles
await assessAllOrders()
assert.equal(loaderCalls, 1)
const sharedCases = await triageAll()
assert.equal(loaderCalls, 2)
assert.equal(sharedCases.length, manifest.tables.orders)
assert.deepEqual(await triageOrder('ord-00806'), sharedCases.find((entry) => entry.id === 'ord-00806'), 'Per-order triage must use the same facts and checks as all-order triage')
assert.equal(await triageOrder('missing-order'), null)
for (const [reference, expectedRoute] of expected) {
  const actualCase = sharedCases.find((entry) => entry.reference === reference)
  assert.equal(classifyCase(actualCase), expectedRoute, 'B can derive classification from shared Case status')
  assert.ok(actualCase.route.includes(' → ') && !actualCase.route.includes('Place not recorded'), 'route is the actual journey')
  assert.equal(Object.hasOwn(actualCase, 'classification'), false, 'No extra classification field on shared Case')
}
const sourceRows = new Map([...data.values()].flat().map((entry) => [entry.id, entry]))
for (const value of sharedCases) {
  assert.ok(value.checks.length >= 8)
  for (const fact of value.facts) {
    assert.ok(fact.text && fact.source && fact.recordId && Date.parse(fact.at) <= Date.parse(NOW))
    const source = sourceRows.get(fact.recordId)
    assert.ok(source, `Unknown Fact source record ${fact.recordId}`)
    assert.ok(JSON.stringify(source).includes(JSON.stringify(fact.at)), 'Fact timestamp must occur on the underlying source record')
  }
}
const before = JSON.stringify(bundles)
evaluateBundles(bundles)
assert.equal(JSON.stringify(bundles), before, 'Triage must not mutate input or agent state')
assert.deepEqual(evaluateBundles([...bundles].reverse()), results, 'Order iteration must not change output order')
assert.equal(evaluateTriage(get('CD-420322')).priority, 100)
assert.equal(evaluateTriage(get('CD-420603')).priority, 50, 'Cutoff is exactly 3 h away, not less than 3 h')
assert.equal(evaluateTriage(get('CD-420299')).priority, 30, 'Actual key account mapping adds 10')
assert.equal(issuePriority({ rule: 'eta_vs_promise', deadline: { at: '2026-10-21T11:59:59Z' } }), 80)
assert.equal(issuePriority({ rule: 'eta_vs_promise', deadline: { at: '2026-10-22T09:00:00Z' } }), 20)
assert.equal(issuePriority({ rule: 'eta_vs_promise', deadline: { at: '2026-10-22T08:59:59Z' } }), 50)
assert.equal(check(get('CD-420439'), 'eta_vs_promise').detail.includes('43.00 min after'), true)
assert.equal(check(get('CD-420071'), 'tracking_fresh').passed, true)
assert.equal(check(get('CD-420071'), 'other_desk').detail, 'Handled by another desk')
const unknownFact = get('CD-420322')
unknownFact.alerts = []
delete unknownFact.related.incidents[0].details.opened_at
assert.equal(check(unknownFact, 'safety_stop').outcome, 'unknown')
assert.equal(triageBundle(unknownFact).facts.some((fact) => fact.source === 'incidents'), false, 'No invented timestamp for a Fact')

const missing = get('CD-421013')
const pickup = missing.events.find((event) => event.command === 'vehicle.picked_up')
pickup.details.changes.occurred_at = '2026-10-21T08:00:00Z'
pickup.recordedAt = '2026-10-21T08:00:00Z'
assert.equal(check(missing, 'tracking_missing').outcome, 'pass', 'Exactly 60 minutes does not trigger')
pickup.details.changes.occurred_at = '2026-10-21T07:59:59Z'
assert.equal(check(missing, 'tracking_missing').outcome, 'fail')
missing.related.tracking_observations = [row('inferred', { source: 'ferry_schedule_inference', location_quality: 'INFERRED',
  observed_at: '2026-10-21T08:50:00Z', received_at: '2026-10-21T08:51:00Z' })]
assert.equal(check(missing, 'tracking_missing').outcome, 'fail', 'Schedule inference is not an app position')
missing.events = []
assert.equal(check(missing, 'tracking_missing').outcome, 'unknown')
assert.equal(check(missing, 'tracking_missing').passed, false, 'Missing evidence cannot pass')

const stale = get('CD-420806')
stale.alerts = []
assert.equal(evaluateTriage(stale).classification, 'agent_investigate', 'No alert is needed')
position(stale, { observed_at: '2026-10-21T09:00:00+02:00', received_at: '2026-10-21T07:01:00Z' })
assert.equal(check(stale, 'tracking_stale').outcome, 'pass', 'Timezone offsets are honored; exactly 2 h does not trigger')
position(stale, { observed_at: '2026-10-21T06:59:59Z', received_at: '2026-10-21T08:59:00Z' })
assert.equal(check(stale, 'tracking_stale').outcome, 'fail', 'A late upload cannot refresh the observed time')
position(stale, { observed_at: '2026-10-21T08:59:00Z', received_at: '2026-10-21T09:01:00Z' })
assert.equal(readAppPositions(stale).some((entry) => entry.details.received_at === '2026-10-21T09:01:00Z'), false)
const healthy = get('CD-420071')
healthy.related.tracking_observations.reverse()
assert.equal(evaluateTriage(healthy).classification, 'fine', 'Input observation ordering must not affect latest evidence')
assert.equal(check(get('CD-421013'), 'tracking_stale').passed, false)
const noTracking = get('CD-420735')
assert.equal(check(noTracking, 'eta_vs_promise').outcome, 'unknown')
assert.equal(check(noTracking, 'progress_plateau').outcome, 'unknown')

const eta = get('CD-420710')
position(eta, { estimated_delivery_at: '2026-10-21T13:45:00Z' })
assert.equal(check(eta, 'eta_vs_promise').outcome, 'pass')
position(eta, { estimated_delivery_at: '2026-10-21T13:45:01Z' })
assert.equal(check(eta, 'eta_vs_promise').outcome, 'fail')
const plateau = get('CD-420710')
position(plateau, { distance_remaining_km: 172 })
assert.equal(check(plateau, 'progress_plateau').outcome, 'fail')
plateau.related.tracking_observations.reverse()
assert.equal(check(plateau, 'progress_plateau').outcome, 'fail')
position(plateau, { distance_remaining_km: null })
assert.equal(check(plateau, 'progress_plateau').outcome, 'unknown', 'No invented zero km for missing numeric data')
const one = readAppPositions(plateau).find((entry) => entry.details.distance_remaining_km === 172)
plateau.related.tracking_observations = [one, row('invalid-number', { ...one.details, observed_at: '2026-10-21T08:40:00Z', distance_remaining_km: '172' })]
assert.equal(check(plateau, 'progress_plateau').outcome, 'unknown', 'String distances are not valid numbers')

const ferry = get('CD-420603')
const booking = ferry.related.travel_reservations.find((entry) => entry.details.kind === 'FERRY')
ferry.messages = ferry.messages.filter((message) => message.authorType !== 'driver')
assert.equal(check(ferry, 'ferry_cutoff').classification, 'agent_investigate')
const gate = row('gate', { reservation_id: 'another-booking', assignment_id: booking.details.assignment_id, kind: 'CHECK_IN_ACCEPTED',
  occurred_at: '2026-10-21T08:00:00Z', recorded_at: '2026-10-21T08:01:00Z' })
ferry.related.ferry_terminal_events = [gate]
assert.equal(check(ferry, 'ferry_cutoff').outcome, 'fail')
gate.details.reservation_id = booking.id
gate.details.kind = 'CHECK_IN_REJECTED'
assert.equal(check(ferry, 'ferry_cutoff').outcome, 'fail')
gate.details.kind = 'CHECK_IN_ACCEPTED'
assert.equal(check(ferry, 'ferry_cutoff').outcome, 'pass')
gate.details.recorded_at = '2026-10-21T09:01:00Z'
assert.equal(check(ferry, 'ferry_cutoff').outcome, 'fail', 'Gate evidence uploaded after NOW is unavailable')
ferry.events.push({ id: 'accepted', command: 'travel.check_in_confirmed', targetId: booking.id, recordedAt: '2026-10-21T08:30:00Z', details: { source: 'terminal_gate' } })
assert.equal(check(ferry, 'ferry_cutoff').outcome, 'pass')
const noBooking = get('CD-420603')
noBooking.related.travel_reservations = []
assert.equal(check(noBooking, 'ferry_cutoff').outcome, 'not_applicable', 'An option alone is not a booked ferry')
const messages = get('CD-420603')
const driverAssignment = assignment(messages)
assert.ok(readDriverDelayMessages(messages, driverAssignment).length)
messages.messages = messages.messages.filter((entry) => entry.authorType !== 'driver')
const sample = get('CD-420603').messages.find((entry) => entry.authorType === 'driver')
for (const body of ['I am not delayed at the terminal.', 'The queue at the hotel breakfast is stuck.', 'Please ask whether the ferry driver is delayed.']) {
  messages.messages.push({ ...sample, id: body, body, details: { ...sample.details, author_id: 'another-driver' } })
}
assert.equal(readDriverDelayMessages(messages, driverAssignment).length, 0, 'Wrong driver and operator text cannot establish a delay')
messages.messages.push({ ...sample, id: 'negated-delay', body: 'I am not delayed at the terminal.' })
assert.equal(readDriverDelayMessages(messages, driverAssignment).length, 0, 'Negation is not a delay report')
messages.messages.push({ ...sample, id: 'hotel-queue', body: 'I am stuck in the breakfast queue at the hotel.' })
messages.messages.push({ ...sample, id: 'question', body: 'Please ask whether the ferry driver is delayed.' })
assert.equal(readDriverDelayMessages(messages, driverAssignment).length, 0, 'Unrelated queues and questions are not driver terminal-delay reports')

const sold = get('CD-420299')
assert.equal(check(sold, 'travel_sold_out').outcome, 'fail', 'Alternative quote is not a replacement')
const quote = sold.related.travel_options.find((entry) => entry.details.status === 'AVAILABLE_QUOTE')
const replacement = row('replacement', { kind: 'FERRY', status: 'BOOKED', source_option_id: quote.id, assignment_id: 'old-assignment',
  booked_at: '2026-10-21T08:30:00Z', departure_at: quote.details.departure_at })
sold.related.travel_reservations = [replacement]
assert.equal(check(sold, 'travel_sold_out').outcome, 'fail', 'Replacement must be on the current assignment')
replacement.details.assignment_id = quote.details.assignment_id
assert.equal(check(sold, 'travel_sold_out').outcome, 'pass')
replacement.details.status = 'CANCELLED'
assert.equal(check(sold, 'travel_sold_out').outcome, 'fail')
replacement.details.status = 'BOOKED'
replacement.details.booked_at = '2026-10-21T09:01:00Z'
assert.equal(check(sold, 'travel_sold_out').outcome, 'fail')

const positioning = get('CD-420399')
assignment(positioning).details.positioning = { assessment: 'POSITIONING_NOT_EVIDENCED', next_pickup_start_at: '2026-10-23T09:00:00Z' }
assert.equal(check(positioning, 'positioning_risk').classification, 'agent_investigate')
assignment(positioning).details.positioning.next_pickup_start_at = '2026-10-23T09:00:01Z'
assert.equal(check(positioning, 'positioning_risk').outcome, 'not_applicable')
assignment(positioning).details.positioning.next_pickup_start_at = null
assert.equal(check(positioning, 'positioning_risk').outcome, 'unknown')
const mixed = get('CD-420322')
mixed.alerts.push(...get('CD-420071').alerts)
const multiple = evaluateTriage(mixed)
assert.equal(multiple.classification, 'person_now')
assert.ok(multiple.checks.filter((item) => item.outcome === 'fail').length > 1)
assert.equal(multiple.checks.find((item) => item.rule === 'other_desk').detail, 'Handled by another desk')
mixed.customer.tier = 'key'
assert.equal(evaluateTriage(mixed).priority, 110)
mixed.alerts = []
assert.equal(check(mixed, 'safety_stop').outcome, 'fail', 'Open incident alone is sufficient')
mixed.related.incidents = []
mixed.alerts = get('CD-420322').alerts.filter((alert) => alert.signal === 'SAFETY_STOP')
assert.equal(check(mixed, 'safety_stop').outcome, 'fail', 'Acknowledgement is not resolution')
mixed.alerts[0].status = 'RESOLVED'
mixed.alerts[0].details.resolved_at = NOW
assert.equal(check(mixed, 'safety_stop').outcome, 'pass')
for (const status of ['DELIVERED', 'CANCELLED']) {
  const closed = get('CD-420806')
  closed.order.status = status
  closed.order.lane = status.toLowerCase()
  assert.equal(evaluateTriage(closed).classification, 'fine', 'Historical tracking must not reopen completed work')
}
const driverActivity = readDriverActivity(get('CD-421013'))
assert.ok(driverActivity.some((event) => event.command === 'expense.submitted'))
assert.equal(readOrderContext(get('CD-420071')).moving, true)
const fixedClock = get('CD-420071')
fixedClock.snapshotAt = '2030-01-01T00:00:00Z'
assert.equal(evaluateTriage(fixedClock).classification, 'fine', 'Business calculations always use the single shared NOW')
const mixedDeadlines = get('CD-420399')
mixedDeadlines.order.status = 'IN_TRANSIT'
mixedDeadlines.order.lane = 'moving'
const mixedAssignment = assignment(mixedDeadlines)
mixedAssignment.details.status = 'IN_PROGRESS'
mixedDeadlines.related.tracking_observations = [row('urgent-eta', { source: 'driver_app', assignment_id: mixedAssignment.id,
  segment_id: mixedAssignment.details.segment_ids[0], observed_at: '2026-10-21T08:50:00Z', received_at: '2026-10-21T08:51:00Z',
  estimated_delivery_at: '2026-10-21T10:20:00Z', distance_remaining_km: 30 })]
mixedDeadlines.related.time_windows = [row('urgent-promise', { purpose: 'CUSTOMER_DELIVERY_PROMISE', is_selected: true,
  start_at: '2026-10-21T09:00:00Z', end_at: '2026-10-21T10:00:00Z' })]
const urgent = evaluateTriage(mixedDeadlines)
assert.equal(urgent.classification, 'person_now', 'A lower-priority human issue still determines routing')
assert.equal(urgent.priority, 80)
assert.match(urgent.headline, /20.00 min after/)
assert.equal(urgent.deadline.recordId, 'urgent-promise', 'Headline and deadline both come from the highest-priority issue')
console.log(`PASS: ${table.length} expected routes, all ${results.length} snapshot orders, boundaries, provenance, isolation and read tools.`)
