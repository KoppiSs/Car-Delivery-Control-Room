// End-to-end check that every way of asking someone puts the order in "Pending":
// approving the agent's plan, approving "Your version", and sending an email.
// Runs against the running app (APP_URL, default http://localhost:3000) and the database
// (DATABASE_URL). It writes a fixture proposal, runs each path, and then removes every row
// it created and restores the order columns it changed, so the demo data stays as it was.
import "dotenv/config"
import assert from "node:assert/strict"
import postgres from "postgres"

const base = process.env.APP_URL ?? "http://localhost:3000"
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running this test.")
const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function call(path, body) {
  const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const FIXTURE = {
  investigation_summary: [{ text: "Test: the driver has not confirmed the pickup time.", source_event_ids: [] }],
  proposed_action: "Ask the driver to confirm the pickup time.",
  decision_button_text: "Approve follow-up",
  executable_tool_call: { action_type: "driver.confirm_time", payload: { description: "Ask the driver to confirm the pickup time." } },
  waiting_on_description: "Driver confirms the pickup time",
}
const TABLES = [["messages", "id"], ["conversations", "id"], ["agent_mock_actions", "id"], ["agent_proposal_feedback", "id"], ["operational_events", "id"]]

/** Remember the order's rows and columns, run the check, then put everything back. */
async function isolated(orderId, check) {
  const before = {}
  for (const [table] of TABLES) before[table] = new Set((await sql`select id from ${sql(table)} where order_id = ${orderId}`).map((row) => row.id))
  const mockStatuses = await sql`select id, status from agent_mock_actions where order_id = ${orderId}`
  const [order] = await sql`select status, agent_mode, agent_decision, agent_decision_at, agent_revision, agent_proposal, waiting_on_description, updated_at
    from orders where id = ${orderId}`
  assert.ok(order, `${orderId} exists`)
  try {
    await check(order)
  } finally {
    for (const [table] of TABLES) {
      const ids = (await sql`select id from ${sql(table)} where order_id = ${orderId}`).map((row) => row.id).filter((id) => !before[table].has(id))
      if (ids.length) await sql`delete from ${sql(table)} where id in ${sql(ids)}`
    }
    for (const mock of mockStatuses) await sql`update agent_mock_actions set status = ${mock.status} where id = ${mock.id}`
    await sql`update orders set status = ${order.status}, agent_mode = ${order.agent_mode}, agent_decision = ${order.agent_decision},
      agent_decision_at = ${order.agent_decision_at}, agent_revision = ${order.agent_revision}, agent_proposal = ${order.agent_proposal ? sql.json(order.agent_proposal) : null},
      waiting_on_description = ${order.waiting_on_description}, updated_at = ${order.updated_at} where id = ${orderId}`
  }
}

/** Give the order a pending agent proposal to approve, without running the model. */
async function withProposal(orderId, order) {
  assert.notEqual(order.status, "follow_up", `${orderId} is already waiting; run npm run db:seed first`)
  assert.equal(order.agent_mode, "AGENT", `${orderId} is under manual control; run npm run db:seed first`)
  await sql`update orders set agent_proposal = ${sql.json(FIXTURE)}, agent_decision = 'PENDING' where id = ${orderId}`
}

async function pendingRow(orderId) {
  const table = await call("/api/control-table")
  assert.equal(table.status, 200, "control table loads")
  const box = ["review", "pending", "manual"].find((name) => table.body.sections[name].some((row) => row.id === orderId))
  return { box, row: table.body.sections.pending.find((row) => row.id === orderId) }
}

const results = []
async function test(name, fn) {
  try { await fn(); results.push(`ok    ${name}`) } catch (error) { results.push(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1 }
}

try {
  await test("Approve (agent's plan) without a recipient is refused", () => isolated("ord-00399", async (order) => {
    await withProposal("ord-00399", order)
    const response = await call("/api/orders/ord-00399/approve", { proposal: FIXTURE })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /Who do we ask/)
  }))

  await test("Approve (agent's plan) asking the driver → Pending, waiting for the driver by name", () => isolated("ord-00399", async (order) => {
    await withProposal("ord-00399", order)
    const detail = (await call("/api/orders/ord-00399")).body
    const driver = detail.parties.driver?.name
    assert.ok(driver, "the order has a driver on file")
    const response = await call("/api/orders/ord-00399/approve", { proposal: FIXTURE, recipient: "driver" })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const { box, row } = await pendingRow("ord-00399")
    assert.equal(box, "pending")
    assert.equal(row.waiting.who, driver)
    const [mock] = await sql`select payload, status from agent_mock_actions where order_id = 'ord-00399' order by created_at desc limit 1`
    assert.equal(mock.status, "WAITING")
    assert.equal(mock.payload.recipient_type, "driver")
    assert.ok(mock.payload.recipient_id, "recipient id is stored")
  }))

  await test("Approve your version asking the customer → Pending; original and edit both stored", () => isolated("ord-00299", async (order) => {
    await withProposal("ord-00299", order)
    const detail = (await call("/api/orders/ord-00299")).body
    const response = await call("/api/orders/ord-00299/approve-edited", { original: FIXTURE,
      edited: { action: "Tell the customer about the later ferry and ask if Sunday works.", recipient: "customer", waitingOn: "Customer confirms Sunday arrival" } })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const { box, row } = await pendingRow("ord-00299")
    assert.equal(box, "pending")
    assert.equal(row.waiting.who, detail.parties.customer.name)
    const [feedback] = await sql`select decision, outcome, previous_proposal, replacement_proposal from agent_proposal_feedback
      where order_id = 'ord-00299' order by created_at desc limit 1`
    assert.equal(feedback.outcome, "APPROVED_EDITED")
    assert.equal(feedback.previous_proposal.proposed_action, FIXTURE.proposed_action)
    assert.match(feedback.replacement_proposal.proposed_action, /later ferry/)
  }))

  await test("Approve your version to nobody → not Pending", () => isolated("ord-00299", async (order) => {
    await withProposal("ord-00299", order)
    const response = await call("/api/orders/ord-00299/approve-edited", { original: FIXTURE,
      edited: { action: "Note the sold-out ferry; nothing to ask yet.", recipient: "nobody", waitingOn: "" } })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.notEqual((await pendingRow("ord-00299")).box, "pending")
  }))

  // The pickup slot must still be ahead, otherwise the request is overdue at once ("No reply yet").
  await test("Email that expects a reply → Pending, waiting for the customer", () => isolated("ord-00299", async () => {
    const draft = (await call("/api/orders/ord-00299/customer-email?template=pickup_change&recipient=customer")).body.draft
    assert.ok(draft, "draft loads")
    const fields = Object.fromEntries(Object.entries(draft.fields).map(([name, field]) => [name, field.value || "Friday 23 October, 08:00–09:00"]))
    const templates = { subject: draft.subject.replace(/\{newSlot\}/g, fields.newSlot), body: draft.body.replace(/\{newSlot\}/g, fields.newSlot) }
    const response = await call("/api/orders/ord-00299/customer-email", { templateId: "pickup_change", recipientType: "customer", ...templates,
      fields, draftBuiltAt: draft.draftBuiltAt, basis: draft.basis })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const { box, row } = await pendingRow("ord-00299")
    assert.equal(box, "pending")
    assert.equal(row.waiting.who, draft.recipient.name)
  }))

  /** Sends a customer email exactly as the card does: the draft's fields, empty ones filled in. */
  async function sendEmail(orderId, templateId, fill) {
    const draft = (await call(`/api/orders/${orderId}/customer-email?template=${templateId}&recipient=customer`)).body.draft
    assert.ok(draft, `${templateId} draft loads`)
    const fields = Object.fromEntries(Object.entries(draft.fields).map(([name, field]) => [name, field.value || fill[name] || ""]))
    const render = (text) => text.replace(/\{(\w+)\}/g, (placeholder, name) => fields[name] || "").replace(/ +\n/g, "\n").replace(/ {2,}/g, " ")
    const response = await call(`/api/orders/${orderId}/customer-email`, { templateId, recipientType: "customer",
      subject: render(draft.subject), body: render(draft.body), fields, draftBuiltAt: draft.draftBuiltAt, basis: draft.basis })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body
  }

  await test("delay_notice (possible delay, expects no reply) → NOT Pending; the card shows it as informed", () => isolated("ord-00299", async () => {
    const before = (await pendingRow("ord-00299")).box
    const sent = await sendEmail("ord-00299", "delay_notice", {})
    assert.equal(sent.expectsReply, false)
    assert.equal(sent.conversationStatus, "INFORMED")
    const { box } = await pendingRow("ord-00299")
    assert.notEqual(box, "pending")
    assert.equal(box, before, "the order stays in its box")
    const overview = (await call("/api/orders/ord-00299/customer-email")).body
    assert.equal(overview.cases[0].stage, "informed")
  }))

  await test("delay_notice, then the customer writes back anyway → Needs a review with New reply", () => isolated("ord-00299", async () => {
    await sendEmail("ord-00299", "delay_notice", {})
    const reply = await call("/api/orders/ord-00299/customer-email/reply", { recipient: "customer", answer: "other", text: "Thanks. Can someone call me about it?" })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    const row = (await call("/api/control-table")).body.sections.review.find((entry) => entry.id === "ord-00299")
    assert.equal(row?.flag?.kind, "new_reply")
  }))

  await test("delivery_delay (confirmed delay, asks for agreement) → Pending, waiting for the customer", () => isolated("ord-00299", async () => {
    const sent = await sendEmail("ord-00299", "delivery_delay", { reason: "The planned ferry is sold out.", newDelivery: "Wednesday 28 October, 13:00–15:00" })
    assert.equal(sent.expectsReply, true)
    const { box, row } = await pendingRow("ord-00299")
    assert.equal(box, "pending")
    assert.equal(row.waiting.about, "new delivery time")
  }))

  await test("Cost decision on CD-420299: one option from the data, stored as the operator's pick, no email needed, not Pending", () => isolated("ord-00299", async () => {
    const overview = (await call("/api/orders/ord-00299/customer-email")).body
    const options = overview.costOptions
    assert.ok(options, "cost options are offered for the sold-out ferry")
    assert.equal(options.options.length, 1)
    assert.deepEqual(options.options[0].labels, ["only"], "a single option is 'Only option', not Reliable and Lower cost")
    assert.equal(options.onlyOne.note, "Only one option found in the data")
    assert.match(options.onlyOne.missing, /no quote on file/)
    assert.match(options.options[0].costText, /387\.00 · Quoted, not booked/)
    assert.equal(options.recommendation?.optionId, options.options[0].id, "key account: Reliable is recommended")
    assert.equal(overview.delayHint, null, "the promise still holds, so no customer delay email is suggested")
    const response = await call("/api/orders/ord-00299/cost-decision", { optionId: options.options[0].id, reason: "Only sailing, arrives before the promise" })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.suggestion, "none")
    const [event] = await sql`select details from operational_events where order_id = 'ord-00299' and command = 'operator.cost_option_chosen' order by recorded_at desc limit 1`
    assert.equal(event.details.changes.cost_cents, 38700)
    assert.equal(event.details.changes.booked, false)
    assert.equal(event.details.changes.reason, "Only sailing, arrives before the promise")
    assert.notEqual((await pendingRow("ord-00299")).box, "pending")
  }))

  await test("Driver positioning (CD-420399): internal options first, no site email until 'Move the pickup time' is picked", () => isolated("ord-00399", async () => {
    const overview = (await call("/api/orders/ord-00399/customer-email")).body
    // No site email up front. The only suggestion is the optional status update the 08:54 note asks for.
    assert.equal(overview.delayHint?.kind, "note")
    assert.equal(overview.delayHint.recipient, "customer")
    assert.equal(overview.delayHint.templateId, "status_update")
    assert.match(overview.delayHint.because, /internal note at 08:54 from Driver marketplace/)
    const draft = (await call("/api/orders/ord-00399/customer-email?template=status_update&recipient=customer")).body.draft
    assert.equal(draft.fields.update.value, "Collection timing is under review.")
    assert.equal(draft.fields.update.source, "messages.msg-xc5d698394bbc5a9c", "the note is cited as the source")
    assert.doesNotMatch(draft.body, /CD-420326|Hamburg|agreed/i, "no earlier trip, no agreed slot")
    const options = overview.costOptions
    const move0 = options.options.find((option) => option.kind === "move_pickup")
    assert.match(move0.what, /Thu 22 Oct 12:00 CEST \(pickup site time, Berlin\)/, "the driver's local 12:00, labelled, not UTC")
    assert.ok(options, "driver options are offered")
    assert.ok(options.notOnFile.some((line) => /Swap to another driver: no driver on file/.test(line)), "no invented replacement driver")
    assert.ok(options.notOnFile.some((line) => /Book driver travel: no quote on file/.test(line)))
    const move = options.options.find((option) => option.kind === "move_pickup")
    assert.ok(move, "Move the pickup time is offered")
    const response = await call("/api/orders/ord-00399/cost-decision", { optionId: move.id, reason: "No other driver; ask the site for a later handover" })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.suggestion, "site_pickup_time", "only now is the pickup site's new handover time suggested")
  }))

  // CD-420322's delivery promise is under 2 h away. Before the minimum-wait rule, approving bounced it
  // straight back to "Needs a review" as "No reply yet"; this is the case the browser hit.
  await test("Approve on an order whose deadline is already close (CD-420322) → still Pending", () => isolated("ord-00322", async (order) => {
    await sql`update orders set agent_mode = 'AGENT', status = 'IN_TRANSIT' where id = 'ord-00322'`
    await withProposal("ord-00322", { ...order, agent_mode: "AGENT", status: "IN_TRANSIT" })
    await sql`update agent_mock_actions set status = 'DONE' where order_id = 'ord-00322' and status = 'WAITING'`
    const response = await call("/api/orders/ord-00322/approve", { proposal: FIXTURE, recipient: "driver" })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const { box, row } = await pendingRow("ord-00322")
    assert.equal(box, "pending", "an order asked about moments ago is not 'No reply yet'")
    assert.ok(row.deadline && Date.parse(row.deadline.at) - Date.parse((await call("/api/control-table")).body.now) < 2 * 3_600_000, "its deadline really is close")
  }))

  await test("A written driver reply → Needs a review with New reply quoting it, stored as a driver_chat message", () => isolated("ord-00399", async (order) => {
    await withProposal("ord-00399", order)
    assert.equal((await call("/api/orders/ord-00399/approve", { proposal: FIXTURE, recipient: "driver" })).status, 200)
    const suggestion = await call("/api/orders/ord-00399/follow-up-reply")
    assert.equal(suggestion.status, 200, JSON.stringify(suggestion.body))
    assert.match(suggestion.body.text, /\(simulated\)/)
    const text = "I can be in Leipzig on Friday from 08:00. (simulated)"
    const reply = await call("/api/orders/ord-00399/follow-up-reply", { answer: "other", text })
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    const table = (await call("/api/control-table")).body
    const row = table.sections.review.find((entry) => entry.id === "ord-00399")
    assert.ok(row, "back in Needs a review")
    assert.equal(row.flag?.kind, "new_reply")
    assert.match(row.flag.text, /Leipzig on Friday/)
    const [message] = await sql`select m.author_type, c.channel from messages m join conversations c on c.id = m.conversation_id
      where m.order_id = 'ord-00399' and m.body = ${text}`
    assert.deepEqual({ ...message }, { author_type: "driver", channel: "driver_chat" })
  }))

  await test("Take Over → Manual control; End manual control → Needs a review, not Pending", () => isolated("ord-00399", async (order) => {
    await withProposal("ord-00399", order)
    assert.equal((await call("/api/orders/ord-00399/approve", { proposal: FIXTURE, recipient: "driver" })).status, 200)
    assert.equal((await pendingRow("ord-00399")).box, "pending")
    const takeover = await call("/api/agent/manual", { orderId: "ord-00399", operation: "takeover", note: "Operator took manual control.", nextStatus: "WAITING_FOR_PICKUP" })
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body))
    assert.equal((await pendingRow("ord-00399")).box, "manual")
    const end = await call("/api/agent/manual", { orderId: "ord-00399", operation: "end", note: "Called the driver; Friday pickup agreed.", nextStatus: "WAITING_FOR_PICKUP", ending: "handed_back" })
    assert.equal(end.status, 200, JSON.stringify(end.body))
    assert.equal((await pendingRow("ord-00399")).box, "review", "the old follow-up is closed by ending manual control")
    const [after] = await sql`select status from orders where id = 'ord-00399'`
    assert.equal(after.status, "WAITING_FOR_PICKUP")
  }))
} finally {
  await sql.end()
}
console.log(results.join("\n"))
