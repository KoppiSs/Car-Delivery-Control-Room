// Names instead of record ids on screen. The agent's own text can contain ids
// such as "drv-319"; for display they become the driver's, customer's or site's
// name, the car's make and model, or the order reference. Stored text is never changed.

import { recipientsFor } from "../customer-email"
import type { RecipientType } from "../templates"
import { readCurrentAssignments } from "../triage-read"
import { str, type Bundle } from "./bundle"
import { ID_PATTERN, type FollowUpRecipient } from "./names-text"

export { withNames, type FollowUpRecipient } from "./names-text"

/** Readable name for every id the texts mention. Ids it cannot name are left out (and stay as they are). */
export function namesFor(bundle: Bundle, texts: (string | null | undefined)[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const text of texts) for (const id of text?.match(ID_PATTERN) ?? []) {
    if (id in names) continue
    const name = nameOf(bundle, id)
    if (name) names[id] = name
  }
  return names
}

function nameOf(bundle: Bundle, id: string): string | null {
  const prefix = id.split("-")[0].toLowerCase()
  if (prefix === "drv") return bundle.dir.driverName(id)
  if (prefix === "site") return bundle.dir.siteName(id) ?? bundle.sites.get(id)?.name ?? null
  if (prefix === "cus") return id === bundle.customer.id ? bundle.customer.name : bundle.dir.resolve(id, "customer").name
  if (prefix === "veh") {
    const vehicle = bundle.items.find((item) => item.vehicle.id === id)?.vehicle
    return vehicle ? `${vehicle.make} ${vehicle.model}` : null
  }
  if (prefix === "ord") return id === bundle.order.id ? bundle.order.reference : bundle.bundleOrderRefs[id] ?? null
  return null
}

export type Party = { type: FollowUpRecipient; name: string; id: string | null; actorType: string | null }

/** Everyone an approved action can ask something, by name. Null where the order has nobody on file. */
export function partiesFor(bundle: Bundle): Record<Exclude<FollowUpRecipient, "nobody">, Party | null> {
  const recipients = recipientsFor(bundle)
  const assignment = readCurrentAssignments(bundle)[0]
  const driverId = str(assignment?.details.driver_id)
  const asParty = (type: RecipientType): Party | null => {
    const recipient = recipients[type]
    return recipient ? { type, name: recipient.name, id: recipient.id, actorType: recipient.actorType } : null
  }
  return {
    customer: asParty("customer"),
    pickup_site: asParty("pickup_site"),
    delivery_site: asParty("delivery_site"),
    driver: driverId ? { type: "driver", name: bundle.dir.driverName(driverId) ?? "The driver", id: driverId, actorType: "driver" } : null,
  }
}

