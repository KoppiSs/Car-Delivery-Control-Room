# Bahn Car Delivery Control Room

An operations dashboard and triage system for car deliveries, featuring an autonomous AI agent loop powered by a local Llama 3.2 model. The system intelligently processes order delays, simulates driver communications, and aggregates case histories into a unified, operator-friendly inbox.

## Core Features
* **AI-Powered Triage Agent:** A backend reasoning loop (`lib/agent/run.ts`) that analyzes case facts, queries real-time routing margins, and proposes solutions using strict JSON tool schemas.
* **Driver Simulator:** A localized testing environment (`lib/agent/driver-sim.ts`) that generates realistic, context-aware driver SMS replies using Ollama.
* **Unified Inbox:** An email-style, threaded conversation view that groups messages by order ID, featuring inline expansion and persistent unread status markers.
* **Operations Queue:** A priority-sorted dashboard categorizing cases by urgency (e.g., "Decide now", "Decide today") and rendering actionable resolution options.

## Tech Stack
* **Frontend:** Next.js (App Router), React (Server and Client Components)
* **Backend:** Node.js, Next.js API Routes (`app/api/cases/[id]/agent/route.ts`)
* **Database:** PostgreSQL
* **AI Engine:** Local Ollama running `llama3.2`

## Local Setup

**Prerequisites:** You need Node.js 24 or newer and Docker installed on your machine.

1. Clone the repository and navigate to the primary directory:
   ```bash
   cd starter
2. Set up your environment variables:
   ```bash
   cp .env.example .env
3. Install project dependencies:
   ```bash
   npm ci
4. Start the local database container:
   ```bash
   docker compose up -d --wait
5. Push the database schem and seed it with the mock order data:
   ```bash
   npm run db:push
   npm run db:seed
   npm run attachments:seed
6. Start the Next.js development server:
   ```bash
   npm run dev
Open http://localhost:3000 in your browser. (Note: If port 5438 or 9009 is already in use on your computer, change it in `compose.yaml` and update the matching line in `.env`).

## Agent Architecture
The backend agent operates on a loop restricted to a maximum of 3 turns to prevent infinite execution. When triggered via the API, the LLM evaluates the triage case and can autonomously call predefined tools defined in `lib/agent/tools.ts`:
* `message_driver`: Pings the driver simulator for logistical updates.
* `close_case`: Autonomously resolves the issue and logs the factual reasons.
* `hand_to_person`: Formulates a recommended action plan, identifies required email templates, and hands the case over to the human queue for final approval.
