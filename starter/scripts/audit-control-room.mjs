import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
const { needsControlRoomReview, reviewReasons, reviewType, REVIEW_COLUMNS } = createRequire(import.meta.url)('../lib/present/review.ts')
const base = process.env.APP_URL ?? 'http://localhost:3000'
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`)
  return response.json()
}
const [register, queue] = await Promise.all([get('/api/deliveries'), get('/api/overview')])
const queued = new Map(queue.visible.map((card) => [card.id, card]))
assert.equal(queued.size, queue.visible.length, 'Orders must appear only once')
const expected = register.visible.filter(needsControlRoomReview)
assert.deepEqual([...queued.keys()].sort(), expected.map((card) => card.id).sort(), 'SQL candidates and full-register evidence assessment must agree')
const audited = []
let next = 0
const evidenceKeys = (attention) => attention.map((item) => `${item.kind}:${item.recordId}:${item.tone}`).sort()
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < register.visible.length) {
    const card = register.visible[next++]
    const detail = await get('/api/orders/' + encodeURIComponent(card.id))
    assert.deepEqual(evidenceKeys(card.attention), evidenceKeys(detail.view.attention), `${card.reference}: board and detail must assess the same evidence`)
    const inQueue = queued.has(card.id)
    const manualComplete = card.agentMode === 'MANUAL_COMPLETE'
    if (!manualComplete && card.displayLane === 'moving' && !['DELIVERED', 'CANCELLED'].includes(card.status.toUpperCase())) {
      const snapshot = Date.parse(register.snapshotAt)
      for (const assignment of (detail.related.work_assignments ?? []).filter((row) => row.details.status === 'IN_PROGRESS')) {
        const observations = (detail.related.tracking_observations ?? []).filter(({ details: signal }) => signal.source === 'driver_app'
          && (signal.assignment_id ? signal.assignment_id === assignment.id : (assignment.details.segment_ids ?? []).includes(signal.segment_id))
          && Date.parse(signal.observed_at) <= snapshot && Date.parse(signal.received_at) <= snapshot
          && Date.parse(signal.received_at) >= Date.parse(signal.observed_at))
          .sort((a, b) => String(b.details.observed_at).localeCompare(String(a.details.observed_at)))
        const latest = observations[0]?.details
        if (!latest || latest.location_quality === 'STALE' || snapshot - Date.parse(latest.observed_at) >= 4 * 3_600_000) {
          assert.ok(inQueue, `${card.reference}: stale or missing active-trip tracking must not be hidden`)
        }
      }
    }
    const unfinished = (detail.related.work_items ?? []).some((row) => ['OPEN', 'NEEDS_EXTERNAL_INPUT', 'IN_PROGRESS', 'WAITING'].includes(row.details.status))
    const rejected = (detail.related.proofs ?? []).some((row) => row.details.required && row.details.status === 'REJECTED')
    if (!manualComplete && (unfinished || rejected || detail.view.header.keyDates.some((date) => ['promise', 'pickup_slot'].includes(date.key) && ['danger', 'warn'].includes(date.tone)))) {
      assert.ok(inQueue, `${card.reference}: an unfinished check, rejected required proof or threatened selected window must not be hidden`)
    }
    const activeAlerts = detail.alerts.filter((alert) => ['OPEN', 'ACKNOWLEDGED'].includes(alert.status))
    const column = inQueue ? reviewType(card) : null
    const priorVisible = activeAlerts.length > 0 || card.isBlocked || card.agentMode === 'MANUAL' || card.status.toUpperCase() === 'FOLLOW_UP'
    const reasons = reviewReasons(card).map((item) => ({ title: item.title, detail: item.detail, kind: item.kind, sourceId: item.recordId, at: item.at }))
    const latestDirect = (detail.related.tracking_observations ?? []).filter((row) => row.details.source === 'driver_app')
      .sort((a, b) => String(b.details.observed_at).localeCompare(String(a.details.observed_at)))[0]
    audited.push({ id: card.id, reference: card.reference, status: card.status, column, newlySurfaced: inQueue && !priorVisible,
      reasons, activeAlerts: activeAlerts.map((alert) => ({ id: alert.id, status: alert.status, signal: alert.signal })),
      tracking: latestDirect ? { sourceId: latestDirect.id, observedAt: latestDirect.details.observed_at, receivedAt: latestDirect.details.received_at } : null,
      quietExplanation: inQueue ? null : manualComplete ? 'Manual resolution recorded; no new active alert.'
        : card.attention.length ? 'Only conversation context or an unconfirmed inbox candidate; no independently actionable issue.'
        : 'No active alert, blocked work, outstanding check or stale/missing active-trip evidence.' })
  }
}))
audited.sort((a, b) => a.reference.localeCompare(b.reference))
const counts = Object.fromEntries(REVIEW_COLUMNS.map((column) => [column.title, audited.filter((order) => order.column === column.id).length]))
const report = { snapshotAt: register.snapshotAt, auditedAt: new Date().toISOString(), total: audited.length, needsAttention: queued.size,
  quiet: audited.length - queued.size, newlySurfaced: audited.filter((order) => order.newlySurfaced).length, counts, orders: audited }
const escape = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
const heading = (column) => REVIEW_COLUMNS.find((item) => item.id === column)?.title ?? 'Quiet'
const markdown = [
  '# Control Room: all-order evidence audit', '',
  `Snapshot: ${report.snapshotAt}. Checked ${report.total} orders: **${report.needsAttention} need attention**, **${report.quiet} stay quiet**. ${report.newlySurfaced} were missed by the former stored-alert-only filter.`, '',
  Object.entries(counts).map(([name, count]) => `${name}: ${count}`).join(' · '), '',
  'Tracking policy: review active trips after four hours without a fresh driver-app observation, or when the active assignment has no driver-app position. Use observed and received times at the dataset snapshot. A recent upload of old data, a different assignment, or an inferred location does not restore freshness. Fresh coarse signals alone do not require review.', '',
  'Also assess unresolved incidents/claims, rejected or missing required handover evidence, selected pickup/delivery timing, pending or failed agent work, open work items, verification checks, owned waits/custody checks, and confirmed open inbox work. An open conversation or unconfirmed inbox candidate alone does not diagnose an order problem. Future owned checks stay in Follow-up; overdue checks require review. Explicit Follow-up/Manual ownership takes precedence over historical severity.', '',
  'These are derived review signals. The source dataset and its recorded alert histories were not modified.', '',
  '| Order | Order state | Review group | Reason and source |', '| --- | --- | --- | --- |',
  ...audited.map((order) => `| ${order.reference} | ${escape(order.status)} | ${heading(order.column)}${order.newlySurfaced ? ' (new)' : ''} | ${escape(order.column ? order.reasons.map((reason) => `${reason.title} [${reason.sourceId}${reason.at ? `; ${reason.at}` : ''}]`).join('; ') || 'Saved operational ownership or blocked state.' : order.quietExplanation)} |`), '',
].join('\n')
await mkdir('reports', { recursive: true })
await Promise.all([writeFile('reports/control-room-audit.json', JSON.stringify(report, null, 2) + '\n'), writeFile('reports/control-room-audit.md', markdown)])
console.log(`Audited ${report.total} orders: ${report.needsAttention} need attention, ${report.quiet} quiet, ${report.newlySurfaced} newly surfaced. ${JSON.stringify(counts)}`)
console.log('Verified unique placement and board/detail evidence parity for every order. Wrote reports/control-room-audit.md and .json.')
