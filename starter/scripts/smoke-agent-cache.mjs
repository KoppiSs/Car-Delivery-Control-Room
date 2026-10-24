import "dotenv/config"
import assert from "node:assert/strict"
import postgres from "postgres"

const base = process.env.APP_URL ?? "http://localhost:3000"
const orderId = process.env.AGENT_TEST_ORDER_ID ?? "ord-00593"
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
try {
  const orderResponse = await fetch(`${base}/api/orders/${orderId}`)
  assert.equal(orderResponse.status, 200)
  const detail = await orderResponse.json()
  const first = await fetch(`${base}/api/agent`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, events: detail.events, context: {
      order: { id: orderId, reference: detail.order.reference },
      snapshot_at: detail.view.snapshotAt, attention: detail.view.attention, alerts: detail.view.alerts,
    } }),
  })
  const proposal = await first.json()
  assert.equal(first.status, 200, JSON.stringify(proposal))
  const [saved] = await sql`select agent_proposal from orders where id = ${orderId}`
  assert.deepEqual(saved.agent_proposal, proposal)
  const start = performance.now()
  const cached = await fetch(`${base}/api/agent`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }),
  })
  assert.equal(cached.status, 200)
  assert.deepEqual(await cached.json(), proposal)
  console.log(`Verified ${orderId}: proposal persisted in Postgres; cached response returned in ${Math.round(performance.now() - start)} ms without event history.`)
} finally { await sql.end() }
