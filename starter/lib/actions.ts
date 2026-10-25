"use server"

import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "./db"
import { messages } from "./schema"

export async function markThreadAsRead(orderId: string): Promise<{ updatedMessageIds: string[] }> {
  if (typeof orderId !== "string" || !orderId.trim() || orderId.length > 200) {
    throw new Error("A valid order ID is required.")
  }
  const updated = await db.update(messages).set({ isRead: true })
    .where(and(eq(messages.orderId, orderId), eq(messages.isRead, false)))
    .returning({ id: messages.id })
  revalidatePath("/inbox")
  return { updatedMessageIds: updated.map((message) => message.id) }
}
