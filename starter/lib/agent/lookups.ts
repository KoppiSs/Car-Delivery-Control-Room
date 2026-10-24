import { loadOrder } from "../present/load"
import { readAppPositions, readDriverActivity, readOrderContext, readTravel } from "../triage-read"

async function orderBundle(orderId: string) {
  const loaded = await loadOrder(orderId)
  if (!loaded) throw new Error(`Order not found: ${orderId}`)
  return loaded.bundle
}

/** Direct observations for the current assignment, with their source times. */
export async function get_tracking(orderId: string) {
  return readAppPositions(await orderBundle(orderId))
}

/** Quotes, reservations and gate evidence remain distinct. */
export async function get_travel(orderId: string) {
  return readTravel(await orderBundle(orderId))
}

export async function get_driver_activity(orderId: string) {
  return readDriverActivity(await orderBundle(orderId))
}

export async function get_order_context(orderId: string) {
  return readOrderContext(await orderBundle(orderId))
}
