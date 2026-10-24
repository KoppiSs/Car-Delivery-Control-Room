import { executableFields } from "./fixtures/proposal.cjs"
import "dotenv/config"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import postgres from "postgres"
const { generateProposals } = createRequire(import.meta.url)("./generate_proposals.js")
const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const prefix = `test-batch-${randomUUID()}`
const rollback = new Error("Rollback test fixtures")
const proposal = { ...executableFields, investigation_summary: ["Fictional test evidence needs review."], proposed_action: "Ask an operator to review the evidence.", decision_button_text: "Approve follow-up" }
try {
  const [existing] = await sql`select count(*)::int as count from orders where upper(status) = 'BLOCKED' and agent_proposal is null`
  assert.equal(existing.count, 0, "Run this fixture test against a database with no pending blocked orders")
  try {
    await sql.begin(async (tx) => {
      const statuses = ["BLOCKED", "blocked", "BLOCKED", "IN_TRANSIT", "BLOCKED", "BLOCKED"]
      for (const [index, status] of statuses.entries()) {
        const id = `${prefix}-${index}`
        await tx`insert into orders (id, reference, customer_id, pickup_site_id, delivery_site_id, pickup_address_id,
          delivery_address_id, display_lane, status, route_kind, created_at, updated_at, details, agent_proposal)
          select ${id}, ${id}, customer_id, pickup_site_id, delivery_site_id, pickup_address_id,
          delivery_address_id, display_lane, ${status}, route_kind, created_at, updated_at, details,
          ${index === 2 ? tx.json(proposal) : null} from orders order by id limit 1`
      }
      const called = []
      const fetchImpl = async (url, options) => {
        assert.equal(url, "http://127.0.0.1:11434/api/generate")
        const body = JSON.parse(options.body)
        assert.equal(body.format.type, "object")
        assert.equal(body.format.additionalProperties, false)
        assert.equal(body.stream, false)
        assert.equal(body.model, "test-model")
        assert.match(body.system, /NEVER contact customers autonomously/)
        const { context } = JSON.parse(body.prompt.slice(body.prompt.indexOf("\n") + 1))
        const id = context.order.id
        called.push(id)
        if (id === `${prefix}-5`) return Response.json({ response: "invalid JSON" })
        if (id === `${prefix}-4`) await tx`update orders set agent_proposal = ${tx.json({ ...proposal, proposed_action: "Already saved elsewhere." })} where id = ${id}`
        return Response.json({ response: JSON.stringify(proposal) })
      }
      const totals = await generateProposals({ sql: tx, fetchImpl, model: "test-model", logger: { log() {}, error() {} } })
      assert.deepEqual(totals, { eligible: 4, generated: 2, skipped: 1, failed: 1 })
      assert.deepEqual(called.sort(), [0, 1, 4, 5, 5].map((index) => `${prefix}-${index}`))
      const records = await tx`select id, agent_proposal from orders where id like ${prefix + '%'} order by id`
      for (const index of [0, 1, 2]) assert.deepEqual(records[index].agent_proposal, proposal)
      assert.equal(records[3].agent_proposal, null, "Smooth orders must not receive proposals")
      assert.equal(records[4].agent_proposal.proposed_action, "Already saved elsewhere.")
      assert.equal(records[5].agent_proposal, null, "Failed generation must remain retryable")
      throw rollback
    })
  } catch (error) { if (error !== rollback) throw error }
  console.log("Verified batch generator against Postgres: blocked-only selection, cached exclusion, validated persistence, race protection, and failure isolation. Test records rolled back.")
} finally { await sql.end() }
