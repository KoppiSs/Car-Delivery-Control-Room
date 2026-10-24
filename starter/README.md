# Optional Control Room starter

This is a local operations prototype for the Car Delivery Control Room challenge. It uses Next.js with TypeScript, Postgres, Drizzle and Next.js API routes. The database comes from the fictional dataset in `../dataset/data`. No live Bahn system is connected.

The Control Room groups exception orders from left to right: Priority review, Needs review, Follow-up, and Manual control. Smooth orders stay hidden. Each card opens an order drawer while retaining the queue.
Every vehicle model in this dataset has a generated illustration on its record page. Orders with the same model share an image. An illustration is not evidence about the specific vehicle. Single-colour make marks are in `public/car-logos/` for teams that want them.

## Start

You need Node.js 24 or later and Docker.

```sh
cp .env.example .env
npm ci
docker compose up -d --wait
npm run db:push
npm run db:seed
npm run attachments:seed
npm run dev
```

Open http://localhost:3000.

## Local agent proposals

The Control Room opens orders in a drawer. For uncached orders, its Agent Proposal
card shows a **Generate proposal** button; opening an order never starts inference.
After the operator clicks the button, the card sends the
order ID, selected event history, active attention items and alert context to
`POST /api/agent`. The route first reads `orders.agent_proposal`. A non-null
value is returned immediately without calling Ollama. Otherwise it calls local Ollama at
`http://127.0.0.1:11434/api/generate` with a strict JSON schema in `format` and
`stream: false`. Ollama generates a compact, closed schema containing findings,
the executable tool call and the waiting description. The app copies the tool's
description into `proposed_action` and supplies the fixed `Approve follow-up`
button label, preserving the full five-field API/storage contract without asking
the model to generate duplicate text. Generation uses temperature zero and
allows one retry for incomplete or invalid output within the same 180-second
deadline. Complete, validated JSON is accepted even when Ollama reports a token
limit finish; incomplete JSON is never cached. The batch script uses the same
request builder and output validator.

Install and start Ollama, then install a model, for example `ollama pull llama3.2`.
Set `OLLAMA_MODEL=llama3.2` in `.env` (the default), or name another installed
model, and restart Next.js after changing the setting. Missing models and
connection failures appear in the card with a retry button.

The request body is `{ "orderId": "ord-00593", "events": [{ "id": "event-id", "command": "…" }], "context": {} }`.
`context` is optional. Successful responses contain exactly
`investigation_summary` (an array of findings with text and source event IDs), `proposed_action` (a string),
`decision_button_text` (a string), `executable_tool_call` (an action object), and
`waiting_on_description` (the specific external event expected next). The server validates this contract before
returning and saving a proposal in the order's nullable JSONB `agent_proposal`
column. Cached reads need only `orderId`; event validation applies on cache misses.
Unknown orders return 404 and database errors return 500. Invalid requests return 400 or 413; invalid model output
returns 502; an unavailable model returns 503; generation times out after 180 seconds
with 504.

Generation is shared per order while it is in progress, including across drawer
closes. A completed proposal is still saved if the original browser request was
cancelled. Other uncached orders receive a retryable busy response while the local
model is occupied, rather than waiting in an unbounded queue. Prompts use a bounded
selection of recent history and explicitly disclose truncated or omitted evidence.
The server bounds generation and response parsing to 180 seconds; the browser
also bounds the complete request to 195 seconds, so a stalled connection or body
always leaves the loading state with a retry message. Valid cached proposals in
the order detail render immediately without another agent request.

For CPU inference, prompts contain a short system instruction, selected current
issues, and at most six compact operational events within a 1,400-character
history budget. Review-feedback events are excluded from factual evidence. Source
and time remain attached, and omitted/truncated evidence is explicitly marked.
The schema is sent only in `format`, not repeated inside the system prompt. Model
context is 2,048 tokens, with 320 output tokens initially and a 448-token,
one-finding repair attempt. `keep_alive: "30m"` avoids repeated model cold starts.
Cache, manual ownership, approval rules, citations and mock execution are preserved.

`node scripts/benchmark-agent.mjs` measures generation without modifying orders.
It reports prompt/output token counts, time and proposal validity. Set
`AGENT_BENCHMARK_ORDER_ID` to measure a different case. On this local CPU, an
uncached relay-order test completed with a valid proposal in 46 seconds using
743 prompt tokens; earlier Ollama logs showed about 170 seconds for roughly
3,000 prompt tokens and 271 output tokens. These are observed local timings,
not a response-time guarantee.

New investigation findings use `{ "text": "Finding", "source_event_ids": ["event-id"] }`.
Ollama's schema restricts those IDs to supplied order events, and the server
validates citations before saving them. Context-only findings use an empty array.
Saved plain-text summaries remain readable; generating or revising a plan adds
the new source links without guessing citations for historical text.

Investigation summaries render as plain bullet lists. Source IDs remain saved
with findings, without hover or focus highlighting in either timeline.

**All Deliveries** (`/deliveries`) is a separate navigation view backed by the
read-only `GET /api/deliveries` route. It includes all orders and statuses, with
search across references, vehicles, customers, routes and status labels. The
state sections have separate headings, counts and dividers, using the actual
order status (including Follow-up) rather than the display lane. Its
detail drawer shows delivery facts, saved investigations, waiting descriptions,
evidence and history. It never mounts the interactive agent card or offers a link
to the editable order page. Control Room retains its exception-only queue and
operator controls. `node scripts/test-readonly-deliveries.mjs` checks this boundary;
`node scripts/smoke-control-room.ts` checks both views against current database state.

For an existing database, run `npm run db:push` to add the column without reseeding.
The equivalent additive SQL is in `migrations/0001_agent_proposal.sql`.
Newly seeded orders start with null proposals. Proposals remain cached until
explicitly cleared (set `agent_proposal` to SQL `NULL`); reseeding also clears them.

**Approve follow-up** calls `POST /api/agent/execute` with the displayed proposal's
executable tool call and waiting description. A single transaction inserts an
`agent_mock_actions` record, records approval in feedback and the timeline, closes
the active alert episodes, clears `orders.agent_proposal`, and sets
`orders.status` to exactly `follow_up`. The waiting description is saved in
`orders.waiting_on_description`. No real message, booking or external tool call is
performed. The drawer calls `router.refresh()` and refreshes its client-loaded
order/queue data, showing the saved waiting state immediately.

Edit instructions stay in review feedback. The model receives the previous
external dependency when revising a plan. Generation rejects descriptions that
echo the operator's instruction or refer to editing/regenerating the plan, and
gets one bounded repair attempt. Approval also checks saved override feedback
before writing a mock action, so a cached instruction echo cannot become a
Follow-up waiting state.

The Follow-up column explicitly includes `follow_up` orders even when no active
alert remains. Each card prominently shows **Waiting on** and the saved
`waiting_on_description`; the original problem title remains visible. The drawer
also restores this waiting state on reopening instead of offering to generate a
replacement proposal.

Reject Proposal persists a review decision without executing an action. A revised
proposal resets to Pending for a fresh review. Older three-field proposals remain
readable in history and the drawer, but cannot be executed. Their **Prepare
follow-up** button explicitly asks Ollama to add a mock executable action and a
waiting description while retaining the old plan for audit.

`POST /api/agent/decision` accepts `orderId`, `decision` (`APPROVED` or `REJECTED`),
and `proposal` (the exact plan being reviewed). Stale plans return 409; repeated
submissions of the same decision are idempotent. Apply
`migrations/0003_agent_decisions.sql` (or `npm run db:push`) for the persistent
`agent_decision` and `agent_decision_at` fields. Takeover persists `TAKEN_OVER`.

**Prior agent work** combines the packet's original proposals with all saved
approvals, rejections, edits and takeovers, showing the reviewed/replacement plan,
operator identity, outcome and time. `GET /api/orders/:id` includes `agentFeedback`
for those locally recorded decisions. The source problem title and description
remain unchanged on takeover; only the review type and ownership change.

### Operator corrections and manual takeover

**Edit Proposal** opens a short correction field. Submitting it immediately
requests a revised plan from Ollama using the current evidence, previous action,
and human steer. The prior proposal remains available if revision fails. The
`POST /api/agent` request adds `correction` and `previousProposal`; the server
checks that the displayed proposal is still current before revising it.

**Take Over** dismisses the agent and clears its automated alert state, with a
resolution reason explicitly recording transfer to manual ownership rather than
claiming that the delivery problem has disappeared. The order remains in the
Control Room as **Manual follow-up**. The operator can save a next-step note or
record a manual resolution and select the resulting order status. These controls
write local fictional records; they do not send messages or make bookings.

`POST /api/agent/manual` accepts `orderId`, `operation` (`takeover`, `note`, or
`resolve`), and an optional `note` for takeover or required note for the other
operations. `resolve` additionally requires `nextStatus` (`NEW`,
`WAITING_FOR_PICKUP`, `IN_TRANSIT`, `DELIVERED`, or `CANCELLED`). A completed manual
resolution ends manual queue ownership. The order can still reappear if a new
active alert is raised. Automatic and batch generation exclude manually owned
orders, and revision checks prevent late model responses from undoing takeover.

Apply `migrations/0002_agent_feedback.sql` to an existing database (or run
`npm run db:push`). It adds `orders.agent_mode`, `orders.agent_revision`, and
`agent_proposal_feedback`. Each submitted override records its correction,
original proposal, requested/applied/failed/superseded outcome, replacement
proposal when successful, and timestamps. Takeover records its own decision with the
discarded proposal. The timeline records edits, revised proposals, takeover,
manual notes and resolutions. The starter has no authenticated operator session,
so audit entries use the explicit generic identity `operator` rather than claiming
to identify a particular person. Reseeding explicitly clears feedback with the
other local challenge records.

`node scripts/test-agent-feedback.mjs` verifies feedback and manual workflows
against Postgres with temporary records. `node scripts/smoke-agent-edit.mjs`
additionally verifies a real Ollama revision from ferries to trains. Both remove
their test records afterward.

Run `node scripts/test-agent.mjs` to check the actual route with mocked Ollama
responses, including invalid inputs, output validation and connection errors.
`node scripts/test-agent-loading.mjs` checks stalled connections and response
bodies, cancellation, error handling, and prompt size limits. The agent route
tests also check generation reuse, drawer cancellation, busy responses, output
truncation, and retry after a timeout.
`node scripts/test-agent-card.mjs` verifies that opening an order does not request
generation, the button starts it explicitly, repeated clicks do not duplicate it,
and cached proposals render immediately. The route tests cover schema-constrained
requests, recovery from invalid output, and valid JSON at the token limit.

Run `npm run ai:generate` from `starter/` to generate proposals in bulk without
starting Next.js. `scripts/generate_proposals.js` connects directly to Postgres,
selects orders whose status is `BLOCKED` (case-insensitive) and whose
`agent_proposal` is SQL null, and processes them sequentially through local Ollama.
It reads `starter/.env`, uses `DATABASE_URL` and `OLLAMA_MODEL`, and shares the API's
system prompt and strict JSON validator. Each request includes the latest 50
timeline events and active alerts. It only stores proposals; it does not execute
them, resolve alerts, or contact anyone. Existing proposals are preserved, and
the status and null cache are checked again before saving. Failed orders remain
eligible for retry; the script continues with the others and exits nonzero if
any failed. The supplied snapshot currently has no orders with a blocked status,
so a zero-order run is expected unless the local data has changed.

`POST /api/agent/execute` accepts this JSON shape:

```json
{
  "orderId": "ord-00593",
  "executable_tool_call": {
    "action_type": "REQUEST_DRIVER_UPDATE",
    "payload": { "description": "Ask the fictional driver for a fresh location and ETA." }
  },
  "waiting_on_description": "Waiting for the driver to confirm their location and ETA."
}
```

The request may additionally include `proposal`, containing the complete displayed
proposal object. The route compares the action and waiting text with the current cached
proposal before executing; stale or manually controlled orders return 409.
Repeated approvals of the same action return the original action/event IDs and
never create duplicate records. Successful execution returns `success`,
`simulated`, `status: "follow_up"`, action/event IDs and the waiting description.
Missing orders return 404, invalid payloads 400/413, and database failures 500;
transaction failures preserve the original proposal, status and alerts.

The generator uses a closed schema for `executable_tool_call` with `action_type`
and `payload`; generated payloads contain a short `description`. The expected
external event is the separate top-level `waiting_on_description`. Apply
`migrations/0004_agent_follow_up.sql` (or `npm run db:push`) for the mock action
table and order waiting-description column. Reseeding clears mock actions along
with feedback and the other fictional records.

Run `node scripts/smoke-agent-execute.mjs` to verify atomic writes, strict
`follow_up` status, cleared proposals, waiting text, duplicate safety, alert
history and queue visibility using temporary records. `node
scripts/test-follow-up-card.mjs` verifies prominent waiting text. The proposal
card test also checks the execution request and `router.refresh()`.

The Compose file uses three ports on this computer: 5438 for Postgres, 9009 and 9010 for the attachment store. If one of them is already in use, change it in `compose.yaml` and update `DATABASE_URL` or `S3_ENDPOINT` in `.env` to match.

The seed command **replaces** data in the local challenge database after checking every manifest count. It makes the replacement in one transaction. Run it again after updating the JSONL files.
If you add your own tables with foreign keys to the starter data, reseeding stops instead of deleting those tables. Keep participant work in separate tables or migrate it deliberately before replacing the snapshot.

The same Compose file starts a local S3-compatible attachment store. `attachments:seed` checks each file against `../attachments/manifest.json` before uploading it. It can be rerun safely. The store is only available on this computer: API at http://127.0.0.1:9009 and browser console at http://127.0.0.1:9010/rustfs/console/. The console credentials are in `.env.example` and are only for this fictional local setup.

## What is here

- `lib/schema.ts`: typed tables for orders, customers, managed sites, one-off addresses, vehicles, drivers, items, conversations, messages, alerts and operational events. Other dataset collections, including internal room activity, keep their complete fields in `related_records` JSONB.
- `lib/present/`: the reading layer. It turns records into labelled view models: `labels.ts` (codes to words), `actors.ts` (identifiers to names and roles), `attention.ts` (what needs a person and which date decides the next step), `board.ts` (one card per order), `record.ts` (the order page, section by section) and `events.ts` (one sentence per event). Nothing here is a source of truth; every value points back to a record in the API.
- `scripts/seed.ts`: loads every collection named in the dataset manifest. It checks basic field types while loading.
- `GET /api/overview?q=...`: lane totals, per-lane attention counts and all matching order cards. Each card carries its derived attention items, the date that decides its next step and short work lines.
- `GET /api/orders/:id`: one order with its linked addresses, managed site profiles when present, vehicle, assigned drivers, alerts, messages, event history and other records, plus `view`, the same information read out for the interface: a plain-language headline, four tiles, the route, threads, evidence, proposals and history.
- `GET /api/entities/:kind` and `GET /api/entities/:kind/:id` for `driver`, `customer` and `site`: a list with order counts, and one record with its facts and the orders it is involved in. These serve the Customers, Drivers and Places pages.
- `GET /api/inbox`: support threads that arrived without a safe order link, plus their messages, and a `view` with names and order references. Candidate orders are hypotheses; `linked_order_ids` holds confirmed links. These records stay in `related_records` so the order detail route does not silently file an unresolved thread under a car. The Inbox page shows them as a mailbox.
- `GET /api/reference-data`: shared fictional terminals, road estimate ranges and operations actors that are not tied to a single order.
- `GET /api/orders/:id/attachments`: metadata for the order's fictional PDFs and photos, with short-lived read-only URLs from the local attachment store.

The Control Room includes orders with active alerts or blocked work, plus open
manual follow-ups. Priority review contains high-priority open alerts; Needs review
contains other open questions; Follow-up contains owned alerts and approved or
rejected plans; Manual control contains orders taken over by operations. Each
order appears in exactly one column. Search by reference, plate, customer, vehicle
or city. Clicking a card opens a drawer; the full record is also available at
`/orders/:id`. Ownership changes never replace the underlying problem title.

The attention signal is derived from open alerts, unresolved incidents, open work items, open conversations, pending or failed agent proposals, unresolved endpoint claims, custody follow-ups, support inbox threads that name the order, and a moving car whose driver has started the leg while the app has sent no position and the delivery promise is still open. A conversation filed on one order and related to another counts for both, on the board and on the record. A quiet card means those records are empty, not that the order is verified safe. `display_lane` and the derived signal are reading aids for this starter, not operational truth.
The order record is deliberately short. It opens with the model illustration, the car, a few facts as chips, one sentence of context and one headline about the situation ("Cole Mervalen collects it tomorrow.", "Running late to Hamburg.", "Still being prepared."). When the attention list holds a danger or warn item, the detail line ends with the first of them as "Open: ...". A danger item also gives the headline that tone. Then "Needs a person", four tiles (pickup, delivery, driver, fee or ETA), the route as stops with a leg between them, conversations with the last message, evidence as chips and a strip of sample files, prior agent work and the latest activity. When nothing is waiting, the panel says "Nothing in the records is waiting on a person." and names which records were checked and which were not. "Prior agent work" lists proposals already on the order with their recorded review. A team's own agent and the human decision on its proposals belong there. Everything else is folded under "Everything on this order": route details, alerts and work, drivers, the driver market, travel, costs, proofs and documents, prior agent work with room activity, and the full history. The page shows the shape of the data; the API and those folds hold the depth. Names of customers, drivers and sites link to their own pages, and order references link to the order. "Not supplied" is an unknown input, not a failed pickup. Labels come from `lib/present/labels.ts`; the raw codes stay in the API.
Open, acknowledged, resolved and dismissed alerts remain distinct in the order view. An acknowledged alert still appears on the board with its owner; it is not treated as resolved. A dismissed alert retains the stale or invalid source and the evidence for dismissing it.
The order detail also shows selected sample photos and PDF links when the order has bundled files. The signed links expire after 15 minutes; reload the page to refresh them. Booked travel is shown separately from options. For a moving car, the first-view ETA comes from the last direct driver-app observation; a later schedule inference is labelled separately. Tracking records in this packet have no map coordinates, so the starter does not draw a live position.
Slots, promises and ETAs show the window's local time with its zone name; everything else is UTC, and every time carries the full UTC value on hover. Relative phrases such as "in 2 d" are measured against the snapshot time, not the real clock. Messages show their channel and recipient, because a case workspace is not one shared public thread.

Proposal review and simulated manual actions are stored locally. There is no authenticated operator session or external execution. Before changing a plan, check the current facts, evidence and authority.

## Check

```sh
npm run typecheck
npm run build
APP_URL=http://localhost:3000 npm run smoke
APP_URL=http://localhost:3000 npm run attachments:smoke
```

The first smoke check compares one order's plans, points and segments in the API with the JSONL source, then fetches every board card and its order record and fails if they disagree on whether the order needs a person. The attachment check downloads one file of each format and checks its hash against the manifest. Run the app before these checks. The seed and the checks read `../dataset/data` and `../attachments`; set `DATASET_DIR` or `ATTACHMENTS_DIR` to point them at another folder with the same files.

## Rerun on modified input

`DATASET_DIR` plus `npm run db:seed` is the supported way to see the starter on changed data. Copy `../dataset/data` to another folder, edit a JSONL row there, then run:

```sh
DATASET_DIR=/path/to/your/copy npm run db:seed
```

The seed replaces the database in one transaction after checking every collection's row count against the manifest in that folder, so change values rather than the number of rows, or update the manifest as well. The running app reads the new rows on the next request. A reviewer can use this to check that a changed alert, window or thread moves the board and the record together.

All names, messages and events in the bundled dataset are fictional. The starter uses Bahn's birch, asphalt and sand colours and loads Unbounded, Poppins and Reddit Mono from Google Fonts as the brand's published fallback faces, falling back to Arial without a network. It does not bundle licensed brand fonts or copy Portal screens.

`node scripts/test-review-columns.mjs` checks column ordering and exclusive grouping.
`node scripts/test-agent-history.mjs` checks Prior agent work rendering; the feedback
integration test verifies approval/rejection persistence after reopening, idempotent
approvals, fresh review for edited plans, and stable problem titles on takeover.
