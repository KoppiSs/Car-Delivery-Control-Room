import "dotenv/config"
import assert from "node:assert/strict"
import postgres from "postgres"

type OrderSnapshot = { id: string; reference: string; status: string; agent_mode: string; details: Record<string, unknown> }
type AlertSnapshot = { order_id: string; status: string }
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before checking the Control Room.")
  const sql = postgres(process.env.DATABASE_URL, { max: 1 })
  let orders: OrderSnapshot[]
  let alerts: AlertSnapshot[]
  try {
    [orders, alerts] = await Promise.all([
      sql<OrderSnapshot[]>`select id, reference, status, agent_mode, details from orders`,
      sql<AlertSnapshot[]>`select order_id, status from alerts`,
    ])
  } finally { await sql.end() }
  // Use current state: operators can resolve alerts and create waiting work locally.
  const active = new Set(alerts.filter((alert) => ["OPEN", "ACKNOWLEDGED"].includes(alert.status)).map((alert) => alert.order_id))
  const expected = orders.filter((order) => active.has(order.id) || order.agent_mode === "MANUAL" || order.status === "follow_up"
    || (order.agent_mode !== "MANUAL_COMPLETE" && (order.status === "BLOCKED" || order.details.readiness_status === "BLOCKED")))
  const base = process.env.APP_URL ?? "http://localhost:3000"
  const response = await fetch(`${base}/api/overview`)
  assert.equal(response.status, 200)
  const overview = await response.json() as { total: number; visible: { id: string }[] }
  assert.deepEqual(overview.visible.map((card) => card.id).sort(), expected.map((order) => order.id).sort())
  assert.equal(overview.total, expected.length)
  const quiet = orders.find((order) => !expected.some((match) => match.id === order.id))
  assert.ok(quiet, "Fixture must contain a quiet order")
  const search = await fetch(`${base}/api/overview?q=${encodeURIComponent(quiet.reference)}`)
  assert.equal(search.status, 200)
  assert.deepEqual((await search.json()).visible, [], "Search must not reintroduce quiet orders")
  const deliveries = await fetch(`${base}/api/deliveries`)
  assert.equal(deliveries.status, 200)
  const register = await deliveries.json() as { total: number; visible: { id: string }[] }
  assert.equal(register.total, orders.length)
  assert.deepEqual(register.visible.map((card) => card.id).sort(), orders.map((order) => order.id).sort(), "All Deliveries must include every order regardless of status")
  const deliverySearch = await fetch(`${base}/api/deliveries?q=${encodeURIComponent(quiet.reference)}`)
  assert.equal(deliverySearch.status, 200)
  assert.ok((await deliverySearch.json()).visible.some((card: { id: string }) => card.id === quiet.id), "Quiet orders must be searchable in All Deliveries")
  const deliveriesPage = await fetch(`${base}/deliveries`)
  assert.equal(deliveriesPage.status, 200)
  const deliveriesHtml = await deliveriesPage.text()
  assert.ok(deliveriesHtml.includes('aria-current="page"'))
  assert.ok(deliveriesHtml.includes('All Deliveries'))
  assert.ok(deliveriesHtml.includes('Delivery register'))
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.ok((await page.text()).includes("Needs your attention"))
  console.log(`Verified Control Room: ${expected.length} current exceptions and follow-ups; quiet orders excluded, including from search.`)
  console.log(`Verified All Deliveries: all ${orders.length} orders included, quiet orders searchable, separate navigation view renders.`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
