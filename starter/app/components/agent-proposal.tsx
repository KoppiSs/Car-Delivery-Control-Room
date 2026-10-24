"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { investigationText, isAgentProposal, isExecutableAgentProposal, type AgentProposal } from "@/lib/agent"
import { fetchAgentProposal } from "@/lib/agent-request"
import { fmtDateTime } from "@/lib/present/time"
import type { Detail } from "./order-detail"

const STATUS_OPTIONS = [ ["NEW", "Preparing"], ["WAITING_FOR_PICKUP", "Waiting for pickup"], ["IN_TRANSIT", "In transit"], ["DELIVERED", "Delivered"], ["CANCELLED", "Cancelled"] ]

export function AgentProposalCard({ detail, onUpdate, onHoveredEventIdsChange }: {
  detail: Detail; onUpdate?: () => void; onHoveredEventIdsChange?: (ids: string[]) => void
}) {
  const router = useRouter()
  const [followUp, setFollowUp] = useState(detail.order.status === "follow_up")
  const [waitingOn, setWaitingOn] = useState(detail.order.waitingOnDescription ?? "")
  const [proposal, setProposal] = useState<AgentProposal | null>(() => isAgentProposal(detail.order.agentProposal) ? detail.order.agentProposal : null)
  const [proposalError, setProposalError] = useState("")
  const [canRetryGeneration, setCanRetryGeneration] = useState(false)
  const [loading, setLoading] = useState(false)
  const [decision, setDecision] = useState(detail.order.agentDecision ?? "PENDING")
  const [decisionAt, setDecisionAt] = useState(detail.order.agentDecisionAt ?? null)
  const [editing, setEditing] = useState(false)
  const [correction, setCorrection] = useState("")
  const [lastCorrection, setLastCorrection] = useState("")
  const [mode, setMode] = useState(detail.order.agentMode ?? "AGENT")
  const [manualBusy, setManualBusy] = useState(false)
  const [manualNote, setManualNote] = useState("")
  const [manualMessage, setManualMessage] = useState("")
  const [nextStatus, setNextStatus] = useState(detail.order.status ?? detail.view.header.status)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => { onHoveredEventIdsChange?.([]) }, [proposal, mode, followUp, onHoveredEventIdsChange])
  useEffect(() => {
    setMode(detail.order.agentMode ?? "AGENT")
    setFollowUp(detail.order.status === "follow_up")
    setWaitingOn(detail.order.waitingOnDescription ?? "")
    setDecision(detail.order.agentDecision ?? "PENDING")
    setDecisionAt(detail.order.agentDecisionAt ?? null)
    if (isAgentProposal(detail.order.agentProposal)) setProposal(detail.order.agentProposal)
  }, [detail.order.agentProposal, detail.order.agentMode, detail.order.agentDecision, detail.order.agentDecisionAt, detail.order.status, detail.order.waitingOnDescription])

  async function generate(steer?: string) {
    if (request.current || mode !== "AGENT" || followUp) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setProposalError(""); setCanRetryGeneration(false); setLastCorrection(steer ?? "")
    try {
      const data = await fetchAgentProposal({ orderId: detail.order.id, events: detail.events,
        ...(steer ? { correction: steer, previousProposal: proposal } : {}), context: {
          order: { id: detail.order.id, reference: detail.order.reference }, snapshot_at: detail.view.snapshotAt,
          status: detail.view.header.status, attention: detail.view.attention, alerts: detail.view.alerts,
        } }, { signal: controller.signal })
      if (!controller.signal.aborted) { setProposal(data); setDecision("PENDING"); setDecisionAt(null); setEditing(false); setCorrection(""); onUpdate?.() }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) { setCanRetryGeneration(true); setProposalError(cause instanceof Error ? cause.message : "The proposal couldn't be prepared. Please retry.") }
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  async function executeFollowUp() {
    if (manualBusy || !isExecutableAgentProposal(proposal)) return
    setManualBusy(true); setProposalError(""); setCanRetryGeneration(false)
    try {
      const response = await fetch("/api/agent/execute", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000), body: JSON.stringify({ orderId: detail.order.id,
          executable_tool_call: proposal.executable_tool_call, waiting_on_description: proposal.waiting_on_description, proposal }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "The follow-up couldn't be recorded.")
      setProposal(null); setFollowUp(true); setWaitingOn(result.waiting_on_description)
      setDecision("APPROVED"); setDecisionAt(result.decidedAt); setEditing(false)
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
      setDecision(result.decision); setDecisionAt(result.decidedAt); setEditing(false)
      onUpdate?.()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "This review couldn't be saved. Please retry.") }
    finally { setManualBusy(false) }
  }

  async function manualUpdate(operation: "takeover" | "note" | "resolve") {
    if (manualBusy) return
    if (operation !== "takeover" && !manualNote.trim()) { setProposalError("Enter a note before saving."); return }
    setManualBusy(true); setProposalError(""); setCanRetryGeneration(false); setManualMessage("")
    try {
      const response = await fetch("/api/agent/manual", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000), body: JSON.stringify({ orderId: detail.order.id, operation,
          note: operation === "takeover" ? "Operator rejected the agent plan and chose manual control." : manualNote, nextStatus }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "The manual update couldn't be saved.")
      request.current?.abort(); request.current = null; setLoading(false)
      setMode(result.mode); setDecision(result.decision ?? "TAKEN_OVER"); setDecisionAt(result.decidedAt ?? null); setProposal(null); setEditing(false)
      setManualNote(""); setManualMessage(operation === "note" ? "Note saved to the order timeline." : operation === "resolve" ? "Manual resolution recorded." : "You're in control. Automated alerts are cleared; manual follow-up remains open.")
      onUpdate?.()
    } catch (cause: unknown) { setProposalError(cause instanceof Error ? cause.message : "The manual update couldn't be saved. Please retry.") }
    finally { setManualBusy(false) }
  }

  return <section className="agent-proposal" aria-labelledby="agent-proposal-title" aria-busy={loading || manualBusy}>
    <div className="agent-proposal-heading"><h2 id="agent-proposal-title">{mode !== "AGENT" ? "Manual control" : followUp ? "Follow-up" : "Agent Proposal"}</h2><span>{mode !== "AGENT" ? "Taken over" : followUp ? "Waiting" : decision === "APPROVED" ? "Approved" : decision === "REJECTED" ? "Rejected" : "For your review"}</span></div>
    {proposalError && <div className="agent-inline-error" role="alert"><p>{proposalError}</p>{mode === "AGENT" && canRetryGeneration && <button type="button" className="agent-retry" disabled={loading} onClick={() => void generate(lastCorrection || undefined)}>Retry investigation</button>}</div>}
    {decisionAt && <p className="agent-approval-note">{decision === "APPROVED" ? "Approval saved" : decision === "REJECTED" ? "Rejection saved" : "Takeover saved"} · {fmtDateTime(decisionAt)}</p>}
    {manualMessage && <p role="status" className="agent-approval-note">{manualMessage}</p>}
    {mode === "MANUAL" ? <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); void manualUpdate("note") }}>
      <p>The agent is dismissed. Record your next step or resolution here; the order stays in your queue until you finish.</p>
      <label htmlFor="manual-note">Next step or resolution</label>
      <textarea id="manual-note" value={manualNote} onChange={(event) => setManualNote(event.target.value)} maxLength={3000} rows={3} required placeholder="What did you check, and what should happen next?" />
      <label htmlFor="manual-status">Order status after resolution</label>
      <select id="manual-status" value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
        {!STATUS_OPTIONS.some(([value]) => value === nextStatus) && <option value="">Select status</option>}
        {STATUS_OPTIONS.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select>
      <div className="agent-actions"><button type="submit" className="agent-secondary" disabled={manualBusy}>Save note</button>
        <button type="button" className="agent-primary" disabled={manualBusy || !manualNote.trim() || !STATUS_OPTIONS.some(([value]) => value === nextStatus)} onClick={() => void manualUpdate("resolve")}>Record manual resolution</button></div>
      <p className="agent-approval-note">These controls record your decision in this fictional workspace. Customer messages and bookings remain operator actions.</p>
    </form> : mode === "MANUAL_COMPLETE" ? <p>Manual resolution recorded. The agent remains dismissed; the order timeline holds the decision.</p> : followUp ? <>
      <div className="follow-up-waiting"><span>Waiting on</span><p>{waitingOn}</p></div>
      <p className="agent-approval-note">The mock action is recorded and the order is in Follow-up. No real message or booking was sent.</p>
      <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button>
    </> : <>
      {proposal ? <>
        <h3>Investigation summary</h3><ul>{proposal.investigation_summary.map((finding, index) => {
          const sourceIds = typeof finding === "string" ? [] : finding.source_event_ids
          return <li key={index} tabIndex={sourceIds.length ? 0 : undefined}
            className={sourceIds.length ? "investigation-finding" : undefined}
            title={sourceIds.length ? "Hover or focus to highlight supporting activity" : undefined}
            onMouseEnter={() => onHoveredEventIdsChange?.(sourceIds)} onMouseLeave={() => onHoveredEventIdsChange?.([])}
            onFocus={() => onHoveredEventIdsChange?.(sourceIds)} onBlur={() => onHoveredEventIdsChange?.([])}>
            {investigationText(finding)}
          </li>
        })}</ul>
        <h3>Proposed action</h3><p>{proposal.proposed_action}</p>
        <div className="agent-actions"><button type="button" className="agent-primary" disabled={loading || manualBusy || !isExecutableAgentProposal(proposal)} onClick={() => void executeFollowUp()}>Approve follow-up</button>
          <button type="button" className="agent-secondary" disabled={decision === "REJECTED" || loading || manualBusy} onClick={() => void reviewDecision("REJECTED")}>{decision === "REJECTED" ? "Rejected" : "Reject Proposal"}</button>
          <button type="button" className="agent-secondary" disabled={loading || manualBusy} onClick={() => { setEditing(true); setProposalError("") }}>Edit Proposal</button>
          <button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button></div>
        {!isExecutableAgentProposal(proposal) && <div className="agent-legacy-note"><p>This saved plan needs an executable follow-up action before it can be approved.</p><button type="button" className="agent-secondary" disabled={loading || manualBusy} onClick={() => void generate("Keep the intent of this plan, and add an executable mock follow-up action and the specific external event to wait for.")}>Prepare follow-up</button></div>}
        {isExecutableAgentProposal(proposal) && <p className="agent-approval-note"><b>After approval:</b> {proposal.waiting_on_description}</p>}
        {editing && <form className="agent-edit-form" onSubmit={(event) => { event.preventDefault(); if (correction.trim()) void generate(correction.trim()) }}>
          <label htmlFor="proposal-correction">What should the agent do differently?</label>
          <textarea id="proposal-correction" value={correction} onChange={(event) => setCorrection(event.target.value)} maxLength={2000} rows={2} required autoFocus placeholder="Check trains instead of ferries" />
          <div className="agent-actions"><button type="submit" className="agent-primary" disabled={loading || !correction.trim()}>Revise proposal</button><button type="button" className="agent-secondary" disabled={loading} onClick={() => setEditing(false)}>Cancel</button></div>
        </form>}
        <p className="agent-approval-note" role="status">{decision === "APPROVED" ? "Approval is saved. Operational follow-up has not been executed." : decision === "REJECTED" ? "Rejection is saved. Edit the plan or take over to continue resolving the order." : "Approvals, edits, rejections and takeover are saved under Prior agent work."}</p>
      </> : !loading && <><p>Ask the agent to review this order’s history and suggest the next step.</p>
        <div className="agent-actions"><button type="button" className="agent-primary" onClick={() => void generate()}>Generate proposal</button><button type="button" className="agent-secondary" disabled={manualBusy} onClick={() => void manualUpdate("takeover")}>Take Over</button></div>
        <p className="agent-approval-note">Generation starts only when you choose.</p></>}
      {loading && <div className="agent-loading-message" role="status"><p>{lastCorrection ? "Revising the plan with your correction…" : "Investigating the order history…"}</p><p className="agent-approval-note">Reviewing the latest evidence. You can close this order; the completed proposal will be saved.</p></div>}
    </>}
  </section>
}
