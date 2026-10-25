"use client"

import { useCallback, useEffect, useState } from "react"
import type { ControlTable } from "@/lib/present/control-table"
import { fmtDateTime } from "@/lib/present/time"
import { AppFrame } from "./components/app-frame"
import { Icon } from "./components/icons"
import { OrderDrawer } from "./components/order-drawer"
import { ControlTableView, DemoControls } from "./components/control-table"

export default function Home() {
  const [search, setSearch] = useState("")
  const [overview, setOverview] = useState<ControlTable | null>(null)
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

  // The table comes whole from stored records; search filters it here.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError("")
    fetch("/api/control-table", { signal: controller.signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("Your orders couldn't be loaded."); return response.json() as Promise<ControlTable> })
      .then((data) => { setOverview(data); setLoading(false) })
      .catch(() => { if (!controller.signal.aborted) { setError("Your orders couldn't be loaded. Please try again."); setLoading(false) } })
    return () => controller.abort()
  }, [refresh])
  const total = overview ? overview.sections.review.length + overview.sections.pending.length + overview.sections.manual.length : 0

  return <AppFrame section="board" snapshotAt={overview?.snapshotAt}>
    <main className="control-room control-room-columns">
      <header className="control-header">
        <p className="control-eyebrow">BAHN / OPERATIONS</p>
        <h1>A little attention.<br />A clear way forward.</h1>
        <p className="control-intro">The deliveries that need your judgment. Everything else stays out of your way.</p>
      </header>
      <section className="control-queue" aria-labelledby="queue-heading" aria-busy={loading}>
        <div className="control-toolbar">
          <div><h2 id="queue-heading">Control table {overview && <span className="control-count">{total}</span>}</h2>
            <p>Most urgent first within each section</p></div>
          <label className="search control-search">
            <Icon name="search" size={17} />
            <span className="sr-only">Search orders needing attention</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an order…" />
            {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
          </label>
        </div>
        <div role="status" className="sr-only">{loading ? "Loading orders" : error || `${total} orders in the control table`}</div>
        {error ? <div className="control-empty" role="alert"><h3>Let’s try that again</h3><p>{error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Try again</button></div>
          : loading && !overview ? <div className="control-loading" aria-label="Loading orders">{[0, 1, 2].map((index) => <div className="control-placeholder" key={index} />)}</div>
          : overview ? <ControlTableView table={overview} search={search} onOpen={setSelectedOrder} />
          : null}
        <footer className="control-note">{overview?.snapshotAt ? `Snapshot ${fmtDateTime(overview.snapshotAt)} · ` : ""}Fictional operations snapshot</footer>
        <DemoControls now={overview?.now ?? null} onChanged={() => setRefresh((value) => value + 1)} />
      </section>
    </main>
    {selectedOrder && <OrderDrawer key={selectedOrder.id} order={selectedOrder} onDismiss={closeOrder} />}
  </AppFrame>
}
