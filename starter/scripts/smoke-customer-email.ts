import "dotenv/config"
import { registerHooks } from "node:module"

// lib/db imports "server-only" for its side effect, and only Next.js resolves it.
// Outside Next, point it at a harmless built-in so lib/db loads.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "server-only" ? { url: "node:path", shortCircuit: true } : next(specifier, context),
})

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../lib/db")
  const { orders } = await import("../lib/schema")
  const { draftEmail } = await import("../lib/customer-email")
  const cases = [["CD-420399", "pickup_change"], ["CD-420299", "status_update"]] as const
  for (const [reference, templateId] of cases) {
    const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, reference)).limit(1)
    if (!order) throw new Error(`${reference} not found`)
    const draft = await draftEmail(order.id, templateId)
    if (!draft) throw new Error(`${reference} did not load`)
    console.log(`=== ${reference} · ${templateId} ===`)
    console.log("To:", `${draft.recipient.name} (${draft.recipient.type}), simulated only`)
    console.log("Reply to conversation:", draft.replyToConversationId ?? "none, a new customer_email thread")
    console.log("Fields:")
    for (const [name, field] of Object.entries(draft.fields)) {
      console.log(`  ${name.padEnd(12)} ${field.filledBy.padEnd(5)} ${JSON.stringify(field.value)}${field.source ? `  ← ${field.source} @ ${field.at}` : ""}`)
    }
    console.log("Missing:", draft.missing.join(", ") || "none")
    console.log(`Subject: ${draft.subject}\n\n${draft.body}\n`)
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
