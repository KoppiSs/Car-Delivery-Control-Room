import { NextResponse } from "next/server"
import { controlTable } from "@/lib/present/control-table"

export const runtime = "nodejs"

/** The control table: Needs a decision, Handled by a person, Waiting for a reply. Read from stored records only. */
export async function GET() {
  return NextResponse.json(await controlTable(), { headers: { "Cache-Control": "no-store" } })
}
