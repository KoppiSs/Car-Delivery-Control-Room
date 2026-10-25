import { NextResponse } from "next/server"
import { advanceClock, currentTime } from "@/lib/clock"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json({ now: (await currentTime()).toISOString() })
}

/** Demo control: skip the shared business clock ahead. Recorded, so every viewer sees the same time. */
export async function POST(request: Request) {
  let minutes = 60
  try {
    const body: unknown = JSON.parse(await request.text())
    if (body && typeof body === "object" && "minutes" in body) minutes = Number((body as { minutes: unknown }).minutes)
  } catch { /* default: one hour */ }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    return NextResponse.json({ error: "Skip ahead by 1 to 1440 minutes." }, { status: 400 })
  }
  return NextResponse.json({ now: (await advanceClock(minutes)).toISOString() })
}
