"use client"

import Link from "next/link"
import { useState } from "react"
import type { AgentClosedRow, ControlRow, ControlSection, ControlTable as Table, ScanRow } from "@/lib/present/control-table"
import { fmtClock, fmtDateTime, fmtLong } from "@/lib/present/time"
import { Icon } from "./icons"
import styles from "./control-table.module.css"

const SECTIONS: { id: ControlSection; title: string; description: string; empty: string }[] = [
  { id: "review", title: "Needs a review", description: "An open problem. Read the agent's report and decide; the agent only suggests.", empty: "Nothing here" },
  { id: "pending", title: "Pending", description: "A person approved a step that asks someone something. Back to review when they answer or time runs short.", empty: "Nothing here" },
  { id: "manual", title: "Manual control", description: "An operator took over. It stays here until they end manual control.", empty: "Nothing here" },
]

const FLAG_WORDS: Record<NonNullable<ControlRow["flag"]>["kind"], string> = {
  new_reply: "New reply", no_reply: "No reply yet", agreed: "Agreed", declined: "Declined", replied: "Replied",
  found_by_agent: "No alert, found by agent", agent_unsure: "Agent couldn't confirm", reopened: "Reopened by operator",
}

/** What the agent closed on its own today, collapsed, so a person can see why and reopen it. */
function AgentClosedList({ rows, onOpen, onChanged }: { rows: AgentClosedRow[]; onOpen: (order: { id: string; reference: string }) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  async function reopen(row: AgentClosedRow) {
    setBusy(row.id); setError("")
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(row.id)}/scan/reopen`, { method: "POST", signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "It couldn't be reopened.")
      onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "It couldn't be reopened.") } finally { setBusy(null) }
  }
  return <details className={styles.closed}>
    <summary>Closed by the agent today ({rows.length})</summary>
    {error && <p role="alert" className={styles.demoError}>{error}</p>}
    {rows.length ? <ul>{rows.map((row) => <li key={row.id}>
      <div>
        <button type="button" className={styles.stripRef} onClick={() => onOpen({ id: row.id, reference: row.reference })}>{row.reference}</button>
        <span className={styles.stripCar}> {row.vehicle}</span>
        <span className={styles.muted}> · closed <time dateTime={row.at} title={fmtLong(row.at)}>{fmtClock(row.at)}</time></span>
      </div>
      <p><span className={styles.kind}>Checked</span>{row.checked}</p>
      {row.verdict && <p className={styles.muted}>{row.verdict}</p>}
      {row.reply && <p className={styles.closedReply}>“{row.reply.body}” — {row.reply.from}, <time dateTime={row.reply.at}>{fmtClock(row.reply.at)}</time>
        {row.reply.source && <span className={styles.flag}>{row.reply.source}</span>}</p>}
      {row.sources.length > 0 && <p className={styles.muted}>Sources: {row.sources.join("; ")}</p>}
      <button type="button" className={`agent-secondary ${styles.small}`} disabled={busy !== null} onClick={() => void reopen(row)}>
        {busy === row.id ? "Reopening…" : "Reopen"}</button>
    </li>)}</ul> : <p className={styles.muted}>Nothing closed by the agent today.</p>}
  </details>
}

/**
 * Possible problems with no alert. Collapsed by default. Nothing runs on page load: the local model is slow,
 * so a person starts the check, for all ("Check all", one order at a time) or for one order.
 */
function ScanStrip({ rows, now, onOpen, onChanged }: { rows: ScanRow[]; now: string; onOpen: (order: { id: string; reference: string }) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})
  if (!rows.length) return null
  async function check(row: ScanRow) {
    setRunning(row.id)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(row.id)}/scan`, { method: "POST", signal: AbortSignal.timeout(300_000) })
      const result = await response.json().catch(() => ({}))
      const text = !response.ok ? "Agent couldn't check it; try again"
        : result.outcome === "cleared" ? `Closed by the agent. Checked: ${result.checked}. ${VERDICT_WORDS[result.verdict as string] ?? ""}`
        : result.outcome === "asked_driver" ? `Asked ${result.driver}, waiting`
        : result.outcome === "escalated" ? `${result.kind === "unsure" ? "Agent couldn't confirm" : "Needs a person"}: ${result.reason}. ${VERDICT_WORDS[result.verdict as string] ?? ""}`
        : "Nothing to check any more"
      setResults((current) => ({ ...current, [row.id]: text }))
    } catch { setResults((current) => ({ ...current, [row.id]: "Agent couldn't check it; try again" })) }
    finally { setRunning(null) }
  }
  async function checkAll() {
    setOpen(true)
    for (const row of rows) await check(row)
    onChanged()
  }
  return <section className={styles.strip} aria-labelledby="scan-strip-title">
    <header>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={14} /><span id="scan-strip-title">⚠ {rows.length} possible problem{rows.length === 1 ? "" : "s"} with no alert</span>
      </button>
      <button type="button" className={`agent-secondary ${styles.small}`} disabled={running !== null} onClick={() => void checkAll()}>
        {running ? "Checking…" : "Check all"}</button>
    </header>
    {open && <ul className={styles.stripRows}>{rows.map((row) => <li key={row.id}>
      <button type="button" className={styles.stripRef} onClick={() => onOpen({ id: row.id, reference: row.reference })}>{row.reference}</button>
      <span className={styles.stripCar}>{row.vehicle}</span>
      <span className={styles.stripIssue}>{row.issue}</span>
      <span className={styles.muted}>{row.deadline ? <span title={`${row.deadline.label}: ${fmtLong(row.deadline.at)}`}>{row.deadline.label} {until(row.deadline.at, now)}</span> : "No deadline recorded"}</span>
      <span className={styles.stripStatus} role="status">{running === row.id ? "Checking…" : results[row.id] ?? row.status}</span>
      <button type="button" className="show-more" disabled={running !== null} onClick={() => void check(row).then(onChanged)}>Ask the agent to check</button>
    </li>)}</ul>}
  </section>
}

const VERDICT_WORDS: Record<string, string> = {
  fine: "Agent's verdict: fine", needs_person: "Agent's verdict: needs a person", unsure: "Agent's verdict: unsure",
}

/** Red, yellow or green, always with the word. */
const URGENCY_WORDS = { Now: "Urgent", Today: "Not urgent", Later: "Calm" } as const

/** "2 h 10 min" between two times; "0 min" when they are the same. */
export function duration(from: number, to: number): string {
  const minutes = Math.max(0, Math.round((to - from) / 60_000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `${Math.round(hours / 24)} d`
  return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`
}

/** "in 2 h 10 min" or "2 h ago", measured from business time. */
export function until(at: string, now: string): string {
  const delta = Date.parse(at) - Date.parse(now)
  return delta >= 0 ? `in ${duration(0, delta)}` : `${duration(0, -delta)} ago`
}

function Row({ row, now, onOpen }: { row: ControlRow; now: string; onOpen: (order: { id: string; reference: string }) => void }) {
  return <Link href={`/orders/${row.id}`} className={`control-order ${styles.row} ${styles[`edge${row.urgency}`]}`} aria-haspopup="dialog" onNavigate={(event) => {
    event.preventDefault(); onOpen({ id: row.id, reference: row.reference })
  }}>
    <div className={styles.top}>
      <span className={styles.urgency} title={`Priority ${row.priority}`}><span className={styles[`dot${row.urgency}`]} />{URGENCY_WORDS[row.urgency]} · {row.urgency}</span>
      {row.flag && <span className={`${styles.flag} ${styles[row.flag.kind]}`}>
        {FLAG_WORDS[row.flag.kind]}
        {row.flag.at && <> · <time dateTime={row.flag.at} title={fmtLong(row.flag.at)}>{fmtClock(row.flag.at)}</time></>}
      </span>}
      <span className="control-reference">{row.reference}</span>
    </div>
    <h4 className={styles.title}>{row.vehicle} <span>· {row.from} → {row.to}</span></h4>
    {row.section === "pending" && row.waiting ? <p className={styles.line}>
      Waiting for {row.waiting.who ? <b>{row.waiting.who}</b> : "an answer"} · {row.waiting.about}
      <br /><span className={styles.muted}>Since <time dateTime={row.waiting.since} title={fmtLong(row.waiting.since)}>{fmtClock(row.waiting.since)}</time>
        {" "}· waiting {duration(Date.parse(row.waiting.since), Date.parse(now))}</span>
    </p> : <>
      {row.flag && <p className={styles.line}>{row.flag.text}</p>}
      {!row.flag && <p className={styles.line}>{row.line.kind === "reading" && <span className={styles.kind}>Agent thinks</span>}{row.line.text}</p>}
      {row.section === "review" && <p className={styles.line}>{row.suggestion
        ? <><span className={styles.kind}>Suggested</span>{row.suggestion}</> : <span className={styles.muted}>No suggestion yet</span>}</p>}
    </>}
    <div className={styles.foot}>
      {row.deadline ? <span title={`${row.deadline.label}: ${fmtLong(row.deadline.at)}`}>
        {row.section === "pending" ? "Answer needed before" : row.deadline.label} {until(row.deadline.at, now)}</span>
        : <span className={styles.muted}>No deadline recorded</span>}
      <span>{row.customer}</span>
      <span className={styles.open}>Open <Icon name="chevron" size={14} /></span>
    </div>
  </Link>
}

export function ControlTableView({ table, search, onOpen, onChanged }: { table: Table; search: string; onOpen: (order: { id: string; reference: string }) => void; onChanged: () => void }) {
  const pendingCount = table.sections.pending.length
  const [pendingOpen, setPendingOpen] = useState<boolean | null>(null)
  const query = search.trim().toLowerCase()
  const match = (row: ControlRow) => !query || [row.reference, row.vehicle, row.customer, row.from, row.to].some((field) => field.toLowerCase().includes(query))

  return <>
  <ScanStrip rows={table.strip} now={table.now} onOpen={onOpen} onChanged={onChanged} />
  <div className={styles.sections}>
    {SECTIONS.map((section) => {
      const rows = table.sections[section.id].filter(match)
      const collapsible = section.id === "pending" && pendingCount > 5
      const open = !collapsible || (pendingOpen ?? false)
      return <section key={section.id} className={`review-column ${styles.section}`} aria-labelledby={`control-${section.id}`}>
        <header className="review-column-head">
          <h3 id={`control-${section.id}`}>{collapsible
            ? <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setPendingOpen(!open)}>
              <Icon name="chevron" size={14} />{section.title}</button> : section.title}
            <span className="control-count">{rows.length}</span></h3>
          <p>{section.id === "pending" && table.waitingCloseToDeadline > 0
            ? `${table.waitingCloseToDeadline} close to their deadline · ` : ""}{section.description}</p>
        </header>
        {!open ? null : rows.length ? <ul className="control-list">{rows.map((row) => <li key={row.id}><Row row={row} now={table.now} onOpen={onOpen} /></li>)}</ul>
          : <p className="review-column-empty">{section.empty}</p>}
      </section>
    })}
  </div>
  <AgentClosedList rows={table.agentClosed} onOpen={onOpen} onChanged={onChanged} />
  </>
}

/** Small, clearly separate controls for running the demo. They change only the shared business clock. */
export function DemoControls({ now, onChanged }: { now: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function skip() {
    setBusy(true); setError("")
    try {
      const response = await fetch("/api/demo/clock", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: 60 }), signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error()
      onChanged()
    } catch { setError("The clock couldn't be moved. Try again.") } finally { setBusy(false) }
  }
  return <aside className={styles.demo} aria-label="Demo controls">
    <span className={styles.demoLabel}>Demo controls</span>
    <span>Business time {now ? <time dateTime={now} title={fmtLong(now)}>{fmtDateTime(now)}</time> : "…"}</span>
    <button type="button" className="agent-secondary" disabled={busy} onClick={() => void skip()}>Skip ahead 1 h</button>
    {error && <span role="alert" className={styles.demoError}>{error}</span>}
    <small>Moves the shared simulated clock for everyone. Nothing real happens.</small>
  </aside>
}
