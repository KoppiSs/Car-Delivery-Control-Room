"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { investigationText, isAgentProposal, isExecutableAgentProposal, type AgentProposal } from "@/lib/agent"
import { proposalProblem } from "@/lib/proposal-guard"
import { FOLLOW_UP_RECIPIENT_LABELS, idsIn, withNames, type FollowUpRecipient } from "@/lib/present/names-text"
import { fmtDateTime } from "@/lib/present/time"
import type { Detail } from "./order-detail"
import { Reading, Suggestion } from "./statements"
import { ReplyComposer, type ReplyPick } from "./reply-composer"

export function AgentProposalCard({ detail, onUpdate }: {
  detail: Detail; onUpdate?: () => void
}) {
  const router = useRouter()
  const [followUp, setFollowUp] = useState(detail.order.status === "follow_up")
  const [waitingOn, setWaitingOn] = useState(detail.order.waitingOnDescription ?? "")
  const [proposal, setProposal] = useState<AgentProposal | null>(() => isAgentProposal(detail.order.agentProposal) ? detail.order.agentProposal : null)
  // Set when the model's answer (or a stored proposal) is not an instruction for us: shown as "No suggestion yet".
  const [noSuggestion, setNoSuggestion] = useState<string | null>(null)
  const [proposalError, setProposalError] = useState("")
  const [canRetryGeneration, setCanRetryGeneration] = useState(false)
  const [loading, setLoading] = useState(false)
  const [decision, setDecision] = useState(detail.order.agentDecision ?? "PENDING")
  const [decisionAt, setDecisionAt] = useState(detail.order.agentDecisionAt ?? null)
  // "Your version": a person's editable copy of the agent's plan. Null while not editing.
  // The recipient starts unchosen: who we wait for is always picked by a person, never guessed.
  const [draft, setDraft] = useState<{ action: string; recipient: FollowUpRecipient | ""; waitingOn: string } | null>(null)
  // Approving the agent's own plan also asks who we are waiting for. Null while the question is closed.
  const [approveFor, setApproveFor] = useState<FollowUpRecipient | "" | null>(null)
  const [lastCorrection, setLastCorrection] = useState("")
  const [endNote, setEndNote] = useState("")
  const [ending, setEnding] = useState<"solved" | "handed_back" | "">("")
  // Reject → regenerate: the reason being written, and what came of asking again.
  const [rejectReason, setRejectReason] = useState<string | null>(null)
  const [regen, setRegen] = useState<{ status: "working" } | { status: "no_other" } | { status: "failed"; reason: string } | null>(null)
  const [streakCount, setStreakCount] = useState<number | null>(null)
  // "Record what you did" entries recorded in this view before the order is reloaded.
  const [recorded, setRecorded] = useState<{ note: string; at: string }[]>([])
  // The simulated reply being written: a suggestion that answers the question, editable before recording.
  const [replyDraft, setReplyDraft] = useState<{ from: string; question: string; text: string; quickPicks: boolean; recipientType: string; source: string } | null>(null)
  const [mode, setMode] = useState(detail.order.agentMode ?? "AGENT")
  const [manualBusy, setManualBusy] = useState(false)
  const [manualNote, setManualNote] = useState("")
  const [manualMessage, setManualMessage] = useState("")
  const [nextStatus, setNextStatus] = useState(detail.order.status ?? detail.view.header.status)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])
  // Names instead of record ids in the agent's text. The ids stay in the "Ids in this plan" toggle.
  const named = (text: string) => withNames(text, detail.names ?? {})
  // A stored suggestion that is not an instruction for us, or that has the car driven on during a safety stop, is never shown.
  const storedProblem = proposal ? proposalProblem(proposal, { safetyStop: detail.safetyStop }) : null
  const parties = detail.parties ?? {}
  const partyName = (recipient: FollowUpRecipient | "") => !recipient || recipient === "nobody" ? null : parties[recipient]?.name ?? null
  /** One picker for both approvals: everyone on file by name, plus "Nobody". */
  const recipientOptions = (selected: FollowUpRecipient | "") => <>
    {!selected && <option value="">Choose who we are waiting for…</option>}
    {(Object.keys(FOLLOW_UP_RECIPIENT_LABELS) as FollowUpRecipient[]).map((recipient) => {
      const name = partyName(recipient)
      const missing = recipient !== "nobody" && !name
      return <option key={recipient} value={recipient} disabled={missing}>{FOLLOW_UP_RECIPIENT_LABELS[recipient]}{name ? ` · ${name}` : missing ? " · nobody on file" : ""}</option>
    })}
  </>
  useEffect(() => {
    setMode(detail.order.agentMode ?? "AGENT")
    setFollowUp(detail.order.status === "follow_up")
    setWaitingOn(detail.order.waitingOnDescription ?? "")
    setDecision(detail.order.agentDecision ?? "PENDING")
    setDecisionAt(detail.order.agentDecisionAt ?? null)
    setProposal(isAgentProposal(detail.order.agentProposal) ? detail.order.agentProposal : null)
  }, [detail.order.id, detail.order.agentProposal, detail.order.agentMode, detail.order.agentDecision, detail.order.agentDecisionAt, detail.order.status, detail.order.waitingOnDescription])

  async function generate(steer?: string) {
    if (request.current || mode !== "AGENT" || followUp) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setProposalError(""); setCanRetryGeneration(false); setLastCorrection(steer ?? "")
    try {
      // The server builds the evidence (with nobody's words in it) and only saves an instruction for us.
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/generate`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
        body: JSON.stringify(steer ? { steer } : {}) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? `the server answered with HTTP ${response.status}`)
      if (controller.signal.aborted) return
      if (data.outcome === "new") { setProposal(data.proposal); setNoSuggestion(null); setDecision("PENDING"); setDecisionAt(null); setDraft(null); onUpdate?.() }
      else if (data.outcome === "no_suggestion") setNoSuggestion(data.reason)
      else throw new Error(`Couldn't make a suggestion: ${data.reason ?? "no reason was given"}.`)
    } catch (cause: unknown) {
      if (!controller.signal.aborted) { setCanRetryGeneration(true); setProposalError(cause instanceof Error ? cause.message : "The proposal couldn't be prepared. Please retry.") }
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  async function executeFollowUp() {
    if (manualBusy || !isExecutableAgentProposal(proposal) || !approveFor) return
    setManualBusy(true); setProposalError(""); setCanRetryGeneration(false)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000), body: JSON.stringify({ proposal, recipient: approveFor }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "The follow-up couldn't be recorded.")
      setProposal(null); setFollowUp(result.status === "follow_up"); setWaitingOn(result.waiting_on_description ?? "")
      setDecision("APPROVED"); setDecisionAt(result.decidedAt); setDraft(null); setApproveFor(null)
      onUpdate?.()
      router.refresh()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "The follow-up couldn't be recorded. Please retry.") }
    finally { setManualBusy(false) }
  }

  async function reviewDecision(value: "APPROVED" | "REJECTED") {
    if (manualBusy || !proposal) return
    setManualBusy(true); setProposalError(""); setCanRetryGeneration(false)
    try {
      const response = await fetch("/api/agent/decision", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000), body: JSON.stringify({ orderId: detail.order.id, decision: value, proposal }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "This review couldn't be saved.")
      setDecision(result.decision); setDecisionAt(result.decidedAt); setDraft(null)
      onUpdate?.()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "This review couldn't be saved. Please retry.") }
    finally { setManualBusy(false) }
  }

  /** Opens "Your version" with the agent's plan copied in, names instead of ids. */
  function startEdit() {
    if (!proposal) return
    setDraft({ action: named(proposal.proposed_action), recipient: "", waitingOn: named(proposal.waiting_on_description ?? "") })
    setApproveFor(null); setProposalError("")
  }

  async function approveDraft() {
    if (manualBusy || !proposal || !draft || !draft.recipient) return
    setManualBusy(true); setProposalError("")
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/approve-edited`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ original: proposal, edited: draft }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "Your version couldn't be approved.")
      setProposal(null); setDraft(null); setDecision("APPROVED"); setDecisionAt(result.decidedAt)
      if (result.status === "follow_up") { setFollowUp(true); setWaitingOn(result.waiting_on_description ?? "") }
      onUpdate?.()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "Your version couldn't be approved. Please retry.") }
    finally { setManualBusy(false) }
  }

  /** Demo: fetch a reply that answers what we asked, and open it for editing. */
  async function openReply() {
    if (manualBusy) return
    setManualBusy(true); setProposalError(""); setManualMessage("")
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/follow-up-reply`, { signal: AbortSignal.timeout(75_000) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "No reply could be suggested.")
      setReplyDraft(result)
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "No reply could be suggested. Please retry.") }
    finally { setManualBusy(false) }
  }

  /** Records the reply as a message from the party we asked; the follow-up ends with it. */
  async function simulateReply(answer: ReplyPick, text: string, source: string) {
    if (manualBusy) return
    setManualBusy(true); setProposalError(""); setManualMessage("")
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/follow-up-reply`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ answer, text, source }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "The reply couldn't be recorded.")
      setReplyDraft(null)
      setFollowUp(result.status === "follow_up")
      setManualMessage(`Simulated reply from ${result.from} recorded. The order is back for review.`)
      onUpdate?.()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "The reply couldn't be recorded. Please retry.") }
    finally { setManualBusy(false) }
  }

  /** Proposals rejected in a row since the last approval or takeover, newest first, with why. */
  const rejectedStreak = (() => {
    const streak: { action: string; reason: string; at: string }[] = []
    for (const entry of detail.agentFeedback ?? []) {
      if (entry.decision !== "REJECT") break
      if (entry.previousProposal) streak.push({ action: named(entry.previousProposal.proposed_action), reason: entry.correction ?? "", at: String(entry.createdAt) })
    }
    return streak
  })()
  const rejectedInARow = Math.max(streakCount ?? 0, rejectedStreak.length)

  /** Rejects with a reason and asks again (or hands it to a person). Always ends in a stated outcome. */
  async function reject(then: "regenerate" | "takeover" | "retry") {
    if (manualBusy || (then !== "retry" && (!proposal || !rejectReason?.trim()))) return
    setManualBusy(true); setProposalError(""); setManualMessage("")
    if (then !== "takeover") setRegen({ status: "working" })
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(detail.order.id)}/reject`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(150_000),
        body: JSON.stringify({ proposal, reason: rejectReason?.trim() ?? "", then }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? `the server answered with HTTP ${response.status}`)
      setRejectReason(null)
      if (typeof result.rejectedInARow === "number") setStreakCount(result.rejectedInARow)
      if (result.outcome === "new") { setProposal(result.proposal); setDecision("PENDING"); setDecisionAt(null); setRegen(null) }
      else if (result.outcome === "no_other") { setDecision("REJECTED"); setRegen({ status: "no_other" }) }
      else if (result.outcome === "failed") { setDecision("REJECTED"); setRegen({ status: "failed", reason: result.reason ?? "no reason was given" }) }
      else if (result.outcome === "taken_over") { setRegen(null); setMode("MANUAL"); setProposal(null); setManualMessage("Rejected, and you took over. Alerts stay open until the problem is actually solved.") }
      onUpdate?.()
    } catch (cause: unknown) {
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError"
      setRegen({ status: "failed", reason: timedOut ? "the agent took too long to answer" : cause instanceof Error ? cause.message : "the request failed" })
    } finally { setManualBusy(false) }
  }

  /** Everything recorded with "Record what you did" since this manual control started, oldest first. */
  const manualRecords = (() => {
    const events = (detail.events ?? []) as { command?: unknown; recordedAt?: unknown; details?: { changes?: { note?: unknown } } }[]
    const time = (value: unknown) => typeof value === "string" ? value : value instanceof Date ? value.toISOString() : ""
    const started = events.filter((event) => event.command === "manual_control.started").map((event) => time(event.recordedAt)).sort().at(-1) ?? ""
    const stored = events.filter((event) => event.command === "manual.note_added" && time(event.recordedAt) >= started)
      .map((event) => ({ note: String(event.details?.changes?.note ?? ""), at: time(event.recordedAt) }))
    return [...new Map([...stored, ...recorded].map((entry) => [`${entry.at}|${entry.note}`, entry])).values()].sort((a, b) => a.at.localeCompare(b.at))
  })()

  async function manualUpdate(operation: "takeover" | "note" | "resolve" | "end") {
    if (manualBusy) return
    if (operation === "end" && (!endNote.trim() || !ending)) { setProposalError("Write one line and choose how manual control ends."); return }
    if ((operation === "note" || operation === "resolve") && !manualNote.trim()) { setProposalError("Write one line on what you did."); return }
    setManualBusy(true); setProposalError(""); setCanRetryGeneration(false); setManualMessage("")
    try {
      const response = await fetch("/api/agent/manual", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000), body: JSON.stringify({ orderId: detail.order.id, operation,
          note: operation === "takeover" ? "Operator took manual control." : operation === "end" ? endNote.trim() : manualNote.trim(), nextStatus,
          ...(operation === "end" ? { ending } : {}) }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "The manual update couldn't be saved.")
      request.current?.abort(); request.current = null; setLoading(false)
      setMode(result.mode); setDecision(result.decision ?? "TAKEN_OVER"); setDecisionAt(result.decidedAt ?? null); setProposal(null); setDraft(null)
      if (operation === "note") setRecorded((current) => [...current, { note: manualNote.trim(), at: String(result.recordedAt ?? "") }])
      if (operation === "takeover" || operation === "end") setRecorded([])
      setManualNote(""); setEndNote(""); setEnding("")
      setManualMessage(operation === "note" ? "Recorded in the order history. The order stays in Manual control." : operation === "resolve" ? "Manual resolution recorded."
        : operation === "end" ? (ending === "solved" ? "Closed: the open alerts are resolved by you, with your note as the reason."
          : "Handed back to the agent. If a problem is still open, the order is back in Needs a review.")
        : "You're in control. Alerts stay open until the problem is actually solved.")
      onUpdate?.()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "The manual update couldn't be saved. Please retry.") }
    finally { setManualBusy(false) }
  }

  return <section className="agent-proposal" aria-labelledby="agent-proposal-title" aria-busy={loading || manualBusy}>
    <div className="agent-proposal-heading"><h2 id="agent-proposal-title">{mode !== "AGENT" ? "Manual control" : followUp ? "Follow-up" : "Agent Proposal"}</h2><span>{mode !== "AGENT" ? "Taken over" : followUp ? "Waiting" : decision === "APPROVED" ? "Approved" : decision === "REJECTED" ? "Rejected" : "For your review"}</span></div>
    {proposalError && <div className="agent-inline-error" role="alert"><p>{proposalError}</p>{mode === "AGENT" && canRetryGeneration && <button type="button" className="agent-retry" disabled={loading} onClick={() => void generate(lastCorrection || undefined)}>Retry investigation</button>}</div>}
    {decisionAt && <p className="agent-approval-note">{decision === "APPROVED" ? "Approval saved" : decision === "REJECTED" ? "Rejection saved" : "Takeover saved"} · {fmtDateTime(decisionAt)}</p>}
    {manualMessage && <p role="status" className="agent-approval-note">{manualMessage}</p>}
    {mode === "MANUAL" ? <>
      <p>The agent has stepped back. The order stays in Manual control until you end it.</p>
      {manualRecords.length > 0 && <><h3>What you did</h3><ul className="manual-records">{manualRecords.map((entry) => <li key={`${entry.at}|${entry.note}`}>
        {entry.at && <time dateTime={entry.at}>{fmtDateTime(entry.at)}</time>} {entry.note}</li>)}</ul></>}
      <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); void manualUpdate("note") }}>
        <label htmlFor="manual-note">Record what you did</label>
        <input id="manual-note" className="agent-line-input" value={manualNote} onChange={(event) => setManualNote(event.target.value.replace(/[\r\n]/g, " "))} maxLength={300}
          placeholder="Called the dealer, recovery truck at 14:00" />
        <div className="agent-actions"><button type="submit" className="agent-secondary" disabled={manualBusy || !manualNote.trim()}>Record what you did</button></div>
        <p className="agent-approval-note">Added to the order history. The order stays in Manual control.</p>
      </form>
      <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); void manualUpdate("end") }}>
        <h3>End manual control</h3>
        <label htmlFor="manual-end-note">One line on the outcome</label>
        <input id="manual-end-note" className="agent-line-input" value={endNote} onChange={(event) => setEndNote(event.target.value.replace(/[\r\n]/g, " "))} maxLength={300}
          placeholder="Recovery done, car back on the road" />
        <fieldset className="manual-ending">
          <legend>How does it end?</legend>
          <label><input type="radio" name="manual-ending" value="solved" checked={ending === "solved"} onChange={() => setEnding("solved")} />
            Problem solved, close it<small>You confirm it is solved. Its open alerts are resolved by you, with your note as the reason. The order leaves the control table.</small></label>
          <label><input type="radio" name="manual-ending" value="handed_back" checked={ending === "handed_back"} onChange={() => setEnding("handed_back")} />
            Hand back to the agent<small>The problem may still be open. Alerts stay as they are; the order goes back to Needs a review if anything is open.</small></label>
        </fieldset>
        <div className="agent-actions"><button type="submit" className="agent-primary" disabled={manualBusy || !endNote.trim() || !ending}>End manual control</button></div>
      </form>
    </> : mode === "MANUAL_COMPLETE" ? <p>Closed by an operator. The order history holds what was done and why.</p> : followUp ? <>
      <div className="follow-up-waiting"><span>Waiting on</span><p>{named(waitingOn)}</p></div>
      <p className="agent-approval-note">The mock action is recorded and the order is Pending. No real message or booking was sent.</p>
      {replyDraft ? <ReplyComposer from={replyDraft.from} question={replyDraft.question} initial={replyDraft.text} busy={manualBusy}
        quickPicks={replyDraft.quickPicks ? (replyDraft.recipientType === "customer"
          ? { agree: "Yes, that works for us.", decline: "That doesn't work for us, please call me." }
          : { agree: "Yes, that works.", decline: "No, we can't do that." }) : undefined}
        onRecord={(answer, text, unchanged) => void simulateReply(answer, text, answer !== "other" ? "scripted" : unchanged ? replyDraft.source : "operator")}
        onCancel={() => setReplyDraft(null)} />
        : <div className="agent-actions">
          <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void openReply()}>{manualBusy ? "Preparing a reply…" : "Simulate reply"}</button>
          <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button>
        </div>}
      <p className="agent-approval-note">For the demo. The suggested reply answers what we asked; you can change it before it is recorded.</p>
    </> : <>
      {proposal && storedProblem && !noSuggestion ? <><p><b>No suggestion yet.</b> The stored suggestion did not pass the checks, so it is not shown.</p>
        <p className="agent-approval-note">{storedProblem}.</p>
        <div className="agent-actions"><button type="button" className="agent-primary" disabled={loading} onClick={() => void generate()}>Generate proposal</button>
          <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button></div></>
      : noSuggestion ? <><p><b>No suggestion yet.</b> The agent's answer did not pass the checks, even after it was told the rule.</p>
        <p className="agent-approval-note">{noSuggestion}.</p>
        <div className="agent-actions"><button type="button" className="agent-primary" disabled={loading} onClick={() => { setNoSuggestion(null); void generate() }}>Try again</button>
          <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button></div></>
      : proposal ? <>
        <h3>What the agent found</h3><ul className="agent-readings">{proposal.investigation_summary.map((finding, index) => {
          // Findings are the agent's readings. Their sources resolve to who said what, and when.
          const ids = typeof finding === "string" ? [] : finding.source_event_ids
          const sources = ids.map((id) => detail.statements?.proposalSources[id]).filter((source) => !!source)
          return <Reading key={index} text={named(investigationText(finding))} sources={sources} missing={ids.filter((id) => !detail.statements?.proposalSources[id])} />
        })}</ul>
        <Suggestion><p>{named(proposal.proposed_action)}</p>
          {isExecutableAgentProposal(proposal) && <p className="agent-approval-note"><b>After approval:</b> waiting on {named(proposal.waiting_on_description)}</p>}</Suggestion>
        {approveFor !== null && <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); void executeFollowUp() }}>
          <label htmlFor="approve-recipient">Who are we waiting for?</label>
          <select id="approve-recipient" value={approveFor} onChange={(event) => setApproveFor(event.target.value as FollowUpRecipient)} required autoFocus>
            {recipientOptions(approveFor)}
          </select>
          <div className="agent-actions">
            <button type="submit" className="agent-primary" disabled={manualBusy || !approveFor}>Approve</button>
            <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => setApproveFor(null)}>Cancel</button>
          </div>
          <p className="agent-approval-note">{!approveFor ? "The plan does not say who it asks, so choose before approving."
            : approveFor === "nobody" ? "Nobody is asked anything, so the order is not marked as waiting."
            : `The order is Pending until ${partyName(approveFor)} answers.`}</p>
        </form>}
        {decision === "PENDING" && rejectedStreak.length > 0 && <details className="agent-ids">
          <summary>Replaces {rejectedStreak.length} rejected suggestion{rejectedStreak.length === 1 ? "" : "s"}</summary>
          <ul>{rejectedStreak.map((entry) => <li key={`${entry.at}|${entry.action}`}>“{entry.action}” — rejected because: {entry.reason || "no reason given"}</li>)}</ul>
        </details>}
        {rejectReason !== null && <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); void reject("regenerate") }}>
          <label htmlFor="reject-reason">What's wrong with this?</label>
          <div className="agent-actions" role="group" aria-label="Quick picks">
            {["Too expensive", "Wrong person to contact", "Facts are wrong", "Not urgent"].map((pick) =>
              <button key={pick} type="button" className="agent-secondary" aria-pressed={rejectReason === pick} onClick={() => setRejectReason(pick)}>{pick}</button>)}
          </div>
          <input id="reject-reason" className="agent-line-input" value={rejectReason} maxLength={300} required autoFocus
            onChange={(event) => setRejectReason(event.target.value.replace(/[\r\n]/g, " "))} placeholder="Or write it in one line" />
          <div className="agent-actions">
            <button type="submit" className="agent-primary" disabled={manualBusy || !rejectReason.trim()}>Reject and ask for another</button>
            <button type="button" className="agent-secondary" disabled={manualBusy || !rejectReason.trim()} onClick={() => void reject("takeover")}>Reject, I'll handle it</button>
            <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => setRejectReason(null)}>Cancel</button>
          </div>
        </form>}
        {regen?.status === "working" && <div className="agent-loading-message" role="status"><p>Thinking again with your note…</p>
          <p className="agent-approval-note">The agent is told what you rejected and why.</p></div>}
        {regen?.status === "no_other" && <div className="agent-legacy-note" role="status"><p><b>The agent has no other suggestion.</b> It came back with the plan you rejected, so it is not shown as new.</p>
          <div className="agent-actions"><button type="button" className="agent-secondary" disabled={manualBusy || !!draft} onClick={startEdit}>Edit</button>
            <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take over</button></div></div>}
        {regen?.status === "failed" && <div className="agent-inline-error" role="alert"><p>Couldn't make a new suggestion: {regen.reason}.</p>
          <div className="agent-actions"><button type="button" className="agent-retry" disabled={manualBusy} onClick={() => void reject("retry")}>Try again</button>
            <button type="button" className="agent-secondary" disabled={manualBusy || !!draft} onClick={startEdit}>Edit</button>
            <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take over</button></div></div>}
        {rejectedInARow >= 3 && regen?.status !== "working" && <div className="agent-legacy-note"><p>This may need a person. Take over?</p>
          <div className="agent-actions"><button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take over</button></div></div>}
        {(() => {
          const ids = idsIn(JSON.stringify(proposal))
          return ids.length > 0 && <details className="agent-ids"><summary>Ids in this plan</summary>
            <ul>{ids.map((id) => <li key={id}><span className="mono">{id}</span>{detail.names?.[id] ? ` · ${detail.names[id]}` : " · not on this order"}</li>)}</ul></details>
        })()}
        <div className="agent-actions">{decision !== "REJECTED" && <button type="button" className="agent-primary" disabled={loading || manualBusy || !isExecutableAgentProposal(proposal) || approveFor !== null || !!draft} onClick={() => { setApproveFor(""); setProposalError("") }}>Approve follow-up</button>}
          {decision !== "REJECTED" && <button type="button" className="agent-secondary" disabled={loading || manualBusy || rejectReason !== null} onClick={() => { setRejectReason(""); setRegen(null) }}>Reject</button>}
          <button type="button" className="agent-secondary" disabled={loading || manualBusy || !!draft} onClick={startEdit}>Edit</button>
          <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button></div>
        {!isExecutableAgentProposal(proposal) && <div className="agent-legacy-note"><p>This saved plan needs a matching follow-up action and expected response before it can be approved.</p><button type="button" className="agent-secondary" disabled={loading || manualBusy} onClick={() => void generate("Keep the intended next step. Prepare an executable mock action and the specific reply or evidence that action requests; do not reuse an unrelated waiting event.")}>Prepare follow-up</button></div>}
        {draft && <form className="agent-edit-form agent-your-version" aria-labelledby="your-version-title" onSubmit={(event) => { event.preventDefault(); void approveDraft() }}>
          <h3 id="your-version-title">Your version</h3>
          <p className="agent-approval-note">The agent's plan above stays as it is. Approving stores both.</p>
          <label htmlFor="your-action">Action</label>
          <textarea id="your-action" value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} maxLength={400} rows={2} required autoFocus />
          <label htmlFor="your-recipient">Who it goes to</label>
          <select id="your-recipient" value={draft.recipient} required onChange={(event) => setDraft({ ...draft, recipient: event.target.value as FollowUpRecipient })}>
            {recipientOptions(draft.recipient)}
          </select>
          {draft.recipient !== "nobody" && <><label htmlFor="your-waiting">What we are waiting for</label>
            <input id="your-waiting" className="agent-line-input" value={draft.waitingOn} onChange={(event) => setDraft({ ...draft, waitingOn: event.target.value })} maxLength={300} required /></>}
          <div className="agent-actions">
            <button type="submit" className="agent-primary" disabled={manualBusy || !draft.recipient || !draft.action.trim() || (draft.recipient !== "nobody" && !draft.waitingOn.trim())}>Approve your version</button>
            <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
          <p className="agent-approval-note">{!draft.recipient ? "Choose who it goes to." : draft.recipient === "nobody" ? "No one is asked anything, so the order is not marked as waiting." : `After approval the order is Pending until ${partyName(draft.recipient)} answers.`}</p>
        </form>}
        <p className="agent-approval-note" role="status">{decision === "APPROVED" ? "Approval is saved. Operational follow-up has not been executed." : decision === "REJECTED" ? "" : "Approvals, edits, rejections and takeover are saved under Prior agent work."}</p>
      </> : !loading && <><p>Ask the agent to review this order’s history and suggest the next step.</p>
        <div className="agent-actions"><button type="button" className="agent-primary" onClick={() => void generate()}>Generate proposal</button><button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button></div>
        <p className="agent-approval-note">Generation starts only when you choose.</p></>}
      {loading && <div className="agent-loading-message" role="status"><p>{lastCorrection ? "Preparing the follow-up…" : "Investigating the order history…"}</p><p className="agent-approval-note">Reviewing the latest evidence. You can close this order; the completed proposal will be saved.</p></div>}
    </>}
  </section>
}
