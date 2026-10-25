// A proposal is something WE do. Its action must read as an instruction to the control
// room ("Ask the dealer…", "Send…"), never as someone's own speech ("I received…", "I'm…").
// Pure, so both the server (before saving) and the browser (before showing) can use it.

/** Words an instruction to the control room starts with. */
const INSTRUCTION_VERBS = new Set([
  "ask", "send", "call", "phone", "email", "message", "text", "contact", "tell", "inform", "notify", "remind", "chase",
  "check", "recheck", "confirm", "verify", "review", "investigate", "monitor", "track", "follow",
  "request", "obtain", "get", "collect", "secure", "find", "book", "rebook", "reserve", "arrange", "organise", "organize",
  "coordinate", "schedule", "reschedule", "move", "swap", "assign", "reassign", "dispatch", "offer", "propose", "agree",
  "approve", "escalate", "hold", "keep", "wait", "prepare", "record", "update", "cancel", "replace", "provide", "share", "give",
  "open", "create", "log", "raise", "flag", "report", "alert", "warn", "note", "document", "attach", "plan", "decide",
  "pause", "stop", "resume", "reroute", "redirect", "transfer", "hand", "recover", "release", "retrieve",
])

/** First-person speech: the text speaks as a person, not about what we should do. */
const FIRST_PERSON = /\b(?:i|i'm|im|i've|i'll|i'd|me|my|mine|myself)\b/i

/** Why a text is not an instruction for us, or null when it is one. */
export function instructionProblem(text: string | undefined | null): string | null {
  const value = (text ?? "").trim()
  if (!value) return "it is empty"
  if (FIRST_PERSON.test(value)) return "it is written in the first person, as if someone else were speaking"
  const first = value.split(/\s+/)[0].toLowerCase().replace(/[^a-z']/g, "")
  if (!INSTRUCTION_VERBS.has(first)) return `it does not start with something we do ("${value.split(/\s+/)[0]}")`
  return null
}

/**
 * The car being driven on, or the driver being asked whether they can: "continue driving",
 * "drive on", "resume the journey", "cleared to drive", "safe to drive", "can still drive".
 */
const DRIVE_ON = new RegExp([
  /\b(?:continue|continues|continuing|keep|keeps|carry on|resume|resumes|go on|proceed|proceeds)\s+(?:to\s+)?(?:driv\w*|the\s+(?:drive|journey|trip|route|delivery|transfer)|on\s+the\s+road|on\b)/.source,
  /\bdriv(?:e|es|ing)\s+on\b/.source,
  /\b(?:cleared|clear|fit|safe|okay|ok|able|allowed|permitted)\s+to\s+(?:drive|continue|proceed|move on)\b/.source,
  /\b(?:can|could|may|should)\s+(?:still\s+|safely\s+)?(?:drive|continue|proceed|move on)\b/.source,
  // The driver driving the car somewhere (a tow moving it is fine).
  /\bdrive\s+(?:the\s+car\s+)?to\s+(?:the\s+)?(?:next|nearest|delivery|destination|garage|workshop|dealer)/.source,
].join("|"), "i")

/** Why a text has the car driven on during a safety stop, or null. */
export function driveOnProblem(text: string | undefined | null): string | null {
  const match = (text ?? "").match(DRIVE_ON)
  return match ? `the order has an open safety stop and it suggests driving on ("${match[0]}"); the car stays put` : null
}

type Checked = { proposed_action?: string; waiting_on_description?: string; executable_tool_call?: { payload?: Record<string, unknown> } }

/**
 * Why a proposal must not be shown or saved, or null when its action is our instruction.
 * With an open safety stop, a plan that has the car driven on (or asks whether it can be) is refused too.
 */
export function proposalProblem(proposal: Checked | null | undefined, order: { safetyStop?: boolean } = {}): string | null {
  if (!proposal) return null
  const action = instructionProblem(proposal.proposed_action)
  if (action) return `The suggested action is not an instruction for us: ${action}`
  const description = proposal.executable_tool_call?.payload?.description
  if (typeof description === "string") {
    const problem = instructionProblem(description)
    if (problem) return `The follow-up action is not an instruction for us: ${problem}`
  }
  if (order.safetyStop) {
    for (const text of [proposal.proposed_action, description, proposal.waiting_on_description]) {
      const problem = typeof text === "string" ? driveOnProblem(text) : null
      if (problem) return `The suggestion breaks the safety rule: ${problem}`
    }
  }
  return null
}

/** Stated to the model on the retry. */
export const INSTRUCTION_RULE = "The action must be something the control room does, written as an instruction that starts with a verb "
  + "(for example \"Ask the dealer whether…\", \"Send the driver…\"). Never write as the driver, customer or site, never use I/me/my, "
  + "and never describe what someone already did."
