import { label } from "./labels"
import type { BoardCard } from "./types"

const STATE_ORDER = ["NEW", "WAITING_FOR_PICKUP", "IN_TRANSIT", "BLOCKED", "FOLLOW_UP", "DELIVERED", "CANCELLED"]

/** Group by actual order status; display lanes can retain an earlier journey stage. */
export function groupDeliveries(cards: BoardCard[]) {
  const groups = new Map<string, BoardCard[]>()
  for (const card of cards) {
    const state = card.status.toUpperCase() || "UNKNOWN"
    const group = groups.get(state) ?? []
    group.push(card)
    groups.set(state, group)
  }
  const rank = (state: string) => STATE_ORDER.includes(state) ? STATE_ORDER.indexOf(state) : STATE_ORDER.length
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([state, orders]) => ({
    state, title: label(state), orders,
  }))
}
