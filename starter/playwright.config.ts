import { defineConfig } from "@playwright/test"

// Browser tests against the running app (npm run dev). They use the installed Chrome, so no
// browser download is needed, and run one at a time because they share one database.
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: { baseURL: process.env.APP_URL ?? "http://localhost:3000", channel: "chrome", headless: true },
})
