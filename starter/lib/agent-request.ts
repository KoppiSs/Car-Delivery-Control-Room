import { isAgentProposal, type AgentProposal } from "./agent"

/** Bound the entire request, including a response body that never finishes. */
export async function fetchAgentProposal(payload: unknown, {
  signal, timeoutMs = 195_000, fetchImpl = fetch,
}: { signal: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<AgentProposal> {
  const controller = new AbortController()
  const requestSignal = AbortSignal.any([signal, controller.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Proposal review was cancelled."))
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      reject(new Error("The proposal took too long. Please retry the investigation."))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: requestSignal, body: JSON.stringify(payload),
      })
      let data: unknown
      try { data = await response.json() } catch { throw new Error("The proposal couldn't be loaded. Please retry.") }
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "The proposal couldn't be prepared. Please retry."
        throw new Error(message)
      }
      if (!isAgentProposal(data)) throw new Error("The agent returned an invalid proposal. Please retry.")
      return data
    })()])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
