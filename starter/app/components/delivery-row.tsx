"use client"

import { useCallback, useEffect, useState } from "react"
import type { DeliveriesOverview, BoardCard } from "@/lib/present/types"
import { fmtClock, fmtLong } from "@/lib/present/time"
import { Icon } from "./icons"
import { SourceTag } from "./statements"
import styles from "./delivery-row.module.css"

type Checks = NonNullable<DeliveriesOverview["checks"]>[string]

const STORAGE_KEY = "control-room:deliveries-expanded"

/**
 * Which rows are open. A viewing preference, so it lives in this browser tab's session:
 * it survives switching between the control table and All deliveries, not a new session.
 */
export function useExpandedRows() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]")
      if (Array.isArray(saved)) setExpanded(new Set(saved.filter((id): id is string => typeof id === "string")))
    } catch { /* storage unavailable: start collapsed */ }
  }, [])
  const save = (next: Set<string>) => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next])) } catch { /* not remembered */ }
    return next
  }
  const toggle = useCallback((id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return save(next)
  }), [])
  const setAll = useCallback((ids: string[], open: boolean) => setExpanded(() => save(open ? new Set(ids) : new Set())), [])
  return { expanded, toggle, setAll }
}

const OUTCOME_WORDS = { pass: "Fine", fail: "Problem", unknown: "Not known", not_applicable: "Not ours" } as const

export function DeliveryRow({ card, checks, checkedAt, expanded, onToggle, onOpen }: {
  card: BoardCard; checks: Checks | undefined; checkedAt: string | null; expanded: boolean; onToggle: () => void; onOpen: () => void
}) {
  const panelId = `delivery-details-${card.id}`
  return <div className={styles.row}>
    {/* A native button: Enter and Space toggle the row. */}
    <button type="button" className={styles.summary} aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
      <Icon name="chevron" size={14} />
      <span className={styles.reference}>{card.reference}</span>
      <span className={styles.car}>{card.vehicle}</span>
      <span className={styles.route}>{card.from.city} → {card.to.city}</span>
      <span className={`chip-fact ${styles.status}`}><span className={`dot lane-${card.displayLane}`} />{card.statusLabel}</span>
      <span className={styles.checked}>
        {checks ? <>Checked {checkedAt ? <time dateTime={checkedAt} title={fmtLong(checkedAt)}>{fmtClock(checkedAt)}</time> : ""}: {checks.summary}</> : "Checks not loaded"}
        {checks?.notInTable && checks.notInTable !== "Nothing needs a person" && <span className={styles.note}> · {checks.notInTable}</span>}
      </span>
    </button>
    {/* Details render only when open, so a long list stays fast. */}
    {expanded && <div id={panelId} className={styles.details}>
      {checks?.table ? <p className={styles.state}>In the control table: <b>{checks.table}</b></p>
        : checks?.notInTable && <p className={styles.state}>Not in the control table: {checks.notInTable}</p>}
      {checks?.checks.length ? <ul className={styles.checks}>{checks.checks.map((check) => <li key={check.rule} className={styles[check.outcome]}>
        <span className={styles.outcome}>{OUTCOME_WORDS[check.outcome]}</span>
        <div><p>{check.text}</p>
          {check.sources.length > 0 ? <p className={styles.sources}>{check.sources.map((source, index) => <span key={`${source.collection}:${source.recordId}`}>
            {index > 0 && "; "}{source.what} — <SourceTag source={source} /></span>)}</p>
            : <p className={styles.sources}>No record behind this check</p>}
        </div>
      </li>)}</ul> : <p className={styles.state}>No checks apply to this delivery at this stage.</p>}
      <button type="button" className="agent-secondary" onClick={onOpen}>Open order</button>
    </div>}
  </div>
}
