export const AGENT_TOOLS = [
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

export async function runTool(toolName: string, args: any, orderId: string): Promise<string> {
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
