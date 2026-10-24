"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { RecordView, Row } from "@/lib/present/types"
import type { AgentFeedbackEntry } from "@/lib/agent"
import { AgentProposalCard } from "./agent-proposal"
import { RecordHero, Tiles } from "./record/header"
import { RecordsPanel } from "./record/records"
import { ActivitySection, ConversationsSection, DecisionsSection, EvidenceSection, RouteStrip } from "./record/sections"

export type Detail = { order: { id: string; reference: string; status?: string; agentProposal?: unknown; agentMode?: string;
  agentDecision?: string; agentDecisionAt?: string | null; waitingOnDescription?: string | null }; view: RecordView; events: Row[]; agentFeedback?: AgentFeedbackEntry[] }

export function OrderPane({ detail }: { detail: Detail }) {
  const [current, setCurrent] = useState(detail)
  const refreshVersion = useRef(0)
  useEffect(() => setCurrent(detail), [detail])
  const refresh = useCallback(() => {
    const version = ++refreshVersion.current
    window.dispatchEvent(new Event("orders-updated"))
    fetch(`/api/orders/${encodeURIComponent(detail.order.id)}`)
      .then((response) => { if (!response.ok) throw new Error("Could not refresh order"); return response.json() as Promise<Detail> })
      .then((updated) => { if (version === refreshVersion.current) setCurrent(updated) }).catch(() => { /* A saved decision remains visible in the card; reopening reloads the timeline. */ })
  }, [detail.order.id])
  const { view } = current
  return <>
    <AgentProposalCard key={current.order.id} detail={current} onUpdate={refresh} />
    <RecordHero view={view} />
    <Tiles tiles={view.tiles} />
    <RouteStrip view={view} />
    <ConversationsSection view={view} />
    <EvidenceSection view={view} />
    <DecisionsSection view={view} feedback={current.agentFeedback} />
    <ActivitySection view={view} />
    <RecordsPanel view={view} orderId={detail.order.id} />
  </>
}
