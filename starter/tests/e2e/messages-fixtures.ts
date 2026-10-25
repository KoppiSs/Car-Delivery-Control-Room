import "dotenv/config"
import { randomUUID } from "node:crypto"
import { test as base, expect } from "@playwright/test"
import postgres from "postgres"

type MessageOrders = { first: string; second: string; firstMessageIds: string[]; secondMessageId: string }

export const test = base.extend<{ messageOrders: MessageOrders }>({
  messageOrders: async ({}, use) => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 })
    const prefix = `test-message-${randomUUID()}`
    const first = `${prefix}-a`
    const second = `${prefix}-b`
    const firstMessageIds = [`${first}-old`, `${first}-new`]
    const secondMessageId = `${second}-message`
    try {
      await sql.begin(async (tx) => {
        const [latest] = await tx`select coalesce(max(authored_at),now()) + interval '1 minute' as at from messages`
        const at = new Date(latest.at)
        for (const id of [first, second]) {
          await tx`insert into orders (id,reference,customer_id,pickup_site_id,delivery_site_id,pickup_address_id,delivery_address_id,
            display_lane,status,route_kind,created_at,updated_at,details)
            select ${id},${id},customer_id,pickup_site_id,delivery_site_id,pickup_address_id,delivery_address_id,
            'intake','NEW',route_kind,now(),now(),${tx.json({ id, reference: id, status: 'NEW', readiness_status: 'CONFIRMED' })}
            from orders order by id limit 1`
          await tx`insert into conversations (id,order_id,category,channel,status,updated_at,details)
            values (${id + '-conversation'},${id},'order_information','email','OPEN',${at},${tx.json({ id: id + '-conversation', order_id: id, channel: 'email', category: 'order_information', status: 'OPEN', started_at: at.toISOString() })})`
        }
        const [order] = await tx`select customer_id from orders where id=${first}`
        const oldAt = new Date(at.getTime() - 60_000)
        await tx`insert into messages (id,order_id,conversation_id,author_type,body,authored_at,is_read,details)
          values (${firstMessageIds[0]},${first},${first + '-conversation'},'operator','Earlier recorded message.',${oldAt},true,
          ${tx.json({ author_id: 'operator', recipient_id: order.customer_id, recipient_type: 'customer', visibility: 'PUBLIC', channel: 'email' })})`
        // Omit is_read so these messages exercise the database default.
        await tx`insert into messages (id,order_id,conversation_id,author_type,body,authored_at,details)
          values (${firstMessageIds[1]},${first},${first + '-conversation'},'customer',
          'This is the complete latest message for the browser fixture. The conversation preview should be shortened, but the expanded history must retain every word, including this final sentence beyond the short preview.',${at},
          ${tx.json({ author_id: order.customer_id, recipient_id: 'operator', recipient_type: 'operator', visibility: 'PUBLIC', channel: 'email' })})`
        await tx`insert into messages (id,order_id,conversation_id,author_type,body,authored_at,details)
          values (${secondMessageId},${second},${second + '-conversation'},'driver','Separate order; keep this unread.',${new Date(at.getTime() + 1000)},
          ${tx.json({ author_id: 'test-driver', recipient_id: 'operator', recipient_type: 'operator', visibility: 'PUBLIC', channel: 'app_chat' })})`
      })
      await use({ first, second, firstMessageIds, secondMessageId })
    } finally {
      await sql.begin(async (tx) => {
        for (const id of [first, second]) {
          await tx`delete from messages where order_id=${id}`
          await tx`delete from conversations where order_id=${id}`
          await tx`delete from orders where id=${id}`
        }
      })
      await sql.end()
    }
  },
})

export { expect }
