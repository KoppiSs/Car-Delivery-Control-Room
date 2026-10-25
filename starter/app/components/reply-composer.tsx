"use client"

import { useState } from "react"

export type ReplyPick = "agree" | "decline" | "other"

/**
 * A small box for a simulated reply: pre-filled with a suggestion that answers the question,
 * editable before it is recorded. Customers and sites also get "Agrees" / "Declines" quick picks.
 */
export function ReplyComposer({ from, question, initial, quickPicks, busy, onRecord, onCancel }: {
  from: string
  question: string | null
  initial: string
  quickPicks?: { agree: string; decline: string }
  busy: boolean
  /** `unchanged`: the text is exactly the suggestion it started with, so it keeps that suggestion's source. */
  onRecord: (answer: ReplyPick, text: string, unchanged: boolean) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const [answer, setAnswer] = useState<ReplyPick>(quickPicks && initial === quickPicks.agree ? "agree" : "other")
  const pick = (value: "agree" | "decline") => { if (quickPicks) { setAnswer(value); setText(quickPicks[value]) } }
  return <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); if (text.trim()) onRecord(answer, text.trim(), text.trim() === initial.trim()) }}>
    <label htmlFor="simulated-reply">Simulated reply from {from}</label>
    {question && <p className="agent-approval-note">We asked: {question}</p>}
    {quickPicks && <div className="agent-actions" role="group" aria-label="Quick picks">
      <button type="button" className={`agent-secondary${answer === "agree" ? " is-picked" : ""}`} aria-pressed={answer === "agree"} disabled={busy} onClick={() => pick("agree")}>Agrees</button>
      <button type="button" className={`agent-secondary${answer === "decline" ? " is-picked" : ""}`} aria-pressed={answer === "decline"} disabled={busy} onClick={() => pick("decline")}>Declines</button>
    </div>}
    <textarea id="simulated-reply" value={text} rows={3} maxLength={1000} required autoFocus disabled={busy}
      onChange={(event) => {
        setText(event.target.value)
        // Once the wording no longer matches a quick pick, it is a written reply.
        if (!quickPicks || (event.target.value !== quickPicks.agree && event.target.value !== quickPicks.decline)) setAnswer("other")
      }} />
    <div className="agent-actions">
      <button type="submit" className="agent-primary" disabled={busy || !text.trim()}>{busy ? "Recording…" : "Record reply"}</button>
      <button type="button" className="agent-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    <p className="agent-approval-note">Recorded as a message from {from} in the conversation. Nothing is sent.</p>
  </form>
}
