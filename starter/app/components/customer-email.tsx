"use client"

import { Fragment, useCallback, useEffect, useRef, useState } from "react"
import type { EmailCase, EmailDraft, EmailOverview, Recipient } from "@/lib/customer-email"
import { fmtClock, fmtDateTime, fmtLong } from "@/lib/present/time"
import {
  FIELD_LABELS, RECIPIENT_LABELS, RECIPIENT_TYPES, TEMPLATE_IDS, TEMPLATES, emptyRequired, render, type RecipientType, type TemplateId,
} from "@/lib/templates"
import type { Detail } from "./order-detail"
import styles from "./customer-email.module.css"
import { ReplyComposer } from "./reply-composer"
import { CostOptionsCard } from "./cost-options"

type Phase = "closed" | "loading" | "choose" | "edit"
type Failure = { message: string; retry: (() => void) | null }

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  // One 15 s budget for the whole exchange, response body included, so nothing can wait forever.
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
    const data = await response.json().catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "TimeoutError") throw cause
      return {}
    }) as T & { error?: string }
    if (!response.ok) return { ok: false, status: response.status, message: data.error ?? "Something went wrong. Please try again." }
    return { ok: true, data }
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError"
    return { ok: false, status: 0, message: timedOut
      ? "The server took longer than 15 seconds to answer. Try again."
      : "We couldn't reach the server. Check the connection and try again." }
  }
}

const post = (body?: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })

function Clock({ at }: { at: string }) {
  return <time dateTime={at} title={fmtLong(at)}>{fmtClock(at)}</time>
}

/** The recipient's name with their role, and a warning when the site contact is unconfirmed. */
function RecipientName({ recipient }: { recipient: Recipient }) {
  return <>
    <b>{recipient.name}</b>{recipient.role && <span className={styles.role}> · {recipient.role}</span>}
    {!recipient.confirmed && <span className={styles.unconfirmed}>Contact not confirmed</span>}
  </>
}

/** Sent → Replied → Applied, each with its time once it has happened. */
function Timeline({ emailCase }: { emailCase: EmailCase }) {
  const { reply, applied, change } = emailCase
  const steps = [
    { label: "Sent", at: emailCase.sentAt, note: null },
    { label: reply ? (reply.answer === "agree" ? "Agreed" : reply.answer === "decline" ? "Declined" : "Replied") : "Replied", at: reply?.at ?? null,
      note: emailCase.stage === "informed" ? "no reply needed" : null },
    { label: "Applied", at: applied?.at ?? null, note: emailCase.stage === "informed" || (reply?.answer === "agree" && !change) ? "not needed"
      : reply && reply.answer !== "agree" ? "not applied" : null },
  ]
  return <ol className={styles.timeline} aria-label="Email progress">
    {steps.map((step) => <li key={step.label} className={step.at ? styles.reached : step.note ? styles.skipped : ""}>
      <b>{step.label}</b>
      <span>{step.at ? <time dateTime={step.at} title={fmtLong(step.at)}>{fmtDateTime(step.at)}</time> : step.note ?? "Not yet"}</span>
    </li>)}
  </ol>
}

export function CustomerEmailCard({ detail, onUpdate }: { detail: Detail; onUpdate?: () => void }) {
  const orderId = detail.order.id
  const [phase, setPhase] = useState<Phase>("closed")
  const [draft, setDraft] = useState<EmailDraft | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [subject, setSubject] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState("")
  // Who can be written to and where each email stands, as stored. Undefined until the first read.
  const [overview, setOverview] = useState<EmailOverview | undefined>(undefined)
  const [callNote, setCallNote] = useState<{ recipient: RecipientType; text: string } | null>(null)
  // Which recipient's simulated reply is being written.
  const [replyFor, setReplyFor] = useState<RecipientType | null>(null)
  const alive = useRef(true)
  const overviewVersion = useRef(0)
  // Set on every mount: Strict Mode mounts, unmounts and mounts again in development.
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const url = `/api/orders/${encodeURIComponent(orderId)}/customer-email`

  const loadOverview = useCallback(async () => {
    const version = ++overviewVersion.current
    const result = await call<EmailOverview>(url)
    if (!alive.current || version !== overviewVersion.current) return
    if (!result.ok) { setFailure({ message: result.message, retry: () => { setFailure(null); void loadOverview() } }); return }
    setOverview(result.data)
  }, [url])

  // Re-read whenever the order is refreshed, so the card always matches the stored records.
  useEffect(() => { void loadOverview() }, [loadOverview, detail])

  /** After a write: re-read the email state here and refresh the rest of the order. */
  function afterWrite(message: string) {
    setNotice(message)
    void loadOverview()
    onUpdate?.()
  }

  async function loadDraft(templateId: TemplateId, recipient: RecipientType, keep?: Record<string, string>) {
    setPhase("loading"); setFailure(null); setNotice(""); setCallNote(null)
    const result = await call<{ draft: EmailDraft }>(`${url}?template=${templateId}&recipient=${recipient}`)
    if (!alive.current) return
    const next = result.ok ? result.data.draft : null
    if (!next) {
      setFailure({ message: result.ok ? "The email couldn't be prepared from this order. Try again." : result.message,
        retry: () => void loadDraft(templateId, recipient, keep) })
      setPhase(draft ? "edit" : "choose")
      return
    }
    // Keep what the operator wrote into empty fields; take everything else fresh from the order.
    setValues(Object.fromEntries(Object.entries(next.fields).map(([name, field]) =>
      [name, field.filledBy === "empty" && keep?.[name] ? keep[name] : field.value])))
    setDraft(next); setSubject(null); setPhase("edit")
  }

  const template = draft ? TEMPLATES[draft.templateId] : null
  const rendered = draft ? render(draft.templateId, values) : null
  const subjectText = subject ?? rendered?.subject ?? ""
  const empty = draft ? emptyRequired(draft.templateId, values) : []

  async function send() {
    if (!draft || !rendered || busy || empty.length) return
    setBusy(true); setFailure(null)
    const result = await call(url, post({ templateId: draft.templateId, recipientType: draft.recipient.type, subject: subjectText,
      body: rendered.body, fields: values, draftBuiltAt: draft.draftBuiltAt, basis: draft.basis }))
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      // A 409 or 400 keeps the draft as typed; only a network failure offers a plain retry.
      setFailure({ message: result.message, retry: result.status === 0 ? () => void send() : null })
      return
    }
    setDraft(null); setValues({}); setSubject(null); setPhase("closed")
    afterWrite("Recorded as sent. No real email left the system.")
  }

  /** Runs one of the follow-up actions and re-reads the stored state afterwards. */
  async function act(path: string, body: Record<string, unknown>, done: string) {
    if (busy) return
    setBusy(true); setFailure(null); setNotice("")
    const result = await call(`${url}/${path}`, post(body))
    if (!alive.current) return
    setBusy(false)
    if (!result.ok) {
      setFailure({ message: result.message, retry: result.status === 0 ? () => void act(path, body, done) : null })
      void loadOverview()
      return
    }
    if (path === "call") setCallNote(null)
    afterWrite(done)
  }

  function cancel() {
    setDraft(null); setValues({}); setSubject(null); setFailure(null); setPhase("closed")
  }

  function fieldInput(name: string) {
    const field = draft?.fields[name]
    const value = values[name] ?? ""
    const optional = !!template?.optional.includes(name)
    const isEmpty = !value.trim()
    const changed = field?.filledBy === "data" && value.trim() !== field.value
    const hint = isEmpty ? (optional ? "Optional" : "Fill this in")
      : changed ? "Changed by you"
      : field?.filledBy === "data" ? `From ${field.sourceLabel}${field.at ? ` · as of ${fmtDateTime(field.at)}` : ""}`
      : "Written by you"
    return <span className={`${styles.field} ${isEmpty && !optional ? styles.empty : changed ? styles.changed : ""}`}>
      <input className={styles.input} aria-label={FIELD_LABELS[name] ?? name} value={value} placeholder={(FIELD_LABELS[name] ?? name).toLowerCase()}
        size={Math.min(Math.max(value.length, (FIELD_LABELS[name] ?? name).length, 6) + 1, 60)} disabled={busy}
        onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
      <small className={styles.hint} title={field?.at ? fmtLong(field.at) : undefined}>{hint}</small>
    </span>
  }

  /** The template body as text with each {field} replaced by its inline input. */
  function letter(body: string) {
    return body.split("\n\n").map((paragraph, index) => <p key={index}>
      {paragraph.split("\n").map((line, lineIndex) => <Fragment key={lineIndex}>
        {lineIndex > 0 && <br />}
        {line.split(/(\{\w+\})/).map((part, partIndex) => {
          const match = /^\{(\w+)\}$/.exec(part)
          return match ? <Fragment key={partIndex}>{fieldInput(match[1])}</Fragment> : <Fragment key={partIndex}>{part}</Fragment>
        })}
      </Fragment>)}
    </p>)
  }

  function openPicker() {
    setNotice(""); setFailure(null); setCallNote(null); setPhase("choose")
  }

  /** What happened to the latest email to one recipient, and the next step. */
  function outcome(current: EmailCase) {
    const { recipientName: name, reply, change, recipientType: recipient } = current
    const quote = reply && <blockquote className={styles.quote}>“{reply.body}”</blockquote>
    const agreedBox = <div className="follow-up-waiting"><span>Reply</span><p>{name} agreed · <Clock at={reply?.at ?? current.sentAt} /></p>{quote}</div>
    switch (current.stage) {
      case "informed": return <>
        <div className="follow-up-waiting"><span>No reply needed</span><p>{recipient === "customer" ? "Customer" : name} informed · <Clock at={current.sentAt} /></p></div>
        <p className="agent-approval-note">This email only informs. The order stays where it is; if {name} writes back anyway, it shows as a new reply.</p>
        {replyFor === recipient ? <ReplyComposer from={name} question={current.templateLabel} busy={busy}
          initial="Thanks for letting me know. Can someone call me about it?"
          onRecord={(_answer, text) => { setReplyFor(null); void act("reply", { recipient, answer: "other", text }, `Simulated reply from ${name} recorded.`) }}
          onCancel={() => setReplyFor(null)} />
          : <div className="agent-actions">
            <button type="button" className={`agent-secondary ${styles.small}`} disabled={busy} onClick={() => setReplyFor(recipient)}>Simulate: {name} writes back anyway</button>
          </div>}
      </>
      case "waiting": return <>
        <div className="follow-up-waiting"><span>Waiting for a reply</span>
          <p>Waiting for {name} to reply · sent <Clock at={current.sentAt} /></p></div>
        {replyFor === recipient ? <ReplyComposer from={name} question={current.templateLabel} busy={busy}
          initial={recipient === "customer" ? "Agreed, go ahead with the new time." : "Yes, that works."}
          quickPicks={recipient === "customer" ? { agree: "Agreed, go ahead with the new time.", decline: "That doesn't work for us, please call me." }
            : { agree: "Yes, that works.", decline: "No, we can't do that time." }}
          onRecord={(answer, text) => { setReplyFor(null); void act("reply", { recipient, answer, text }, `Simulated reply from ${name} recorded.`) }}
          onCancel={() => setReplyFor(null)} />
          : <div className="agent-actions">
            <button type="button" className={`agent-secondary ${styles.small}`} disabled={busy} onClick={() => setReplyFor(recipient)}>Simulate reply</button>
          </div>}
        <p className="agent-approval-note">For the demo: pick "Agrees" or "Declines", or write any reply. A reply never changes the order by itself.</p>
      </>
      case "agreed": return <>
        {agreedBox}
        <div className="agent-actions">
          <button type="button" className="agent-primary" disabled={busy}
            onClick={() => void act("apply", { recipient }, `Recorded: ${change!.kind} moved to ${change!.to} (simulated).`)}>
            {busy ? "Recording…" : `Change ${change!.kind} to ${change!.to}`}</button>
        </div>
        <p className="agent-approval-note">This records the change as simulated. The {change!.kind} time on the order itself is not edited.</p>
      </>
      case "applied": return <>
        {agreedBox}
        <div className={styles.done}><b>Done</b> · {change!.kind} moved to {change!.to} (simulated) · <Clock at={current.applied!.at} /></div>
        <p className="agent-approval-note">Recorded in the order history. The {change!.kind} time on the order itself was not edited.</p>
      </>
      case "done": return <>
        {agreedBox}
        <div className={styles.done}><b>Done</b> · nothing on the order needs to change.</div>
      </>
      case "replied": return <>
        <div className="follow-up-waiting"><span>Reply</span><p>{name} replied · <Clock at={reply!.at} /></p>{quote}</div>
        <div className="agent-actions">
          <button type="button" className="agent-secondary" disabled={busy} onClick={openPicker}>Draft another email</button>
          <button type="button" className="agent-secondary" disabled={busy} onClick={() => { setNotice(""); setCallNote({ recipient, text: "" }) }}>Log a phone call</button>
        </div>
      </>
      case "declined": return <>
        <div className={styles.attention} role="status"><span>Needs your attention</span><p>{name} declined · <Clock at={reply!.at} /></p>{quote}</div>
        {current.calls.length > 0 && <ul className={styles.calls}>{current.calls.map((entry) => <li key={entry.at}>
          <b>Phone call logged · <Clock at={entry.at} /></b><p>{entry.note}</p></li>)}</ul>}
        {callNote?.recipient !== recipient ? <div className="agent-actions">
          <button type="button" className="agent-secondary" disabled={busy} onClick={openPicker}>Draft another email</button>
          <button type="button" className="agent-secondary" disabled={busy} onClick={() => { setNotice(""); setCallNote({ recipient, text: "" }) }}>Log a phone call</button>
        </div> : <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); if (callNote.text.trim()) void act("call", { recipient, note: callNote.text.trim() }, "Phone call saved as an internal note.") }}>
          <label htmlFor={`call-note-${recipient}`}>What was agreed on the phone?</label>
          <textarea id={`call-note-${recipient}`} value={callNote.text} onChange={(event) => setCallNote({ recipient, text: event.target.value })} maxLength={2000} rows={3} required autoFocus
            placeholder={`Called ${name}. They can do Monday morning instead.`} />
          <div className="agent-actions"><button type="submit" className="agent-primary" disabled={busy || !callNote.text.trim()}>{busy ? "Saving…" : "Save note"}</button>
            <button type="button" className="agent-secondary" disabled={busy} onClick={() => setCallNote(null)}>Cancel</button></div>
          <p className="agent-approval-note">Saved as an internal note on this email thread. {name} does not see it.</p>
        </form>}
      </>
    }
  }

  const stageLabel: Record<EmailCase["stage"], string> = {
    waiting: "Waiting for reply", informed: "Informed", agreed: "Agreed", applied: "Done", done: "Done", declined: "Needs attention", replied: "Replied",
  }
  const cases = overview?.cases ?? []
  const latest = cases[0]
  const status = phase === "edit" ? "Draft" : phase === "choose" || phase === "loading" ? "New email"
    : cases.some((entry) => entry.stage === "declined") ? "Needs attention" : latest ? stageLabel[latest.stage] : "Simulation"
  const anyDeclined = cases.some((entry) => entry.stage === "declined")
  const customerCase = cases.find((entry) => entry.recipientType === "customer")
  const hint = overview?.delayHint
  const hintCase = hint ? cases.find((entry) => entry.recipientType === hint.recipient) : undefined
  const showHint = !!hint && phase === "closed" && hintCase?.stage !== "waiting" && customerCase?.stage !== "waiting"

  return <>
    {overview?.costOptions && phase === "closed" && <CostOptionsCard orderId={orderId} options={overview.costOptions}
      decision={overview.costDecision} busy={busy} onDecided={() => afterWrite("Your cost decision is stored. Nothing was booked.")}
      onDraft={(templateId) => void loadDraft(templateId, templateId === "site_pickup_time" ? "pickup_site" : "customer")} />}
    {showHint && <div className={styles.delayHint} role="note">
      <div>
        <b>{hint.kind === "confirmed" ? "Confirmed delay — the delivery promise will be missed"
          : hint.kind === "site" ? `Ask the ${hint.recipient === "pickup_site" ? "pickup" : "delivery"} site first`
          : hint.kind === "note" ? "Optional: a status update for the customer"
          : "Possible delay — the customer may want to know"}</b>
        <small><span className={styles.kindLabel}>Suggested</span>{TEMPLATES[hint.templateId].label.toLowerCase()}
          {hint.kind === "site" ? ` to ${overview?.recipients[hint.recipient]?.name ?? "the site"}` : ""}, because {hint.because}.</small>
        {hint.reasons.length > 0 && <small>Signals: {hint.reasons.join(" · ")}</small>}
      </div>
      <div className="agent-actions">
        <button type="button" className={`agent-secondary ${styles.small}`} disabled={busy || !overview?.recipients[hint.recipient]}
          onClick={() => void loadDraft(hint.templateId, hint.recipient)}>Draft {TEMPLATES[hint.templateId].label.toLowerCase()}</button>
        {/* The person decides: switch to the other kind before sending. */}
        {(hint.kind === "possible" || hint.kind === "confirmed") && <button type="button" className={`show-more ${styles.small}`} disabled={busy || !overview?.recipients.customer}
          onClick={() => void loadDraft(hint.templateId === "delay_notice" ? "delivery_delay" : "delay_notice", "customer")}>
          Use {hint.templateId === "delay_notice" ? "a confirmed delay (asks for agreement)" : "a possible-delay notice (no reply needed)"} instead</button>}
      </div>
    </div>}
    <section className="agent-proposal" aria-labelledby="customer-email-title" aria-busy={phase === "loading" || busy}>
      <div className="agent-proposal-heading"><h2 id="customer-email-title">Emails</h2><span>{status}</span></div>

      {failure && <div className="agent-inline-error" role="alert"><p>{failure.message}</p>
        {failure.retry && <button type="button" className="agent-retry" disabled={busy} onClick={failure.retry}>Try again</button>}
        {!failure.retry && draft && phase === "edit" && <button type="button" className="agent-retry" disabled={busy}
          onClick={() => void loadDraft(draft.templateId, draft.recipient.type, values)}>Load the latest order data</button>}
      </div>}

      {phase === "closed" && <>
        {cases.map((entry) => <div key={entry.conversationId} className={styles.caseBlock}>
          <p className={styles.caseHead}>To <b>{entry.recipientName}</b> · {RECIPIENT_LABELS[entry.recipientType].toLowerCase()} · {entry.templateLabel}</p>
          <Timeline emailCase={entry} />
          {outcome(entry)}
        </div>)}
        {notice && <p role="status" className="agent-approval-note">{notice}</p>}
        {!anyDeclined && <div className="agent-actions">
          <button type="button" className="agent-secondary" disabled={busy || overview === undefined} onClick={openPicker}>Draft email</button>
        </div>}
      </>}

      {phase === "choose" && overview && <>
        <p>Who is this about, and what do you want to ask?</p>
        {RECIPIENT_TYPES.map((type) => {
          const recipient = overview.recipients[type]
          return <div key={type} className={styles.group}>
            <h3>{RECIPIENT_LABELS[type]}</h3>
            <p className={styles.groupContact}>{recipient ? <RecipientName recipient={recipient} /> : <span className={styles.noContact}>No contact on file</span>}</p>
            <div className={styles.choices}>
              {TEMPLATE_IDS.filter((id) => TEMPLATES[id].recipients.includes(type)).map((id) => <button key={id} type="button" className={styles.choice}
                disabled={!recipient} onClick={() => void loadDraft(id, type)}>
                <strong>{TEMPLATES[id].label}</strong><span>{recipient ? TEMPLATES[id].description : "No contact on file"}</span>
              </button>)}
            </div>
          </div>
        })}
        <div className="agent-actions"><button type="button" className="agent-secondary" onClick={cancel}>Cancel</button></div>
      </>}

      {phase === "loading" && <div className="agent-loading-message" role="status"><p>Filling in the email from the order…</p></div>}

      {phase === "edit" && draft && template && rendered && <form onSubmit={(event) => { event.preventDefault(); void send() }}>
        <div className={styles.meta}>
          <span>To</span><span className={styles.to}><RecipientName recipient={draft.recipient} />
            <small> · {RECIPIENT_LABELS[draft.recipient.type].toLowerCase()}</small></span>
          <label htmlFor="customer-email-subject">Subject</label>
          <input id="customer-email-subject" className={styles.subject} value={subjectText} disabled={busy} onChange={(event) => setSubject(event.target.value)} />
        </div>
        <div className={styles.letter}>
          {letter(template.body)}
          {template.closing && <div className={styles.fixed}>{template.closing}<small>Always included. This sentence can't be edited.</small></div>}
        </div>
        <div className="agent-actions">
          <button type="submit" className="agent-primary" disabled={busy || empty.length > 0}>{busy ? "Recording…" : "Record as sent"}</button>
          <button type="button" className="agent-secondary" disabled={busy} onClick={cancel}>Cancel</button>
        </div>
        {empty.length > 0 && <p className="agent-approval-note">Still to fill in: {empty.map((name) => (FIELD_LABELS[name] ?? name).toLowerCase()).join(", ")}.</p>}
        <p className="agent-approval-note">This is a simulation. No real email is sent.</p>
      </form>}
    </section>
  </>
}
