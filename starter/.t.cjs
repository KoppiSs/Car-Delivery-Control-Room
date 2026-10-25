const fs = require("fs")
const p = "tests/e2e/control-room.spec.ts"
let s = fs.readFileSync(p, "utf8")
const rep = (a, b) => { if (!s.includes(a)) throw new Error("miss " + a.slice(0, 70)); s = s.replace(a, b) }
rep(String.raw`strip.getByText(/Closed by the agent\. Checked:`, String.raw`strip.getByText(/Warning cleared: nothing wrong\. Checked:`)
rep("// ETA exactly at the promise end: never closed by the agent", "// ETA exactly at the promise end: never cleared by the agent")
rep(`  await page.goto("/deliveries")
  await expect(page.getByText(/Checked \d\d:\d\d: .*“Location sharing was switched off.*latest app ETA .* inside the delivery promise.* · Agent's verdict: fine · Sources: Driver/)).toBeVisible()
})`, `  // Clearing the warning never changes the delivery status: the car is still on its way.
  const [order] = await sql\`select status from orders where id = 'ord-00806'\`
  expect(order.status).toBe(snapshots.get("ord-00806")!.order.status)
  // Still in All deliveries, with the latest outcome on its row.
  await page.goto("/deliveries")
  await expect(page.locator(".delivery-list li", { hasText: "CD-420806" }).getByText(/Agent checked \d\d:\d\d: nothing wrong · Sources: Driver/)).toBeVisible()
})`)
rep(`test("Closed by the agent today: the reply shows its source; Reopen moves CD-420806 to Needs a review", async ({ page }) => {
  test.skip(!scanRan, "Builds on the scan case, which needs a fresh seed")
  await page.goto("/")
  const closed = page.locator("details", { hasText: /Closed by the agent today \(\d+\)/ })
  await closed.locator("summary").click()
  const row = closed.locator("li", { hasText: "CD-420806" })`, `test("Checked by the agent today: nothing wrong — 'Warning cleared', the reply shows its source; Reopen moves CD-420806 to Needs a review", async ({ page }) => {
  test.skip(!scanRan, "Builds on the scan case, which needs a fresh seed")
  await page.goto("/")
  const closed = page.locator("details", { hasText: /Checked by the agent today: nothing wrong \(\d+\)/ })
  await closed.locator("summary").click()
  const row = closed.locator("li", { hasText: "CD-420806" })
  await expect(row.getByText(/Warning cleared \d\d:\d\d/)).toBeVisible()`)
rep(`"Reopened by operator after the agent had closed it"`, `"Reopened by operator after the agent had cleared the warning"`)
rep(`  expect({ command: event.command, actor: event.actor }).toEqual({ command: "agent.scan_reopened", actor: "operator" })
})`, `  expect({ command: event.command, actor: event.actor }).toEqual({ command: "agent.scan_reopened", actor: "operator" })
})

// CD-421013 has no alert: triage flags it (no positions since pickup) and the scan may have escalated it.
// "Problem solved" covers that finding too, so it leaves the table and the strip for good.
test("CD-421013 Problem solved (no alert, flagged by triage) → gone from the table and the strip, still in All deliveries with the note", async ({ page }) => {
  const note = "Driver phoned in: app was off, car on schedule"
  await page.goto("/orders/ord-01013")
  const takeOver = page.getByRole("button", { name: "Take Over" })
  await expect(takeOver.or(page.getByRole("button", { name: "End manual control" })).first()).toBeVisible()
  if (await takeOver.count()) await takeOver.click()
  await page.locator("#manual-end-note").fill(note)
  await page.getByLabel("Problem solved, close it").check()
  await page.getByRole("button", { name: "End manual control" }).click()
  await expect(page.getByText("Closed by an operator.")).toBeVisible()
  await expectInBox(page, "CD-421013", "none")
  await expect(page.locator('section[aria-labelledby="scan-strip-title"]').getByText("CD-421013", { exact: true })).toHaveCount(0)
  await page.goto("/deliveries")
  await expect(page.locator(".delivery-list li", { hasText: "CD-421013" }).getByText(\`Closed by operator\`, { exact: false })).toContainText(note)
})`)
fs.writeFileSync(p, s)
