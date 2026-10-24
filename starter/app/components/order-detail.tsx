"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { RecordView, Row } from "@/lib/present/types"
import type { AgentFeedbackEntry } from "@/lib/agent"
import { investigationText, isAgentProposal } from "@/lib/agent"
import { AgentProposalCard } from "./agent-proposal"
import { RecordHero, Tiles } from "./record/header"
import { RecordsPanel } from "./record/records"
import { ActivitySection, ConversationsSection, DecisionsSection, EvidenceSection, RouteStrip } from "./record/sections"

export type Detail = { order: { id: string; reference: string; status?: string; agentProposal?: unknown; agentMode?: string;
  agentDecision?: string; agentDecisionAt?: string | null; waitingOnDescription?: string | null }; view: RecordView; events: Row[]; agentFeedback?: AgentFeedbackEntry[] }

export function OrderPane({ detail, readOnly = false }: { detail: Detail; readOnly?: boolean }) {
  const [current, setCurrent] = useState(detail)
  const refreshVersion = useRef(0)
  useEffect(() => { refreshVersion.current++; setCurrent(detail) }, [detail])
  const refresh = useCallback(() => {
    const version = ++refreshVersion.current
    window.dispatchEvent(new Event("orders-updated"))
    fetch(`/api/orders/${encodeURIComponent(detail.order.id)}`)
      .then((response) => { if (!response.ok) throw new Error("Could not refresh order"); return response.json() as Promise<Detail> })
      .then((updated) => { if (version === refreshVersion.current && updated.order.id === detail.order.id) setCurrent(updated) }).catch(() => { /* A saved decision remains visible in the card; reopening reloads the timeline. */ })
  }, [detail.order.id])
  const visible = current.order.id === detail.order.id ? current : detail
  const { view } = visible
  const savedProposal = isAgentProposal(visible.order.agentProposal) ? visible.order.agentProposal : null
  return <>
    {!readOnly && <AgentProposalCard key={visible.order.id} detail={visible} onUpdate={refresh} />}
    <RecordHero view={view} />
    <Tiles tiles={view.tiles} />
    {readOnly && (visible.order.waitingOnDescription || savedProposal) && <section className="delivery-saved-summary" aria-labelledby="saved-plan-title">
      <h2 id="saved-plan-title">Current follow-up</h2>
      {visible.order.waitingOnDescription && <div className="follow-up-waiting"><span>Waiting on</span><p>{visible.order.waitingOnDescription}</p></div>}
      {savedProposal && <><h3>Saved investigation</h3><ul>{savedProposal.investigation_summary.map((finding, index) => <li key={index}>{investigationText(finding)}</li>)}</ul>
        <h3>Proposed next step</h3><p>{savedProposal.proposed_action}</p><p className="delivery-review-state">Review: {visible.order.agentDecision?.toLowerCase().replaceAll("_", " ") ?? "pending"}</p></>}
    </section>}
    <RouteStrip view={view} />
    <ConversationsSection view={view} />
    <EvidenceSection view={view} />
    <DecisionsSection view={view} feedback={visible.agentFeedback} />
    <ActivitySection view={view} />
    <RecordsPanel view={view} orderId={detail.order.id} />
  </>
}
