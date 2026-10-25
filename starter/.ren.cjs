const fs = require("fs")
const edit = (p, pairs) => { let s = fs.readFileSync(p, "utf8"); for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(p + " miss " + a); s = s.split(a).join(b) } fs.writeFileSync(p, s) }
edit("app/components/control-table.tsx", [
  ["/** What the agent closed on its own today, collapsed, so a person can see why and reopen it. */", "/** Possible problems the agent checked today and found nothing wrong (warning cleared), collapsed, so a person can see why and reopen it. The orders themselves stay open. */"],
  ["<summary>Closed by the agent today ({rows.length})</summary>", "<summary>Checked by the agent today: nothing wrong ({rows.length})</summary>"],
  ["<span className={styles.muted}> · closed <time", "<span className={styles.muted}> · Warning cleared <time"],
  ["Nothing closed by the agent today.", "Nothing checked by the agent today."],
  ["`Closed by the agent. Checked: ${result.checked}.", "`Warning cleared: nothing wrong. Checked: ${result.checked}."],
])
edit("lib/present/control-table.ts", [
  ["/** An order the agent closed after a scan: listed so a person can see what was checked and reopen it. */", "/** An order whose warning the agent cleared after a scan (nothing wrong): listed so a person can see what was checked and reopen it. */"],
  ["\"Reopened by operator after the agent had closed it\"", "\"Reopened by operator after the agent had cleared the warning\""],
  ["/** Orders the agent closed today (business date), newest first. */", "/** Orders whose warning the agent cleared today (business date), newest first. */"],
])
edit("app/api/orders/[id]/scan/reopen/route.ts", [["/** Reopens an order the agent closed after a scan; it goes to Needs a review. */", "/** Reopens an order whose warning the agent cleared after a scan; it goes to Needs a review. */"]])
edit("lib/scan.ts", [
  ["/** A person reopens an order the agent closed: it goes to Needs a review, tagged \"Reopened by operator\". */", "/** A person reopens an order whose warning the agent cleared: it goes to Needs a review, tagged \"Reopened by operator\". */"],
  ["\"Only an order the agent closed can be reopened.\"", "\"Only an order whose warning the agent cleared can be reopened.\""],
])
edit("tests/e2e/control-room.spec.ts", [
  ["strip.getByText(/Closed by the agent\. Checked:", "strip.getByText(/Warning cleared: nothing wrong\. Checked:"],
  ["// ETA exactly at the promise end: never closed by the agent", "// ETA exactly at the promise end: never cleared by the agent"],
  ["test(\"Closed by the agent today: the reply", "test(\"Checked by the agent today: the reply"],
  ["{ hasText: /Closed by the agent today \(\d+\)/ }", "{ hasText: /Checked by the agent today: nothing wrong \(\d+\)/ }"],
  ["\"Reopened by operator after the agent had closed it\"", "\"Reopened by operator after the agent had cleared the warning\""],
])
