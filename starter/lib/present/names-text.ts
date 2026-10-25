// Pure helpers for showing names instead of record ids. Safe to use in the browser.

export const ID_PATTERN = /\b(?:drv|cus|site|veh|ord)-[0-9a-z]+\b/gi

/** Replace known ids in a text with their names; unknown ids stay as they are. */
export function withNames(text: string, names: Record<string, string>): string {
  return text.replace(ID_PATTERN, (id) => names[id] ?? id)
}

/** The ids a text mentions, for a details toggle. */
export function idsIn(text: string): string[] {
  return [...new Set(text.match(ID_PATTERN) ?? [])]
}

export type FollowUpRecipient = "customer" | "pickup_site" | "delivery_site" | "driver" | "nobody"

export const FOLLOW_UP_RECIPIENT_LABELS: Record<FollowUpRecipient, string> = {
  customer: "Customer", pickup_site: "Pickup site", delivery_site: "Delivery site", driver: "Driver", nobody: "Nobody (no reply needed)",
}

