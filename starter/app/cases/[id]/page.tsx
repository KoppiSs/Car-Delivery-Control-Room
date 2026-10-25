import { redirect } from "next/navigation"

/** Keep the explicit Messages action compatible with the existing order view. */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/orders/${encodeURIComponent(id)}`)
}
