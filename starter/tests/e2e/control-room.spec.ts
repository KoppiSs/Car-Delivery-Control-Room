// Clicks the real buttons on seeded orders and checks where the Control Room puts them:
// Approve → Pending, Approve your version → Pending, Take Over → Manual control,
// Record what you did (twice) → still Manual control, End "Problem solved" → leaves the table
// with its alerts resolved by the operator, End "Hand back to the agent" → Needs a review. The agent's proposal is placed directly in the
// database (no model call); everything after that goes through the browser.
// Afterwards every row the test created is removed and the orders are restored.
import "dotenv/config"
import { expect, test, type Page } from "@playwright/test"
import postgres from "postgres"

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 })
// The last case scans every order in the warning strip, so all of them are saved and restored.
const ORDERS = ["ord-00322", "ord-00399", "ord-00299", "ord-00710", "ord-00075", "ord-00405", "ord-00439", "ord-00656", "ord-00806", "ord-01013"]
/** Orders the clicks depend on must be fresh; the other strip orders are only saved and restored, whatever state they are in. */
const MUST_BE_FRESH = new Set(["ord-00399", "ord-00299", "ord-00710", "ord-00806", "ord-00439", "ord-00075"])
const TABLES = ["messages", "conversations", "agent_mock_actions", "agent_proposal_feedback", "operational_events"] as const
const FIXTURE = {
  investigation_summary: [{ text: "The driver says they cannot reach the pickup in time.", source_event_ids: [] }],
  proposed_action: "Ask the driver which pickup time they can make.",
  decision_button_text: "Approve follow-up",
  executable_tool_call: { action_type: "driver.ask_time", payload: { description: "Ask the driver which pickup time they can make." } },
  waiting_on_description: "Driver names a pickup time they can make",
}

type Snapshot = { rows: Record<string, Set<string>>; mocks: { id: string; status: string }[]; alerts: { id: string; status: string; details: unknown }[]
  order: Record<string, unknown> }
const snapshots = new Map<string, Snapshot>()

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  expect(process.env.DATABASE_URL, "DATABASE_URL is set").toBeTruthy()
  for (const id of ORDERS) {
    const rows: Record<string, Set<string>> = {}
    for (const table of TABLES) rows[table] = new Set((await sql`select id from ${sql(table)} where order_id = ${id}`).map((row) => row.id as string))
    const mocks = (await sql`select id, status from agent_mock_actions where order_id = ${id}`) as unknown as { id: string; status: string }[]
    const alerts = (await sql`select id, status, details from alerts where order_id = ${id}`) as unknown as Snapshot["alerts"]
    const [order] = await sql`select status, agent_mode, agent_decision, agent_decision_at, agent_revision, agent_proposal, waiting_on_description, updated_at
      from orders where id = ${id}`
    if (MUST_BE_FRESH.has(id)) {
      expect(order.status, `${id} must not already be waiting; run npm run db:seed`).not.toBe("follow_up")
      expect(order.agent_mode, `${id} must not be under manual control; run npm run db:seed`).toBe("AGENT")
    }
    snapshots.set(id, { rows, mocks, alerts, order })
  }
})

test.afterAll(async () => {
  for (const [id, snapshot] of snapshots) {
    for (const table of TABLES) {
      const ids = (await sql`select id from ${sql(table)} where order_id = ${id}`).map((row) => row.id as string).filter((rowId) => !snapshot.rows[table].has(rowId))
      if (ids.length) await sql`delete from ${sql(table)} where id in ${sql(ids)}`
    }
    for (const mock of snapshot.mocks) await sql`update agent_mock_actions set status = ${mock.status} where id = ${mock.id}`
    for (const alert of snapshot.alerts) await sql`update alerts set status = ${alert.status}, details = ${sql.json(alert.details as postgres.JSONValue)} where id = ${alert.id}`
    const o = snapshot.order
    await sql`update orders set status = ${o.status as string}, agent_mode = ${o.agent_mode as string}, agent_decision = ${o.agent_decision as string},
      agent_decision_at = ${o.agent_decision_at as Date | null}, agent_revision = ${o.agent_revision as number},
      agent_proposal = ${o.agent_proposal ? sql.json(o.agent_proposal as postgres.JSONValue) : null}, waiting_on_description = ${o.waiting_on_description as string | null},
      updated_at = ${o.updated_at as Date} where id = ${id}`
  }
  await sql`delete from related_records where collection = 'demo_model_stub'`
  await sql.end()
})

async function withProposal(id: string) {
  await sql`update orders set agent_proposal = ${sql.json(FIXTURE)}, agent_decision = 'PENDING' where id = ${id}`
}

/** The box an order sits in on the Control Room page, read from the page itself. */
async function expectInBox(page: Page, reference: string, box: "review" | "pending" | "manual" | "none") {
  await page.goto("/")
  await expect(page.locator(`section[aria-labelledby="control-review"]`)).toBeVisible()
  // Pending collapses to its header when it holds more than 5 orders: open it before looking inside.
  const collapsed = page.locator(`section[aria-labelledby="control-pending"] button[aria-expanded="false"]`)
  if (await collapsed.count()) await collapsed.click()
  if (box !== "none") await expect(page.locator(`section[aria-labelledby="control-${box}"]`).getByText(reference, { exact: true })).toBeVisible()
  for (const other of (["review", "pending", "manual"] as const).filter((name) => name !== box)) {
    await expect(page.locator(`section[aria-labelledby="control-${other}"]`).getByText(reference, { exact: true })).toHaveCount(0)
  }
}

test("Approve (agent's plan, waiting for the driver) → Pending", async ({ page }) => {
  await withProposal("ord-00399")
  await page.goto("/orders/ord-00399")
  await page.getByRole("button", { name: "Approve follow-up" }).click()
  await page.locator("#approve-recipient").selectOption("driver")
  await page.getByRole("button", { name: "Approve", exact: true }).click()
  await expect(page.getByText("Waiting on", { exact: true })).toBeVisible()
  await expectInBox(page, "CD-420399", "pending")
})

test("Approve your version (waiting for the customer) → Pending", async ({ page }) => {
  await withProposal("ord-00299")
  await page.goto("/orders/ord-00299")
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await page.locator("#your-action").fill("Tell the customer about the later ferry and ask if Sunday arrival works.")
  await page.locator("#your-recipient").selectOption("customer")
  await page.locator("#your-waiting").fill("Customer confirms Sunday arrival")
  await page.getByRole("button", { name: "Approve your version" }).click()
  await expect(page.getByText("Waiting on", { exact: true })).toBeVisible()
  await expectInBox(page, "CD-420299", "pending")
})

test("Take Over, then Record what you did twice → still Manual control, both listed", async ({ page }) => {
  await page.goto("/orders/ord-00399")
  await page.getByRole("button", { name: "Take Over" }).click()
  await expect(page.getByRole("button", { name: "End manual control" })).toBeVisible()
  for (const note of ["Called the driver, no answer", "Called the dealer, recovery truck at 14:00"]) {
    await page.locator("#manual-note").fill(note)
    await page.getByRole("button", { name: "Record what you did" }).click()
    await expect(page.locator(".manual-records").getByText(note)).toBeVisible()
  }
  await expect(page.locator(".manual-records li")).toHaveCount(2)
  await expectInBox(page, "CD-420399", "manual")
})

test("End manual control: Problem solved → leaves the table, alerts resolved by the operator", async ({ page }) => {
  const note = "Replacement driver confirmed for Friday 08:00"
  await page.goto("/orders/ord-00399")
  await page.locator("#manual-end-note").fill(note)
  await page.getByLabel("Problem solved, close it").check()
  await page.getByRole("button", { name: "End manual control" }).click()
  await expect(page.getByText("Closed by an operator.")).toBeVisible()
  await expectInBox(page, "CD-420399", "none")
  const alerts = await sql`select status, details->>'resolved_by' as by, details->>'resolution_reason' as reason from alerts where order_id = 'ord-00399'`
  expect(alerts.length).toBeGreaterThan(0)
  for (const alert of alerts) expect({ status: alert.status, by: alert.by, reason: alert.reason }).toEqual({ status: "RESOLVED", by: "operator", reason: note })
  await page.goto("/deliveries")
  await expect(page.getByText(/Closed by operator \d\d:\d\d: Replacement driver confirmed for Friday 08:00/)).toBeVisible()
})

test("End manual control: Hand back to the agent → Needs a review", async ({ page }) => {
  await page.goto("/orders/ord-00299")
  await page.getByRole("button", { name: "Take Over" }).click()
  await expect(page.getByRole("button", { name: "End manual control" })).toBeVisible()
  await expectInBox(page, "CD-420299", "manual")
  await page.goto("/orders/ord-00299")
  await page.locator("#manual-end-note").fill("Checked the ferry options; the agent can propose the next step")
  await page.getByLabel("Hand back to the agent").check()
  await page.getByRole("button", { name: "End manual control" }).click()
  await expect(page.getByRole("button", { name: "End manual control" })).toHaveCount(0)
  await expectInBox(page, "CD-420299", "review")
  const [alert] = await sql`select status from alerts where order_id = 'ord-00299' and signal = 'FERRY_SOLD_OUT'`
  expect(alert.status, "handing back leaves alerts as they are").toBe("ACKNOWLEDGED")
})

// Reject → regenerate, with the model stubbed: answers are queued in related_records ("demo_model_stub")
// and the server takes one per model call instead of calling the local model.
const SITE_PLAN = JSON.stringify({
  investigation_summary: [{ text: "The ferry connection is at risk; the receiving site may accept a later handover.", source_event_ids: [] }],
  executable_tool_call: { action_type: "site.ask_later_handover", payload: { description: "Ask the delivery site whether a later handover on Friday works." } },
  waiting_on_description: "Delivery site confirms a later handover on Friday",
})

async function stubModel(...answers: ({ response: string } | { error: string })[]) {
  await sql`delete from related_records where collection = 'demo_model_stub'`
  for (const [index, answer] of answers.entries()) {
    await sql`insert into related_records (collection, id, order_id, details) values ('demo_model_stub', ${`stub-${String(index).padStart(3, "0")}`}, null, ${sql.json(answer)})`
  }
}

test("Reject with a reason → a new proposal replaces it, with the rejected one listed", async ({ page }) => {
  await withProposal("ord-00710")
  await stubModel({ response: SITE_PLAN })
  await page.goto("/orders/ord-00710")
  await page.getByRole("button", { name: "Reject", exact: true }).click()
  await page.getByRole("button", { name: "Wrong person to contact" }).click()
  await page.getByRole("button", { name: "Reject and ask for another" }).click()
  await expect(page.getByText("Ask the delivery site whether a later handover on Friday works.").first()).toBeVisible()
  await expect(page.getByText("Replaces 1 rejected suggestion")).toBeVisible()
  const [feedback] = await sql`select decision, correction from agent_proposal_feedback where order_id = 'ord-00710' order by created_at desc limit 1`
  expect({ decision: feedback.decision, correction: feedback.correction }).toEqual({ decision: "REJECT", correction: "Wrong person to contact" })
})

test("Reject again, the model repeats a rejected plan twice → 'The agent has no other suggestion'", async ({ page }) => {
  await stubModel({ response: SITE_PLAN }, { response: SITE_PLAN })
  await page.goto("/orders/ord-00710")
  await page.getByRole("button", { name: "Reject", exact: true }).click()
  await page.locator("#reject-reason").fill("The site cannot take cars on Fridays")
  await page.getByRole("button", { name: "Reject and ask for another" }).click()
  await expect(page.getByText("The agent has no other suggestion.")).toBeVisible()
  const box = page.locator(".agent-legacy-note").filter({ hasText: "The agent has no other suggestion." })
  await expect(box.getByRole("button", { name: "Edit" })).toBeVisible()
  await expect(box.getByRole("button", { name: "Take over" })).toBeVisible()
})

test("Reject, the model fails → 'Couldn't make a new suggestion' with Try again, Edit and Take over", async ({ page }) => {
  await withProposal("ord-00710")
  await stubModel({ error: "the local model could not be reached" })
  await page.goto("/orders/ord-00710")
  await page.getByRole("button", { name: "Reject", exact: true }).click()
  await page.getByRole("button", { name: "Facts are wrong" }).click()
  await page.getByRole("button", { name: "Reject and ask for another" }).click()
  const error = page.getByRole("alert").filter({ hasText: "Couldn't make a new suggestion: the local model could not be reached." })
  await expect(error).toBeVisible()
  for (const name of ["Try again", "Edit", "Take over"]) await expect(error.getByRole("button", { name, exact: true })).toBeVisible()
})

/** Set when the scan case ran on fresh orders; the Reopen case builds on what it cleared. */
let scanRan = false

test("Possible problems with no alert: Check all → CD-420806 cleared, CD-420439 and CD-421013 escalated", async ({ page }) => {
  // Needs orders nobody has scanned yet; someone's own "Check all" since the last seed makes this case meaningless.
  const [{ count }] = await sql`select count(*)::int as count from operational_events where order_id in ('ord-00806', 'ord-00439') and command like 'agent.scan_%'`
  test.skip(count > 0, "CD-420806 / CD-420439 were already scanned since the last seed; run npm run db:seed to run this case")
  scanRan = true
  // Verdicts by order reference; orders without a scripted driver reply are only asked, with no model call.
  await stubModel(
    { key: "CD-420806", response: JSON.stringify({ verdict: "fine", reason: "driver reported position, ETA inside promise" }) } as never,
    { key: "CD-421013", response: JSON.stringify({ verdict: "unsure", reason: "the driver gave no arrival time" }) } as never,
    { key: "CD-420710", response: JSON.stringify({ verdict: "needs_person", reason: "no margin left before the promise ends" }) } as never,
  )
  await page.goto("/")
  const strip = page.locator('section[aria-labelledby="scan-strip-title"]')
  await expect(strip.getByText(/possible problems? with no alert/)).toBeVisible()
  await strip.getByRole("button", { name: "Check all" }).click()
  await expect(strip.getByText(/Closed by the agent\. Checked: .*“Location sharing was switched off on my phone\. I'm near Jyväskylä and on time\.” \(Scripted reply \(simulation\)\)/)).toBeVisible({ timeout: 120_000 })
  // When every order has moved on, the strip itself disappears; wait until nothing is still being checked.
  await expect(page.getByRole("button", { name: "Checking…" })).toHaveCount(0, { timeout: 120_000 })

  await page.goto("/")
  const review = page.locator('section[aria-labelledby="control-review"]')
  // Cleared: gone from the strip and from every box.
  await expect(page.getByText("CD-420806", { exact: true })).toHaveCount(0)
  // Found by the agent from the data (ETA after the promise), and unsure after the driver's reply.
  await expect(review.locator("a", { hasText: "CD-420439" }).getByText(/No alert, found by agent/).first()).toBeVisible()
  // CD-421013 is only checked when it was still in the strip (not already handled by someone).
  if (snapshots.get("ord-01013")?.order.status !== "follow_up") {
    await expect(review.locator("a", { hasText: "CD-421013" }).getByText(/Agent couldn't confirm: no app ETA on file to confirm the delivery promise · Agent's verdict: unsure/)).toBeVisible()
  }
  // ETA exactly at the promise end: never closed by the agent (needs 15 min margin).
  await expect(review.locator("a", { hasText: "CD-420710" }).getByText(/No alert, found by agent: ETA only 0 min inside the promise; under 15 min/)).toBeVisible()
  // Asked the driver, no scripted answer: Pending as usual.
  await expect(page.locator('section[aria-labelledby="control-pending"]').getByText("CD-420075", { exact: true })).toBeVisible()

  await expect(page.getByText("driver reported position, ETA inside promise")).toHaveCount(0)
  const events = await sql`select command from operational_events where order_id = 'ord-00806' and command like 'agent.scan_%' order by recorded_at`
  expect(events.map((row) => row.command)).toEqual(["agent.scan_started", "agent.scan_cleared"])
  await page.goto("/deliveries")
  await expect(page.getByText(/Checked \d\d:\d\d: .*“Location sharing was switched off.*latest app ETA .* inside the delivery promise.* · Agent's verdict: fine · Sources: Driver/)).toBeVisible()
})

test("Closed by the agent today: the reply shows its source; Reopen moves CD-420806 to Needs a review", async ({ page }) => {
  test.skip(!scanRan, "Builds on the scan case, which needs a fresh seed")
  await page.goto("/")
  const closed = page.locator("details", { hasText: /Closed by the agent today \(\d+\)/ })
  await closed.locator("summary").click()
  const row = closed.locator("li", { hasText: "CD-420806" })
  await expect(row.getByText("Scripted reply (simulation)", { exact: true })).toBeVisible()
  await row.getByRole("button", { name: "Reopen" }).click()
  const review = page.locator('section[aria-labelledby="control-review"]')
  await expect(review.locator("a", { hasText: "CD-420806" }).getByText("Reopened by operator after the agent had closed it", { exact: true })).toBeVisible()
  const [event] = await sql`select command, details->>'actor_type' as actor from operational_events where order_id = 'ord-00806' and command like 'agent.scan_%' order by recorded_at desc limit 1`
  expect({ command: event.command, actor: event.actor }).toEqual({ command: "agent.scan_reopened", actor: "operator" })
})

// The proposal model must never speak as the driver. Stubbed answers: one in the driver's voice, then a proper instruction.
const DRIVER_VOICE = JSON.stringify({
  investigation_summary: [{ text: "Driver reports a red warning and has stopped safely.", source_event_ids: [] }],
  executable_tool_call: { action_type: "driver.reply", payload: { description: "I received the message, but I'm still at the service area car park, waiting for further instructions." } },
  waiting_on_description: "Driver to return confirmation of car park arrival",
})
const OUR_ACTION = JSON.stringify({
  investigation_summary: [{ text: "Driver reports a red warning and has stopped safely.", source_event_ids: [] }],
  executable_tool_call: { action_type: "dealer.ask_recovery", payload: { description: "Ask the dealer whether the car can wait at the service area until recovery arrives." } },
  waiting_on_description: "Dealer confirms the recovery plan",
})

test("Generate: an answer in the driver's voice is retried once with the rule; the instruction is shown", async ({ page }) => {
  await sql`update orders set agent_proposal = null, agent_decision = 'PENDING' where id = 'ord-00322'`
  await stubModel({ response: DRIVER_VOICE }, { response: OUR_ACTION })
  await page.goto("/orders/ord-00322")
  await page.getByRole("button", { name: "Generate proposal" }).click()
  await expect(page.getByText("Ask the dealer whether the car can wait at the service area until recovery arrives.").first()).toBeVisible()
  await expect(page.getByText(/I received the message/)).toHaveCount(0)
})

test("Generate: the driver's voice twice → 'No suggestion yet', nothing saved", async ({ page }) => {
  await sql`update orders set agent_proposal = null, agent_decision = 'PENDING' where id = 'ord-00322'`
  await stubModel({ response: DRIVER_VOICE }, { response: DRIVER_VOICE })
  await page.goto("/orders/ord-00322")
  await page.getByRole("button", { name: "Generate proposal" }).click()
  await expect(page.getByText("No suggestion yet.", { exact: false }).first()).toBeVisible()
  await expect(page.getByText(/I received the message/)).toHaveCount(0)
  const [order] = await sql`select agent_proposal from orders where id = 'ord-00322'`
  expect(order.agent_proposal).toBeNull()
})

// CD-420322 has an open safety stop (red warning light): a plan that has the car driven on is refused.
const DRIVE_ON = JSON.stringify({
  investigation_summary: [{ text: "Driver reports a red warning and has stopped safely.", source_event_ids: [] }],
  executable_tool_call: { action_type: "driver.ask_clearance", payload: { description: "Ask the driver whether the driver has already cleared to drive." } },
  waiting_on_description: "Driver confirms whether the car can continue",
})

test("Safety stop: a stored 'cleared to drive' suggestion is not shown; a drive-on answer is retried and the recovery step shown", async ({ page }) => {
  const stored = { proposed_action: "Ask the driver whether the driver has already cleared to drive.", decision_button_text: "Approve follow-up",
    executable_tool_call: { action_type: "driver.ask_clearance", payload: { description: "Ask the driver whether the driver has already cleared to drive." } },
    investigation_summary: [{ text: "Driver reports a red warning and has stopped safely.", source_event_ids: [] }],
    waiting_on_description: "Driver confirms whether the car can continue" }
  await sql`update orders set agent_proposal = ${sql.json(stored)}, agent_decision = 'PENDING' where id = 'ord-00322'`
  await stubModel({ response: DRIVE_ON }, { response: OUR_ACTION })
  await page.goto("/orders/ord-00322")
  await expect(page.getByText("The stored suggestion did not pass the checks", { exact: false })).toBeVisible()
  await expect(page.getByText(/breaks the safety rule/)).toBeVisible()
  await page.getByRole("button", { name: "Generate proposal" }).click()
  await expect(page.getByText("Ask the dealer whether the car can wait at the service area until recovery arrives.").first()).toBeVisible()
  // The records themselves say "driver cleared to drive: no"; only the suggestion must be gone.
  await expect(page.getByText("Ask the driver whether the driver has already cleared to drive.")).toHaveCount(0)
})

test("Safety stop: drive on twice → 'No suggestion yet', nothing saved", async ({ page }) => {
  await sql`update orders set agent_proposal = null, agent_decision = 'PENDING' where id = 'ord-00322'`
  await stubModel({ response: DRIVE_ON }, { response: DRIVE_ON })
  await page.goto("/orders/ord-00322")
  await page.getByRole("button", { name: "Generate proposal" }).click()
  await expect(page.getByText("No suggestion yet.", { exact: false }).first()).toBeVisible()
  await expect(page.getByText(/breaks the safety rule/)).toBeVisible()
  const [order] = await sql`select agent_proposal from orders where id = 'ord-00322'`
  expect(order.agent_proposal).toBeNull()
})
