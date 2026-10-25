import postgres from "postgres"
import { expect, test } from "./messages-fixtures"

test("opening a mixed thread clears unread instantly and persists only that order", async ({ page, messageOrders }) => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 })
  try {
    const before = await sql`select id,is_read from messages where order_id=${messageOrders.first} order by id`
    expect(before.some((message) => message.is_read)).toBeTruthy()
    expect(before.some((message) => !message.is_read)).toBeTruthy()
    await page.goto("/inbox?view=all")
    const first = page.locator(`[data-order-id="${messageOrders.first}"]`)
    const second = page.locator(`[data-order-id="${messageOrders.second}"]`)
    await expect(first.locator('.message-unread-dot')).toHaveCount(1)
    await expect(second.locator('.message-unread-dot')).toHaveCount(1)

    let release!: () => void
    let markStarted!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    await page.route('**/inbox?view=all', async (route) => {
      if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
        markStarted()
        await paused
      }
      await route.continue()
    })
    const saved = page.waitForResponse((response) => response.request().method() === 'POST' && !!response.request().headers()['next-action'])
    await first.locator('button.message-thread').click()
    await started
    await expect(first.locator('.message-unread-dot')).toHaveCount(0)
    await expect(first.locator('.message-thread-expanded')).toBeVisible()
    expect(page.url()).toContain('/inbox?view=all')
    const [stillUnread] = await sql`select is_read from messages where id=${messageOrders.firstMessageIds[1]}`
    expect(stillUnread.is_read).toBe(false)
    release()
    expect((await saved).ok()).toBeTruthy()
    await expect.poll(async () => (await sql`select count(*)::int as count from messages where order_id=${messageOrders.first} and not is_read`)[0].count).toBe(0)
    const [other] = await sql`select is_read from messages where id=${messageOrders.secondMessageId}`
    expect(other.is_read).toBe(false)
    await page.reload()
    await expect(first.locator('.message-unread-dot')).toHaveCount(0)
    await expect(second.locator('.message-unread-dot')).toHaveCount(1)
  } finally { await sql.end() }
})

test("a failed save restores unread and offers a working retry", async ({ page, messageOrders }) => {
  await page.goto('/inbox?view=all')
  const row = page.locator(`[data-order-id="${messageOrders.first}"]`)
  await page.route('**/inbox?view=all', async (route) => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) await route.abort('failed')
    else await route.continue()
  })
  await row.locator('button.message-thread').click()
  await expect(row.getByRole('alert')).toContainText("Read status couldn't be saved")
  await expect(row.locator('.message-unread-dot')).toHaveCount(1)
  await page.unroute('**/inbox?view=all')
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && !!response.request().headers()['next-action'])
  await row.getByRole('button', { name: 'Try again' }).click()
  expect((await saved).ok()).toBeTruthy()
  await expect(row.locator('.message-unread-dot')).toHaveCount(0)
  await expect(row.getByRole('alert')).toHaveCount(0)
  await page.reload()
  await expect(row.locator('.message-unread-dot')).toHaveCount(0)
})
