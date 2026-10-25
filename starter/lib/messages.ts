import "server-only"

import { desc, eq } from "drizzle-orm"
import { db } from "./db"
import { customers, messages, orders } from "./schema"
import { loadShared } from "./present/load"
import { str } from "./present/bundle"
import { label } from "./present/labels"
import type { GlobalInboxMessage } from "./present/messages"

/** All order messages, newest first. Read only; no messages are sent. */
export async function getGlobalInbox(): Promise<GlobalInboxMessage[]> {
  const [records, shared] = await Promise.all([
    db.select({ message: messages, orderReference: orders.reference, customerName: customers.name })
      .from(messages)
      .innerJoin(orders, eq(messages.orderId, orders.id))
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .orderBy(desc(messages.authoredAt), desc(messages.id)),
    loadShared(),
  ])
  const directory = shared.makeDirectory()
  return records.map(({ message, orderReference, customerName }) => {
    const sender = directory.resolve(message.details.author_id, message.authorType)
    const recipient = directory.resolve(message.details.recipient_id, message.details.recipient_type)
    const senderSnapshot = str(message.details.author_name_snapshot)
    const recipientSnapshot = str(message.details.recipient_name_snapshot)
    const channel = str(message.details.channel) ?? ""
    return {
      id: message.id, orderId: message.orderId, orderReference, customerName,
      // Endpoint contacts can change; retain the name recorded on each message.
      sender: senderSnapshot ? { ...sender, name: senderSnapshot } : sender,
      recipient: recipientSnapshot ? { ...recipient, name: recipientSnapshot } : recipient,
      authoredAt: message.authoredAt.toISOString(), body: message.body, isRead: message.isRead, channel: label(channel),
      internal: message.details.visibility === "INTERNAL" || channel === "internal_note",
    }
  })
}
