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
const ORDERS = ["ord-00399", "ord-00299", "ord-00710"]
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
    expect(order.status, `${id} must not already be waiting; run npm run db:seed`).not.toBe("follow_up")
    expect(order.agent_mode, `${id} must not be under manual control; run npm run db:seed`).toBe("AGENT")
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
