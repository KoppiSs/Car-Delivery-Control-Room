// One place that sends a generation request to the local model. Outside production, a test
// can queue stubbed answers in related_records (collection "demo_model_stub"), consumed one per
// call, so browser tests can run "the model returned X" or "the model failed" without a model.

import { asc, eq, isNull, and } from "drizzle-orm"
import { db } from "./db"
import { relatedRecords } from "./schema"

export const MODEL_STUB_COLLECTION = "demo_model_stub"

export type ModelResult = { ok: true; output: unknown } | { ok: false; reason: string }

/** The next queued stub; one with details.key only answers a call made with that key (e.g. an order reference). */
async function takeStub(key?: string): Promise<ModelResult | null> {
  if (process.env.NODE_ENV === "production") return null
  const stubs = await db.select().from(relatedRecords)
    .where(and(eq(relatedRecords.collection, MODEL_STUB_COLLECTION), isNull(relatedRecords.orderId))).orderBy(asc(relatedRecords.id))
  const stub = stubs.find((row) => { const k = (row.details as { key?: unknown }).key; return k === undefined || k === key })
  if (!stub) return null
  await db.delete(relatedRecords).where(and(eq(relatedRecords.collection, MODEL_STUB_COLLECTION), eq(relatedRecords.id, stub.id)))
  const d = stub.details as { response?: unknown; error?: unknown }
  return typeof d.error === "string" ? { ok: false, reason: d.error } : { ok: true, output: { response: typeof d.response === "string" ? d.response : JSON.stringify(d.response) } }
}

/** Sends one /api/generate request. Never throws: a failure comes back with a plain reason. */
export async function generateWithModel(request: Record<string, unknown>, timeoutMs = 120_000, stubKey?: string): Promise<ModelResult> {
  const stubbed = await takeStub(stubKey)
  if (stubbed) return stubbed
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, reason: `the local model answered with HTTP ${response.status}` }
    return { ok: true, output: await response.json() }
  } catch (error) {
    return { ok: false, reason: error instanceof DOMException && error.name === "TimeoutError"
      ? `the model took longer than ${Math.round(timeoutMs / 1000)} seconds` : "the local model could not be reached" }
  }
}
