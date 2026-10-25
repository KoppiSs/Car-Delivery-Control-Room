"use client"

import { useCallback, useEffect, useState } from "react"
import { DeliveryRow, useExpandedRows } from "../components/delivery-row"
import type { DeliveriesOverview } from "@/lib/present/types"
import { fmtDateTime } from "@/lib/present/time"
import { groupDeliveries } from "@/lib/present/deliveries"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"
import { OrderDrawer } from "../components/order-drawer"

export default function AllDeliveries() {
  const [search, setSearch] = useState("")
  const [overview, setOverview] = useState<DeliveriesOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [selectedOrder, setSelectedOrder] = useState<{ id: string; reference: string } | null>(null)
  const closeOrder = useCallback(() => setSelectedOrder(null), [])
  const { expanded, toggle, setAll } = useExpandedRows()

  useEffect(() => {
    const refreshOrders = () => setRefresh((value) => value + 1)
    window.addEventListener("orders-updated", refreshOrders)
    return () => window.removeEventListener("orders-updated", refreshOrders)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true); setError("")
      fetch(`/api/deliveries?q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error("Deliveries couldn't be loaded. Please try again."); return response.json() as Promise<DeliveriesOverview> })
        .then((data) => { if (!controller.signal.aborted) { setOverview(data); setLoading(false) } })
        .catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Deliveries couldn't be loaded."); setLoading(false) } })
    }, search ? 180 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search, refresh])

  return <AppFrame section="deliveries" snapshotAt={overview?.snapshotAt}>
    <main className="control-room deliveries-page">
      <header className="control-header">
        <p className="control-eyebrow">BAHN / OPERATIONS</p>
        <h1>All Deliveries</h1>
        <p className="control-intro">Every journey, in one place. Browse delivery details and their recorded history.</p>
      </header>
      <section aria-labelledby="deliveries-heading" aria-busy={loading}>
        <div className="control-toolbar">
          <div><h2 id="deliveries-heading">Delivery register {overview && <span className="control-count">{overview.total}</span>}</h2><p>Grouped by state · Most recently updated within each group</p>
            {overview && overview.visible.length > 0 && <div style={{ display: "flex", gap: 14 }}>
              <button type="button" className="show-more" onClick={() => setAll(overview.visible.map((card) => card.id), true)}>Expand all</button>
              <button type="button" className="show-more" onClick={() => setAll(overview.visible.map((card) => card.id), false)}>Collapse all</button>
            </div>}</div>
          <label className="search control-search"><Icon name="search" size={17} /><span className="sr-only">Search all deliveries</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a delivery…" />
            {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
          </label>
        </div>
        <div role="status" className="sr-only">{loading ? "Loading deliveries" : error || `${overview?.visible.length ?? 0} deliveries shown`}</div>
        {error ? <div className="control-empty" role="alert"><h3>Unable to load deliveries</h3><p>{error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Try again</button></div>
          : loading && !overview ? <div className="control-loading">{[0, 1, 2].map((index) => <div className="control-placeholder" key={index} />)}</div>
          : overview?.visible.length ? <div className="delivery-groups">{groupDeliveries(overview.visible).map((group) => <section className="delivery-group" key={group.state} aria-labelledby={`delivery-state-${group.state}`}>
            <header className="delivery-group-heading"><h3 id={`delivery-state-${group.state}`}>{group.title}<span className="control-count">{group.orders.length}</span></h3><span className="delivery-group-rule" /></header>
            <ul className="delivery-list">{group.orders.map((card) => <li key={card.id}>
              <DeliveryRow card={card} checks={overview.checks?.[card.id]} checkedAt={overview.checkedAt ?? overview.snapshotAt}
                expanded={expanded.has(card.id)} onToggle={() => toggle(card.id)} onOpen={() => setSelectedOrder({ id: card.id, reference: card.reference })} />
            </li>)}</ul></section>)}</div>
          : <div className="control-empty"><h3>{search ? "No matching deliveries" : "No deliveries yet"}</h3><p>{search ? "Try a reference, car, customer, city or status." : "Deliveries will appear here when they are recorded."}</p>{search && <button type="button" onClick={() => setSearch("")}>Clear search</button>}</div>}
        <footer className="control-note">{overview?.snapshotAt ? `As of ${fmtDateTime(overview.snapshotAt)} · ` : ""}Delivery details are read only in this view</footer>
      </section>
    </main>
    {selectedOrder && <OrderDrawer key={selectedOrder.id} order={selectedOrder} onDismiss={closeOrder} readOnly />}
  </AppFrame>
}
