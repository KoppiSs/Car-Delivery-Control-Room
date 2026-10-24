const LOOKUP_TOOLS = [
  { name: "get_tracking", description: "Read this order's current-assignment driver-app observations, with observed/received times, coarse progress and reported ETA. Signals are not verified locations." },
  { name: "get_travel", description: "Read this order's travel quotes, reservations and gate events. A quote is not a booking; a booking is not proof of boarding." },
  { name: "get_driver_activity", description: "Read this order's current-driver pickup, delivery and expense-submission events. An expense submission is not approval or payment." },
  { name: "get_order_context", description: "Read this order's details, customer, current assignments, selected delivery promise and recorded movement context." },
] as const

export const AGENT_TOOLS = [
  ...LOOKUP_TOOLS.map(({ name, description }) => ({
    type: "function" as const,
    function: {
      name, description, strict: true,
      parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false },
    },
  })),
  {
    type: "function",
    function: {
      name: "message_driver",
      description: "Ask the fictional driver a question and receive a simulated reply. No real SMS is sent.",
      strict: true,
      parameters: {
        type: "object",
        properties: { question: { type: "string", minLength: 1 } },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_case",
      description: "Record a mocked case closure with its reason and supporting facts.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", minLength: 1 },
          facts: { type: "string", minLength: 1 },
        },
        required: ["reason", "facts"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hand_to_person",
      description: "Mock a handoff to an operator with the facts, a suggestion and available options.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          headline: { type: "string", minLength: 1 },
          facts: { type: "string", minLength: 1 },
          suggestion: { type: "string", minLength: 1 },
          options: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["headline", "facts", "suggestion", "options"],
        additionalProperties: false,
      },
    },
  },
] as const

export async function runTool(toolName: string, args: any, orderId: string): Promise<unknown> {
  const lookup = LOOKUP_TOOLS.find((tool) => tool.name === toolName)
  if (lookup) {
    const readers = await import("./lookups.ts")
    return await readers[lookup.name](orderId)
  }
  if (toolName === "message_driver") {
    // orderId is execution context supplied by the caller, not a model parameter.
    const { simulateDriverReply } = await import("./driver-sim.ts")
    return await simulateDriverReply(orderId, args.question)
  }
  if (toolName === "close_case" || toolName === "hand_to_person") {
    return `${toolName} executed`
  }
  throw new Error(`Unknown agent tool: ${toolName}`)
}
