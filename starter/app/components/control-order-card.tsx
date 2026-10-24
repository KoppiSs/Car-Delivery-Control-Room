"use client"

import Link from "next/link"
import type { BoardCard } from "@/lib/present/types"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "./icons"

export function ControlOrderCard({ card, onOpen }: { card: BoardCard; onOpen: (order: { id: string; reference: string }) => void }) {
  const issue = card.attention.find((item) => item.kind === "alert" || item.kind === "owned_alert")
  const urgent = card.problemSeverity === "high" || card.problemSeverity === "critical"
  const state = card.agentMode === "MANUAL" ? "Manual follow-up" : card.agentDecision === "APPROVED" ? "Approved · follow-up" : card.agentDecision === "REJECTED" ? "Rejected · follow-up" : urgent ? "Priority review" : card.openAlerts.length ? "Needs review" : "Follow-up needed"
  return <Link href={`/orders/${card.id}`} className="control-order" aria-haspopup="dialog" onNavigate={(event) => {
    event.preventDefault(); onOpen({ id: card.id, reference: card.reference })
  }}>
    <div className="control-order-top"><span className={`control-badge${urgent ? " urgent" : ""}`}><span />{state}</span><span className="control-reference">{card.reference}</span></div>
    <div className="control-order-body"><div className="control-situation"><h4>{card.problemTitle ?? issue?.short ?? "This order is blocked"}</h4><p>{card.problemDetail ?? issue?.detail ?? "Review the order and confirm what is needed before work can continue."}</p></div><span className="control-review">Review order <Icon name="chevron" size={16} /></span></div>
    {card.status === "follow_up" && card.waitingOnDescription && <div className="follow-up-waiting"><span>Waiting on</span><p>{card.waitingOnDescription}</p></div>}
    <div className="control-order-foot"><span>{card.vehicle}</span><span>{card.from.city} → {card.to.city}</span><span>{card.customer}</span></div>
    {issue && <div className="control-source">{issue.owner ? `With ${issue.owner}` : "Owner not recorded"}{issue.at ? ` · ${issue.atLabel ?? "Updated"} ${fmtDateTime(issue.at)}` : ""}</div>}
  </Link>
}
