"use client"

import Link from "next/link"
import { useState } from "react"
import type { ControlRow, ControlSection, ControlTable as Table } from "@/lib/present/control-table"
import { fmtClock, fmtDateTime, fmtLong } from "@/lib/present/time"
import { Icon } from "./icons"
import styles from "./control-table.module.css"

const SECTIONS: { id: ControlSection; title: string; description: string; empty: string }[] = [
  { id: "review", title: "Needs a review", description: "An open problem. Read the agent's report and decide; the agent only suggests.", empty: "Nothing here" },
  { id: "pending", title: "Pending", description: "A person approved a step that asks someone something. Back to review when they answer or time runs short.", empty: "Nothing here" },
  { id: "manual", title: "Manual control", description: "An operator took over. It stays here until they end manual control.", empty: "Nothing here" },
]

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
        {row.flag.kind === "new_reply" ? "New reply" : row.flag.kind === "no_reply" ? "No reply yet" : row.flag.kind === "agreed" ? "Agreed" : "Declined"}
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

export function ControlTableView({ table, search, onOpen }: { table: Table; search: string; onOpen: (order: { id: string; reference: string }) => void }) {
  const pendingCount = table.sections.pending.length
  const [pendingOpen, setPendingOpen] = useState<boolean | null>(null)
  const query = search.trim().toLowerCase()
  const match = (row: ControlRow) => !query || [row.reference, row.vehicle, row.customer, row.from, row.to].some((field) => field.toLowerCase().includes(query))

  return <div className={styles.sections}>
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
