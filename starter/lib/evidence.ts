// The events handed to the proposal model. Simulated replies, scans and other demo records
// are kept as facts ("the driver replied"), but never with anyone's words in them: a quoted
// reply in the evidence is what made the model write in the driver's voice. Pure; used by
// the browser and the server.

/** Events written by the demo flows whose details can carry someone's words. */
const SPEECH_EVENTS = /^(?:customer_email\.|agent\.follow_up_|agent\.scan_|control_room\.)/
const SPEECH_KEYS = new Set(["body", "text", "note", "reply", "checked", "agent_thinks", "reason", "sources", "correction", "question"])

export function evidenceEvents<T extends { command?: unknown; details?: unknown }>(events: T[]): T[] {
  return events.map((event) => {
    if (typeof event.command !== "string" || !SPEECH_EVENTS.test(event.command)) return event
    const details = (event.details ?? {}) as Record<string, unknown>
    const changes = (details.changes ?? {}) as Record<string, unknown>
    const kept = Object.fromEntries(Object.entries(changes).filter(([key]) => !SPEECH_KEYS.has(key)))
    return { ...event, details: { ...details, changes: kept } }
  })
}
