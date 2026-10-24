"use client"

import { useCallback, useEffect, useState } from "react"
import type { Overview } from "@/lib/present/types"
import { fmtDateTime } from "@/lib/present/time"
import { AppFrame } from "./components/app-frame"
import { Icon } from "./components/icons"
import { OrderDrawer } from "./components/order-drawer"
import { ControlOrderCard } from "./components/control-order-card"
import { REVIEW_COLUMNS, reviewType } from "@/lib/present/review"

export default function Home() {
  const [search, setSearch] = useState("")
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [selectedOrder, setSelectedOrder] = useState<{ id: string; reference: string } | null>(null)
  const closeOrder = useCallback(() => setSelectedOrder(null), [])
  useEffect(() => {
    const refreshOrders = () => setRefresh((value) => value + 1)
    window.addEventListener("orders-updated", refreshOrders)
    return () => window.removeEventListener("orders-updated", refreshOrders)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setError("")
      fetch(`/api/overview?q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error("Your orders couldn't be loaded."); return response.json() as Promise<Overview> })
        .then((data) => { setOverview(data); setLoading(false) })
        .catch(() => { if (!controller.signal.aborted) { setError("Your orders couldn't be loaded. Please try again."); setLoading(false) } })
    }, search ? 180 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search, refresh])

  return <AppFrame section="board" snapshotAt={overview?.snapshotAt}>
    <main className="control-room control-room-columns">
      <header className="control-header">
        <p className="control-eyebrow">BAHN / OPERATIONS</p>
        <h1>A little attention.<br />A clear way forward.</h1>
        <p className="control-intro">The deliveries that need your judgment. Everything else stays out of your way.</p>
      </header>
      <section className="control-queue" aria-labelledby="queue-heading" aria-busy={loading}>
        <div className="control-toolbar">
          <div><h2 id="queue-heading">Needs your attention {overview && <span className="control-count">{overview.total}</span>}</h2>
            <p>Active risks, evidence checks and owned follow-ups</p></div>
          <label className="search control-search">
            <Icon name="search" size={17} />
            <span className="sr-only">Search orders needing attention</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an order…" />
            {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
          </label>
        </div>
        <div role="status" className="sr-only">{loading ? "Loading orders" : error || `${overview?.visible.length ?? 0} orders shown`}</div>
        {error ? <div className="control-empty" role="alert"><h3>Let’s try that again</h3><p>{error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Try again</button></div>
          : loading && !overview ? <div className="control-loading" aria-label="Loading orders">{[0, 1, 2].map((index) => <div className="control-placeholder" key={index} />)}</div>
          : overview?.visible.length ? <div className="review-columns">{REVIEW_COLUMNS.map((column) => {
            const cards = overview.visible.filter((card) => reviewType(card) === column.id)
            return <section className={`review-column review-column-${column.id}`} key={column.id} aria-labelledby={`review-${column.id}`}>
              <header className="review-column-head"><h3 id={`review-${column.id}`}>{column.title}<span className="control-count">{cards.length}</span></h3><p>{column.description}</p></header>
              {cards.length ? <ul className="control-list">{cards.map((card) => <li key={card.id}><ControlOrderCard card={card} onOpen={setSelectedOrder} /></li>)}</ul>
                : <p className="review-column-empty">No orders in this review group.</p>}
            </section>
          })}</div>
          : <div className="control-empty"><span className="control-empty-icon"><Icon name={search ? "search" : "check"} size={24} /></span><h3>{search ? "No matching orders" : "Nothing needs your attention"}</h3><p>{search ? "Try a reference, car, customer or city. Search covers orders needing attention." : "There are no active risks or outstanding checks in this snapshot."}</p>{search && <button type="button" onClick={() => setSearch("")}>Clear search</button>}</div>}
        <footer className="control-note">{overview?.snapshotAt ? `As of ${fmtDateTime(overview.snapshotAt)} · ` : ""}Fictional operations snapshot</footer>
      </section>
    </main>
    {selectedOrder && <OrderDrawer key={selectedOrder.id} order={selectedOrder} onDismiss={closeOrder} />}
  </AppFrame>
}
