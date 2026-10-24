"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { OrderPane, type Detail } from "./order-detail"

export function OrderDrawer({ order, onDismiss, readOnly = false }: {
  order: { id: string; reference: string }
  onDismiss: () => void
  readOnly?: boolean
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)


  useEffect(() => {
    const dialog = dialogRef.current!
    const previousOverflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = "hidden"
    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/orders/${encodeURIComponent(order.id)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "This order could not be found." : "This order couldn't be loaded. Please try again.")
        return response.json() as Promise<Detail>
      })
      .then((data) => { if (!controller.signal.aborted) setDetail(data) })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "This order couldn't be loaded.")
      })
    return () => controller.abort()
  }, [order.id, attempt])


  return <dialog ref={dialogRef} className="order-drawer" aria-labelledby="order-drawer-title"
    onCancel={(event) => { event.preventDefault(); onDismiss() }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onDismiss()
    }}>
    <header className="order-drawer-header">
      <div><p>{readOnly ? "Delivery details · Read only" : "Order review"}</p><h2 id="order-drawer-title">{order.reference}</h2></div>
      <div className="order-drawer-actions">
        {!readOnly && <Link href={`/orders/${order.id}`} className="order-drawer-full">Open full page</Link>}
        <button type="button" className="order-drawer-close" onClick={onDismiss} aria-label="Close order review" autoFocus>×</button>
      </div>
    </header>
    <div className="order-drawer-content" aria-busy={!detail && !error}>
      {error ? <div className="control-empty" role="alert"><h3>Unable to open order</h3><p>{error}</p>
        <button type="button" onClick={() => { setError(""); setAttempt((value) => value + 1) }}>Try again</button>
      </div> : detail ? <OrderPane detail={detail} readOnly={readOnly} /> : <div className="order-drawer-loading" role="status"><div className="control-placeholder" /><p>Loading order…</p></div>}
    </div>
  </dialog>
}
