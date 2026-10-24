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
    SectionHead: ({ title }) => React.createElement('h2', {}, title),
    Empty: ({ children }) => React.createElement('p', {}, children),
  }
  if (name === '../icons' || name === './files') return {}
  return require(name)
}
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(dependencies, loaded, loaded.exports)
const { ActivitySection, HistoryDays } = loaded.exports
const events = Array.from({ length: 8 }, (_, i) => ({ id: `evt-${i}`, at: '2026-10-24T10:00:00Z', text: `Event ${i}`, detail: null, actor: null, shared: false }))
const view = { history: [{ key: 'day', label: 'Today', events }], historyTotal: events.length }
const render = (Component, ids = []) => renderToStaticMarkup(React.createElement(Component, { view, hoveredEventIds: ids }))
const idle = render(ActivitySection)
assert.ok(!idle.includes('bg-yellow-50'))
assert.ok(!idle.includes('data-event-id="evt-7"'))
for (const Component of [ActivitySection, HistoryDays]) {
  const highlighted = render(Component, ['evt-1', 'evt-7'])
  assert.equal((highlighted.match(/class="event bg-yellow-50"/g) ?? []).length, 2)
  assert.ok(highlighted.includes('class="event bg-yellow-50" data-event-id="evt-1"'))
  assert.ok(highlighted.includes('class="event bg-yellow-50" data-event-id="evt-7"'))
  assert.ok(highlighted.includes('class="event" data-event-id="evt-0"'))
  assert.ok(!render(Component).includes('bg-yellow-50'), 'Clearing hover must clear every highlight')
  assert.ok(!render(Component, ['unknown-event']).includes('bg-yellow-50'))
}
console.log('Verified timeline evidence highlighting in Activity and All events, older cited event visibility, unrelated events, and clearing hover.')
