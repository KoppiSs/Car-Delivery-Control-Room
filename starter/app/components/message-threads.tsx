"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import { markThreadAsRead } from "@/lib/actions"
import type { MessageConversation } from "@/lib/present/messages"
import { fmtDateTime, fmtLong } from "@/lib/present/time"

export function MessageThreads({ conversations }: { conversations: MessageConversation[] }) {
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null)
  const [locallyReadIds, setLocallyReadIds] = useState<Set<string>>(() => new Set())
  const [readErrors, setReadErrors] = useState<Record<string, string>>({})
  const pendingReadOrders = useRef(new Set<string>())

  async function saveReadStatus(conversation: MessageConversation) {
    const unreadIds = conversation.messages.filter((message) => !message.isRead && !locallyReadIds.has(message.id)).map((message) => message.id)
    if (!unreadIds.length || pendingReadOrders.current.has(conversation.orderId)) return
    pendingReadOrders.current.add(conversation.orderId)
    setLocallyReadIds((current) => new Set([...current, ...unreadIds]))
    setReadErrors((current) => { const next = { ...current }; delete next[conversation.orderId]; return next })
    try {
      const { updatedMessageIds } = await markThreadAsRead(conversation.orderId)
      setLocallyReadIds((current) => new Set([...current, ...updatedMessageIds]))
    } catch {
      setLocallyReadIds((current) => { const next = new Set(current); unreadIds.forEach((id) => next.delete(id)); return next })
      setReadErrors((current) => ({ ...current, [conversation.orderId]: "Read status couldn't be saved. Please try again." }))
    } finally {
      pendingReadOrders.current.delete(conversation.orderId)
    }
  }

  function toggleThread(conversation: MessageConversation) {
    const opening = expandedThreadId !== conversation.orderId
    setExpandedThreadId(opening ? conversation.orderId : null)
    if (opening) void saveReadStatus(conversation)
  }

  return <ol className="message-thread-list">{conversations.map((conversation) => {
    const latest = conversation.latestMessage
    const preview = latest.body.trim().replace(/\s+/g, " ")
    const expanded = expandedThreadId === conversation.orderId
    const unread = conversation.messages.some((message) => !message.isRead && !locallyReadIds.has(message.id))
    const historyId = `message-history-${conversation.orderId}`
    return <li key={conversation.orderId} data-order-id={conversation.orderId} data-latest-message-id={latest.id}>
      <button type="button" className={`mail-row message-thread${unread ? " unread" : ""}`} aria-expanded={expanded} aria-controls={historyId}
        onClick={() => toggleThread(conversation)}>
        <span className="mail-row-top"><span className="message-thread-order">{unread && <><span className="message-unread-dot" aria-hidden="true" /><span className="sr-only">Unread conversation</span></>}<span className="mono">{conversation.orderReference}</span><span className="control-count">{conversation.messages.length}</span></span>
          <time className="mail-row-when" dateTime={latest.authoredAt} title={fmtLong(latest.authoredAt)}>{fmtDateTime(latest.authoredAt)}</time></span>
        <span className="mail-row-subject"><span className="message-thread-customer">{conversation.customerName}</span>{latest.internal && <span className="msg-tag internal">Internal</span>}</span>
        <span className="mail-row-preview"><span className="message-thread-sender">{latest.sender.name}:</span> {preview.length > 180 ? `${preview.slice(0, 180).trimEnd()}…` : preview}</span>
        <span className="message-thread-toggle">{expanded ? "Hide conversation" : "Read conversation"}<span aria-hidden="true">{expanded ? "−" : "+"}</span></span>
      </button>
      {expanded && <section id={historyId} className="message-thread-expanded" aria-label={`Message history for ${conversation.orderReference}`}>
        <div className="message-history-heading"><p>Conversation history · Oldest first</p>
          <Link className="message-view-order" href={`/cases/${encodeURIComponent(conversation.orderId)}`} prefetch={false}>View Order</Link></div>
        {readErrors[conversation.orderId] && <div className="message-read-error" role="alert"><p>{readErrors[conversation.orderId]}</p><button type="button" onClick={() => void saveReadStatus(conversation)}>Try again</button></div>}
        <ol className="messages message-thread-history">{[...conversation.messages]
          .sort((a, b) => a.authoredAt.localeCompare(b.authoredAt) || a.id.localeCompare(b.id))
          .map((message) => <li key={message.id} data-message-id={message.id} className={`msg${message.internal ? " internal" : message.sender.kind === "operator" ? " from-operator" : ""}`}>
            <div className="msg-meta"><b>{message.sender.name}</b>{message.sender.role && <span className="role">{message.sender.role}</span>}
              <span>to {message.recipient.name}</span><span>· {message.channel}</span>{message.internal && <span className="msg-tag internal">Internal</span>}
              <time dateTime={message.authoredAt} title={fmtLong(message.authoredAt)}>{fmtDateTime(message.authoredAt)}</time>
            </div>
            <p className="msg-body">{message.body}</p>
          </li>)}</ol>
      </section>}
    </li>
  })}</ol>
}
