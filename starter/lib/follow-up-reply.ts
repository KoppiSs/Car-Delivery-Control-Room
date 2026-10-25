// Demo control on the follow-up card: the party an approved follow-up asked
// answers. A driver answers in driver_chat as that driver; a customer or site in
// its email thread. Nothing is sent anywhere. The reply ends the follow-up in the
// same transaction (lib/follow-up-close.ts), and the control table shows it as
// "New reply" until someone opens the order.

import { randomUUID } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import { nextActionTime } from "./clock"
import { CustomerEmailError, type ReplyAnswer, type ReplyKind } from "./customer-email"
import { db } from "./db"
import { closeFollowUpOnReply } from "./follow-up-close"
import { loadOrder } from "./present/load"
import { partiesFor, type Party } from "./present/names"
import type { FollowUpRecipient } from "./present/names-text"
import { agentMockActions, conversations, messages, operationalEvents, orders } from "./schema"

const REPLIES: Record<"driver" | "customer" | "site", Record<ReplyAnswer, string>> = {
  driver: { agree: "Yes, I can do that.", decline: "No, that won't work for me." },
  customer: { agree: "Yes, that works for us.", decline: "That doesn't work for us, please call me." },
  site: { agree: "Yes, that works.", decline: "No, we can't do that." },
}

const CHANNELS: Record<Exclude<FollowUpRecipient, "nobody">, string> = {
  driver: "driver_chat", customer: "customer_email", pickup_site: "site_email", delivery_site: "site_email",
}

/** Who the waiting follow-up asked, exactly as recorded when it was approved. Never guessed from its words. */
export function followUpRecipient(payload: Record<string, unknown>, parties: ReturnType<typeof partiesFor>): Party | null {
  const type = typeof payload.recipient_type === "string" ? payload.recipient_type as FollowUpRecipient : null
  if (!type || type === "nobody") return null
  const party = parties[type]
  const id = typeof payload.recipient_id === "string" ? payload.recipient_id : party?.id ?? null
  const name = typeof payload.recipient_name === "string" ? payload.recipient_name : party?.name
  return name ? { type, id, name, actorType: typeof payload.recipient_actor_type === "string" ? payload.recipient_actor_type : party?.actorType ?? null } : null
}

/** Records the reply. `text` is what the person wrote or kept from the suggestion; a quick pick fills it when empty. */
export async function simulateFollowUpReply(orderId: string, answer: ReplyKind, text?: string) {
  const loaded = await loadOrder(orderId)
  if (!loaded) throw new CustomerEmailError("Order not found.", 404)
  const parties = partiesFor(loaded.bundle)
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update")
    if (!order) throw new CustomerEmailError("Order not found.", 404)
    const [action] = await tx.select().from(agentMockActions).where(eq(agentMockActions.orderId, orderId))
      .orderBy(desc(agentMockActions.createdAt)).limit(1)
    if (order.status !== "follow_up" || !action || action.status !== "WAITING") {
      throw new CustomerEmailError("No follow-up on this order is waiting for an answer.", 409)
    }
    const party = followUpRecipient(action.payload, parties)
    if (!party) throw new CustomerEmailError("This follow-up does not record who we are waiting for, so no reply can be simulated.", 409)
    const kind = party.type === "driver" ? "driver" : party.type === "customer" ? "customer" : "site"
    const channel = CHANNELS[party.type as Exclude<FollowUpRecipient, "nobody">]
    const now = await nextActionTime(tx)
    const at = now.toISOString()

    // The thread with that party, or a new one.
    const [existing] = await tx.select().from(conversations).where(and(eq(conversations.orderId, orderId), eq(conversations.channel, channel)))
      .orderBy(desc(conversations.updatedAt)).limit(1)
    const threadId = existing?.id ?? `conv-${randomUUID()}`
    if (existing) {
      await tx.update(conversations).set({ status: "OPEN", updatedAt: now, details: { ...existing.details, status: "OPEN", updated_at: at } })
        .where(eq(conversations.id, threadId))
    } else {
      await tx.insert(conversations).values({ id: threadId, orderId, channel, category: "follow_up", status: "OPEN", updatedAt: now, details: {
        id: threadId, channel, category: "follow_up", status: "OPEN", order_id: orderId, started_at: at, updated_at: at,
        counterparty_id: party.id, counterparty_type: party.actorType, counterparty_name_snapshot: party.name,
        ...(party.type === "pickup_site" || party.type === "delivery_site" ? { recipient_type: party.type } : {}), simulated: true,
      } })
    }
    const body = text?.trim() || (answer === "other" ? "" : REPLIES[kind][answer])
    if (!body) throw new CustomerEmailError("Write the reply before recording it.", 400)
    const messageId = `msg-${randomUUID()}`
    await tx.insert(messages).values({ id: messageId, orderId, conversationId: threadId, authorType: party.actorType ?? kind, body,
      authoredAt: now, details: {
        id: messageId, body, channel, language: "en", order_id: orderId, author_id: party.id, author_type: party.actorType ?? kind,
        author_name_snapshot: party.name, visibility: "PUBLIC", authored_at: at, recipient_id: "ops-support", recipient_type: "operator",
        conversation_id: threadId, simulated: true, answer, follow_up_mock_action_id: action.id,
      } })
    await tx.insert(operationalEvents).values({ id: `evt-${randomUUID()}`, orderId, command: "agent.follow_up_reply_simulated",
      targetType: "mock_action", targetId: action.id, recordedAt: now, details: {
        actor_type: party.actorType ?? kind, actor_id: party.id, source: "control_room_follow_up", simulated: true, simulated_by: "operator",
        recipient_type: party.type, changes: { message_id: messageId, conversation_id: threadId, answer, body },
      } })
    const closed = await closeFollowUpOnReply(tx, { orderId, recipientType: party.type === "driver" ? "driver" : party.type as "customer" | "pickup_site" | "delivery_site",
      answer, messageId, conversationId: threadId, at: now })
    return { success: true, simulated: true, messageId, answer, from: party.name, status: closed?.status ?? order.status }
  })
}
