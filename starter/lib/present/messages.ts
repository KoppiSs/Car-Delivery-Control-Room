import type { Actor } from "./types"

export type GlobalInboxMessage = {
  id: string
  orderId: string
  orderReference: string
  customerName: string
  sender: Actor
  recipient: Actor
  authoredAt: string
  body: string
  isRead: boolean
  channel: string
  internal: boolean
}

export const MESSAGE_FOLDERS = [
  { id: "sent", label: "Sent", description: "Conversations containing outgoing messages." },
  { id: "inbox", label: "Inbox", description: "Conversations containing incoming messages." },
  { id: "all", label: "All messages", description: "Every order conversation, including internal notes." },
] as const
export type MessageFolder = typeof MESSAGE_FOLDERS[number]["id"]

const EXTERNAL = new Set<Actor["kind"]>(["customer", "driver", "site_contact", "handoff_contact"])
const BAHN = new Set<Actor["kind"]>(["operator", "agent", "system"])

export function isInMessageFolder(message: GlobalInboxMessage, folder: MessageFolder): boolean {
  if (folder === "all") return true
  if (message.internal) return false
  if (folder === "sent") return BAHN.has(message.sender.kind) && EXTERNAL.has(message.recipient.kind)
  return EXTERNAL.has(message.sender.kind) && BAHN.has(message.recipient.kind)
}

export type MessageConversation = {
  orderId: string
  orderReference: string
  customerName: string
  latestMessage: GlobalInboxMessage
  messages: GlobalInboxMessage[]
}

/** One row per order, sorted by the latest activity across its entire history. */
export function groupMessagesByOrder(messages: GlobalInboxMessage[]): MessageConversation[] {
  const grouped = new Map<string, MessageConversation>()
  const newestFirst = [...messages].sort((a, b) => b.authoredAt.localeCompare(a.authoredAt) || b.id.localeCompare(a.id))
  for (const message of newestFirst) {
    const conversation = grouped.get(message.orderId)
    if (conversation) conversation.messages.push(message)
    else grouped.set(message.orderId, {
      orderId: message.orderId, orderReference: message.orderReference, customerName: message.customerName,
      latestMessage: message, messages: [message],
    })
  }
  return [...grouped.values()]
}

export function isConversationInFolder(conversation: MessageConversation, folder: MessageFolder): boolean {
  return conversation.messages.some((message) => isInMessageFolder(message, folder))
}
