# wkil Copilot — Chat-First Experience

Date: 2026-08-23
Status: Ready for user review

## Context

wkil is an AI customer-engagement platform for MENA SMBs. The owner experience today is a traditional Next.js dashboard with ~14 pages (inbox, agent-setup, content-library, media-library, customers, analytics, settings, channels, social-creator, brand-kit, website-widget, ...). Configuration happens through forms.

This spec turns wkil into a chat-first product: the owner manages their business by talking to a copilot, and the very first conversation a new user has **is** the onboarding interview. The existing dashboard pages remain reachable for deep/detail work.

The backend already has everything this needs: a provider-agnostic LangChain/LangGraph runtime (`ai-agent/core/modelRuntime.ts` builds `BaseChatModel` for Gemini/OpenAI/Anthropic from the admin-managed AiModel/AiPipeline registry with tier fallback), a LangGraph `StateGraph` + Postgres checkpointer (`agentGraphV2.ts`), Socket.IO realtime with dashboard/mobile namespaces and room auth, a notifications module with push services, and an OpenAPI → generated-types pipeline to the frontend. The copilot is built on this runtime, not beside it.

## Goals

- A new chat home becomes the default landing page of the web dashboard; all existing pages stay reachable via the sidebar.
- The owner can ask about business data (stats, leads, conversations needing attention, customers, AI usage) and receive rich typed cards.
- The owner can trigger work through chat (draft customer replies, create/schedule posts, generate images, toggle handoff, pause a channel's AI) — every write action gated behind an explicit confirmation card.
- wkil messages the owner proactively (handoff queue, quota thresholds, scheduled-post reminders) inside the same thread.
- New-user setup happens as a guided conversation (business info → website scrape → knowledge base review → brand kit → channel connect) writing through existing services.
- Bilingual Arabic/English, RTL-first, dialect-aware replies; web dashboard first, mobile later.
- Provider-agnostic: a new `"copilot"` key in the existing AiPipeline registry; admins manage copilot models from the existing admin pages.

## Non-goals

- Removing or rebuilding existing dashboard pages.
- Mobile (Flutter) chat UI in this phase — the design is platform-agnostic so Flutter can adopt it later.
- Voice input/output.
- Rebuilding channel OAuth/connection flows inside chat — chat links to the existing channel pages.
- A consumer-facing messenger product; this remains a B2B owner experience.
- Plugin/marketplace extensibility for third-party tools.
- Multiple copilot personalities or multi-agent orchestration.

## Product Decisions

| Decision | Choice |
|---|---|
| Product direction | Chat-first dashboard AND chat-based onboarding, as one system |
| Relationship to dashboard | Chat is the home; existing pages remain reachable |
| v1 capabilities | All four: read queries, confirmed write actions, proactive messages, chat onboarding |
| Platform order | Web dashboard first; Flutter later |
| Backend shape | New `copilot` module inside the existing Express monolith (no microservice) |
| Agent runtime | LangGraph `StateGraph` on the existing `modelRuntime` (LangChain `BaseChatModel`; Gemini/OpenAI/Anthropic via AiPipeline tiers) |
| Model management | New `"copilot"` pipeline key in the existing admin AiPipeline/AiModel registry |
| Conversation state | LangGraph `PostgresSaver` checkpoint + explicit `Copilot*` tables for envelopes/actions |
| Write-action safety | Confirmation cards backed by a `CopilotAction` audit row; 15-minute expiry |
| Streaming/transport | Socket.IO dashboard namespace, `copilot:<userId>` room; REST fallback |
| Proactive delivery | Hooks into notifications/quota/scheduler events; per-type opt-out + quiet hours |
| Type sharing | REST contract documented in `openapi.yaml`; frontend declares local interfaces per repo convention (`types:api` output is currently unused app-wide — noted; repo-wide adoption out of scope) |

## Implementation Principles

- **Library-first, always** — before writing any custom code (UI or backend), check for a well-maintained package, a framework feature, or an existing tool in the repo that solves the problem, and prefer it. Custom code is the last resort, with a comment explaining why no existing solution fit.
- **Audit existing from-scratch code** — when the work touches existing code that was built from scratch where a well-maintained library now exists, note it explicitly in the implementation plan; where the switch is low-risk and in-scope, replace it with the library. Out-of-scope replacements are recorded as follow-ups, never done silently.
- Concretely for this project:
  - Backend: LangChain `tool()` + LangGraph built-ins for the agent loop and `PostgresSaver` for checkpointing — never hand-rolled agent loops or state tables for graph state.
  - Frontend: established packages for generic concerns (e.g. `react-markdown` + `remark-gfm` for assistant text rendering, existing i18n/date/scroll utilities) — no custom markdown parsers, formatters, or scroll engines.
  - Reuse existing repo infrastructure (auth middleware, quotas, realtime rooms, notifications, scraping, media storage) before introducing anything new; new dependencies require justification.

## Architecture

```text
┌─ app (Next.js 15) ──────────────────────────────────┐
│ /[locale]/user/copilot  ← default landing           │
│ ChatShell · MessageStream · Composer · cards/       │
└──────┬────────────────────────────▲─────────────────┘
       │ REST (history, confirm/cancel)               │ Socket.IO `/` (deltas, envelopes, proactive)
┌──────▼────────────────────────────┴─────────────────┐
│ back-end  src/modules/copilot                       │
│ ├─ copilot.routes/controller  (OpenAPI-documented)  │
│ ├─ copilot.graph   LangGraph StateGraph:            │
│ │    loadContext → callModel → executeTools         │
│ │    → buildEnvelopes  (PostgresSaver checkpoint)   │
│ ├─ copilot.tools/  registry of LangChain tools      │
│ │    (zod schemas) wrapping existing services       │
│ ├─ copilot.cards   tool result → UI envelope        │
│ ├─ copilot.onboarding  interview mode of the graph  │
│ └─ copilot.proactive   event → envelope → room push │
└──────┬──────────────────────────────────────────────┘
       │ Prisma
       ▼
 CopilotConversation · CopilotMessage · CopilotAction
 (existing tables untouched)
```

### Backend components

- **`copilot.routes/controller`** — REST only: list threads, fetch history, post message (socket fallback), confirm/cancel action. Documented in `docs/openapi.yaml`; types reach the frontend via `npm run types:api`.
- **`copilot.graph`** — the conversation loop and nothing else. Nodes: `loadContext` (system prompt + dialect + business snapshot + history window), `callModel` (via `executeWithModelFallback` on the `"copilot"` pipeline, tools bound, deltas streamed), `executeTools` (runs handlers under the user's auth context and quota), `buildEnvelopes` (final output → envelope array → persist → emit). Checkpointed with the existing `PostgresSaver`, so confirmation pauses/resumes are durable.
- **`copilot.tools/`** — one file per tool: `{ name, description, zodSchema, requiresConfirmation, handler(ctx) }` as LangChain `tool()` definitions. Handlers call existing module services (inbox, analytics, content, settings, follow-up, scraping) — they never bypass business logic or hit tables owned by other modules. The registry is an index array: adding a tool = adding a file.
- **`copilot.cards`** — pure functions mapping tool results → typed UI envelopes.
- **`copilot.onboarding`** — interview mode of the same graph: a step state stored on the conversation row (`business_info → website_scrape → kb_review → brand_kit → channel_connect → done`) plus step tools. Channel connection emits a deep-link card to the existing channel pages. On `finish_onboarding`, `kind` flips from `onboarding` to `general`; the same thread continues as the daily copilot.
- **`copilot.proactive`** — subscribes to notification events (handoff requested), quota thresholds, and the post scheduler; builds envelopes, persists them, pushes to `copilot:<userId>`. Per-type opt-out and quiet hours live in user settings.

### Data models (Prisma)

- **`CopilotConversation`** — id, userId, kind (`onboarding` | `general`), title, locale, onboardingStep, summary, lastMessageAt, createdAt
- **`CopilotMessage`** — id, conversationId, role (`user` | `assistant` | `system`), envelope (JSON), status, createdAt
- **`CopilotAction`** — id, messageId, tool, params (JSON), status (`pending` | `confirmed` | `cancelled` | `executed` | `failed` | `expired`), result (JSON), modelName, createdAt, executedAt

### UI envelope types (v1)

`text`, `stat-grid`, `lead-list`, `conversation-list`, `post-draft`, `image-card`, `confirm-action`, `progress` (feedback for long-running tools like website scraping and image generation), `link-card` (deep-link CTA, e.g. channel connection), `error`.

### Frontend components (`app/src`)

- Route `app/[locale]/(protected)/user/(dashboard)/copilot` — default landing after login (`/dashboard` redirects here); sidebar unchanged, copilot gets the top entry.
- `components/copilot/` — `ChatShell`, `MessageStream`, `Composer`, `ThinkingIndicator`, and `cards/` with one renderer per envelope type. `ConfirmActionCard` calls the confirm/cancel REST endpoints.
- `hooks/useCopilotSocket` — JWT auth, joins `copilot:<userId>`, handles deltas/final envelopes/proactive pushes; on reconnect refetches via REST (only persisted envelopes are source of truth).
- RTL layout flips by locale; quick-reply suggestion chips under the composer in Arabic and English; new i18n keys in `messages/ar` + `messages/en`.

### v1 tool set

| Tool | Type | Confirms? |
|---|---|---|
| `get_overview_stats` | read | no |
| `get_leads` | read | no |
| `get_conversations_needing_attention` | read | no |
| `get_customer` | read | no |
| `get_ai_usage` | read | no |
| `draft_customer_reply` | write | yes |
| `create_post` | write | yes |
| `schedule_post` | write | yes |
| `generate_image` | write | yes |
| `set_handoff_enabled` | write | yes |
| `set_channel_ai_paused` | write | yes |
| `save_business_info` | onboarding | no (reviewed in `kb_review`) |
| `scrape_website` | onboarding | no |
| `set_brand_kit` | onboarding | no (reviewed in `brand_kit`) |
| `finish_onboarding` | onboarding | yes |

## Data Flow

**Happy path (chat message):**

1. Composer → Socket.IO `copilot:message` (JWT via existing dashboard socket auth). Server persists the user `CopilotMessage`, then starts a graph run. REST `POST .../messages` is the fallback when the socket is unavailable.
2. `loadContext` assembles: copilot system prompt (persona + owner's dialect + business snapshot) + checkpointed history + the new message.
3. `callModel` invokes the model via `executeWithModelFallback` on the `"copilot"` pipeline, tools bound. Token deltas stream to the client as `copilot:delta`.
4. Tool calls run in `executeTools` against existing services, under the user's auth context and quota. Results feed back to the model.
5. `buildEnvelopes` maps final text + tool results → envelope array → persisted as one assistant `CopilotMessage` → emitted to room `copilot:<userId>`.

**Confirmation path (write actions):**

6. A `requiresConfirmation` tool does not execute in the graph. Instead: a `CopilotAction` row is created (`pending`) and a `confirm-action` envelope is emitted. The user taps **Confirm** (`POST /copilot/actions/:id/confirm`) → the graph resumes from the Postgres checkpoint and executes → result envelope. **Cancel** marks the action cancelled and the model acknowledges gracefully.

**Proactive path:**

7. A domain event (handoff requested, quota at threshold, post going live) → `copilot.proactive` builds an envelope → persists it → pushes to the room. Offline users see it when they open the chat home — the thread doubles as a notification center.

**History management:** last ~20 messages verbatim plus a running summary stored on the conversation row when threads grow long.

## Error Handling

- **Provider failure** — handled by existing tier fallback (`executeWithModelFallback`, retryable-error detection). If all tiers fail: an `error` envelope in the user's language, message marked failed, tap-to-retry.
- **Tool failure** — handler throws → structured error returned to the model → it explains and offers an alternative; the card shows an error state. Never silent.
- **Confirmations expire** after 15 minutes → status `expired`; the card disables itself with an explanation.
- **Quota exhausted** — generation blocked with a clear card + upgrade link (reuses existing quota checks).
- **Invalid tool args** — zod validation failure returns to the model, which re-asks the user instead of executing anything.
- **Socket disconnect mid-run** — the run continues server-side; on reconnect the client refetches via REST history. Deltas are ephemeral; only persisted envelopes are source of truth.
- **Rate limiting** — per-user throttle on both socket and REST message endpoints.
- **Audit** — every write action row stores params, result, and the model that proposed it.

## Testing

Following repo conventions (vitest, colocated `*.test.ts`):

- **Tools** — unit test per tool with mocked services, plus one registry contract test (every tool has name, description, zod schema, confirmation flag).
- **Graph** — tests with a scripted fake `BaseChatModel`: tool-call loops, confirmation pause/resume, envelope building. Golden transcripts for three journeys: stats query, create-post-with-confirm, full Arabic onboarding interview.
- **Cards mapper** — pure-function tests: result → envelope.
- **Confirmation lifecycle** — integration: pending → confirm → executed; cancel; expiry.
- **Proactive** — event in → envelope persisted + socket emitted (mocked).
- **REST/OpenAPI** — controller tests per existing conventions; new routes documented in `openapi.yaml` so `npm run docs:check` and `docs:routes` pass, and `types:api` regenerates frontend types.
- **Frontend** — no new test runner (the app repo has none); safety comes from generated OpenAPI types, TypeScript, and eslint, plus a manual QA script for the chat home in both ar/en.

## Rollout Phases

1. **Foundations** — Prisma models, `"copilot"` pipeline key, graph + tool registry, cards, socket room, chat home route, onboarding interview, read-only tools.
2. **Actions** — `CopilotAction` lifecycle, confirmation cards, write tools.
3. **Proactive** — event hooks, opt-out/quiet-hours settings, notification-center behavior.
4. **Mobile** (later, separate spec) — Flutter renders the same envelopes via the `/mobile` namespace.
