const { resolve } = require("node:path")
const postgres = require("postgres")
const { buildAgentGenerationRequest, parseAgentOutput } = require("../lib/agent.ts")
require("dotenv").config({ path: resolve(__dirname, "../.env"), quiet: true })

async function generateProposals({ sql, fetchImpl = fetch, logger = console, model = process.env.OLLAMA_MODEL || "llama3.2" }) {
  const orders = await sql`
    select id, reference, status, details, agent_revision from orders
    where upper(status) = 'BLOCKED' and agent_proposal is null and agent_mode = 'AGENT'
    order by updated_at, id
  `
  const totals = { eligible: orders.length, generated: 0, skipped: 0, failed: 0 }
  logger.log(`Found ${orders.length} blocked orders without proposals.`)
  for (const order of orders) {
    try {
      const [events, alerts] = await Promise.all([
        sql`select * from (
          select * from operational_events where order_id = ${order.id}
          order by recorded_at desc, id desc limit 50
        ) recent order by recorded_at, id`,
        sql`select * from alerts where order_id = ${order.id} and status in ('OPEN', 'ACKNOWLEDGED') order by triggered_at, id`,
      ])
      logger.log(`Generating proposal for ${order.reference}…`)
      const signal = AbortSignal.timeout(180_000)
      let proposal = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl("http://127.0.0.1:11434/api/generate", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal,
          body: JSON.stringify(buildAgentGenerationRequest(events, { order, alerts }, model, attempt)),
        })
        if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}; check the server and installed model ${model}.`)
        proposal = parseAgentOutput(await response.json())
        if (proposal) break
      }
      if (!proposal) throw new Error("Ollama did not return a complete proposal matching the required executable follow-up contract.")
      const saved = await sql`
        update orders set agent_proposal = ${sql.json(proposal)}, agent_decision = 'PENDING', agent_decision_at = null
        where id = ${order.id} and upper(status) = 'BLOCKED' and agent_proposal is null
          and agent_mode = 'AGENT' and agent_revision = ${order.agent_revision}
        returning id
      `
      if (saved.length) {
        totals.generated++
        logger.log(`Saved proposal for ${order.reference}.`)
      } else {
        totals.skipped++
        logger.log(`Skipped ${order.reference}: its status or saved proposal changed during generation.`)
      }
    } catch (error) {
      totals.failed++
      logger.error(`${order.reference}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  logger.log(`Finished: ${totals.generated} saved, ${totals.skipped} skipped, ${totals.failed} failed.`)
  return totals
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in starter/.env before running ai:generate.")
  const sql = postgres(process.env.DATABASE_URL, { max: 1 })
  try {
    const result = await generateProposals({ sql })
    if (result.failed) process.exitCode = 1
  } finally {
    await sql.end()
  }
}

module.exports = { generateProposals }
if (require.main === module) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
