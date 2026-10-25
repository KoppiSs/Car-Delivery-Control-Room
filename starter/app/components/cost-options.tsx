"use client"

// Money decisions: the options side by side, the operator picks. Nothing here books anything.

import { useState } from "react"
import type { CostDecision } from "@/lib/customer-email"
import type { CostOption, CostOptions } from "@/lib/cost-options"
import { fmtClock, fmtLong } from "@/lib/present/time"
import styles from "./cost-options.module.css"

const LABELS = { reliable: "Reliable", lower_cost: "Lower cost", only: "Only option", best: "Earliest and cheapest", driver_swap: "Another driver", move_pickup: "Move the pickup" } as const

export function CostOptionsCard({ orderId, options, decision, busy, onDecided, onDraft }: {
  orderId: string
  options: CostOptions
  decision: CostDecision | null
  busy: boolean
  onDecided: () => void
  /** Opens an email draft: to the customer, or to the pickup site for a new handover time. */
  onDraft: (templateId: "delivery_delay" | "status_update" | "site_pickup_time") => void
}) {
  const [picked, setPicked] = useState<CostOption | null>(null)
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function confirm() {
    if (!picked || !reason.trim()) return
    setSaving(true); setError("")
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cost-decision`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ optionId: picked.id, reason: reason.trim() }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "Your choice couldn't be saved.")
      setPicked(null); setReason("")
      onDecided()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your choice couldn't be saved.") } finally { setSaving(false) }
  }

  return <section className="agent-proposal" aria-labelledby="cost-options-title">
    <div className="agent-proposal-heading"><h2 id="cost-options-title">Your decision</h2><span>{decision ? "Decided" : "Your choice"}</span></div>
    <p>{options.reason}. You decide; the options come from the quotes on file.</p>
    {error && <div className="agent-inline-error" role="alert"><p>{error}</p></div>}

    {decision && <div className={styles.decided}>
      <p><b>You chose</b> · <time dateTime={decision.at} title={fmtLong(decision.at)}>{fmtClock(decision.at)}</time>: {decision.what}</p>
      <p className={styles.small}>{decision.costText} · {decision.arrivalText}. Why: {decision.reason}</p>
      {decision.suggestion === "site_pickup_time"
        ? <><p className={styles.next}><span className={styles.kind}>Suggested</span>Ask the pickup site for a new handover time first; tell the customer once the site agrees.</p>
          <button type="button" className="agent-primary" disabled={busy} onClick={() => onDraft("site_pickup_time")}>Draft new handover time email</button></>
        : decision.suggestion === "delivery_delay"
        ? <><p className={styles.next}><span className={styles.kind}>Suggested</span>This misses the delivery promise, so ask the customer to agree a new window.</p>
          <button type="button" className="agent-primary" disabled={busy} onClick={() => onDraft("delivery_delay")}>Draft confirmed delay email</button></>
        : <><p className={styles.next}>No customer email needed: the delivery promise still holds.</p>
          <button type="button" className="show-more" disabled={busy} onClick={() => onDraft("status_update")}>Send a status update anyway</button></>}
    </div>}

    <div className={styles.options}>
      {options.options.map((option) => {
        const recommended = options.recommendation?.optionId === option.id
        return <article key={option.id} className={`${styles.option}${recommended ? ` ${styles.recommended}` : ""}${decision?.optionId === option.id ? ` ${styles.chosen}` : ""}`}>
          {/* The recommendation replaces the option's own tag; "Only option" shows only when nothing is recommended. */}
          <header>{recommended ? <span className={styles.tag}>Recommended</span>
            : option.labels.map((name) => <span key={name} className={styles.tag}>{LABELS[name]}</span>)}</header>
          {recommended && <p className={styles.recommendation}>{options.recommendation!.text}</p>}
          <p className={styles.what}>{option.what}</p>
          <dl>
            <dt>Cost</dt><dd>{option.costText}</dd>
            <dt>Arrival</dt><dd className={option.meetsTarget === false ? styles.late : undefined}>{option.arrivalText}</dd>
            <dt>Customer</dt><dd>{option.agreementText}</dd>
          </dl>
          <button type="button" className="agent-secondary" disabled={busy || saving} aria-pressed={picked?.id === option.id}
            onClick={() => setPicked(option)}>{picked?.id === option.id ? "Picked" : "Pick this"}</button>
        </article>
      })}
    </div>
    {/* What the data does not offer: one small grey line under the cards. */}
    {(options.onlyOne || options.notOnFile.length > 0) && <p className={styles.footnote}>
      {[options.onlyOne?.note, options.onlyOne?.missing, ...options.notOnFile].filter((line) => !!line).join(" · ")}</p>}

    {picked && <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); void confirm() }}>
      <label htmlFor="cost-reason">Why this option? One line</label>
      <input id="cost-reason" className="agent-line-input" value={reason} maxLength={300} required autoFocus
        onChange={(event) => setReason(event.target.value.replace(/[\r\n]/g, " "))} placeholder="Arrives in time and the price is fine for this customer" />
      <div className="agent-actions">
        <button type="submit" className="agent-primary" disabled={saving || !reason.trim()}>{saving ? "Saving…" : "Confirm my choice"}</button>
        <button type="button" className="agent-secondary" disabled={saving} onClick={() => setPicked(null)}>Cancel</button>
      </div>
      <p className="agent-approval-note">Stored as your decision. Nothing is booked.</p>
    </form>}
  </section>
}
