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
const render = (Component) => renderToStaticMarkup(React.createElement(Component, { view }))
const idle = render(ActivitySection)
assert.ok(!idle.includes('bg-yellow-50'))
assert.ok(!idle.includes('data-event-id="evt-7"'))
const history = render(HistoryDays)
assert.ok(history.includes('class="event" data-event-id="evt-7"'))
assert.equal((idle.match(/class="event"/g) ?? []).length, 6)
assert.equal((history.match(/class="event"/g) ?? []).length, 8)
assert.ok(!history.includes('bg-yellow-50'))
console.log('Verified plain timeline events and the six-event Activity preview after removing evidence highlighting.')
