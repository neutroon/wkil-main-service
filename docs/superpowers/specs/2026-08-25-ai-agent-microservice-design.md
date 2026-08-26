# Design: Extract `ai-agent` core into the official LangGraph self-hosted service (Path A)

**Date:** 2026-08-25 (revised for Path A)
**Status:** Approved (design), pending revised-spec review
**Author:** Architecture brainstorming session

## 1. Goal & Scope

Migrate the **`ai-agent` core** module of the `wkil-backend` monolith into a standalone,
**officially self-hosted LangGraph service** (`langgraph/langgraph-api`) in order to:

- Remove hand-rolled LangGraph orchestration/runtime code (custom `StateGraph`, `PostgresSaver`
  checkpointer, `modelRuntime`, queue wiring) that introduces bugs.
- Adopt the **official `langgraph-api` server** (self-hosted) for the graph runtime, persistence,
  task queue, and streaming. We do **not** hand-roll a server/queue/streaming layer.
- Transport between monolith and agent uses the **platform's native API/SDK** (no custom broker).
- Replace Postgres/pgvector RAG with a dedicated **Qdrant** vector store.
- Be **provider-agnostic** for LLM and embeddings (no Google lock-in) — multi-provider from day one.

> **License note (accepted):** `langgraph` (core) and `langgraph-checkpoint-postgres` are MIT. The
> `langgraph-api` server runtime is **Elastic License 2.0 (ELv2)** — source-available, not OSI.
> ELv2 permits internal self-hosting (no "provide as a hosted service", no license-key
> circumvention, keep notices). LangChain ties production self-host to a paid plan per their docs.
> We accept ELv2 for internal use. If strict 100% permissive OSS becomes a hard requirement later,
> the fallback is to embed MIT `langgraph` in our own thin FastAPI service (see §12).

**In scope (this slice):**
- `src/modules/ai-agent/core/*` (agentGraphV2, agentState, checkpointer, modelRuntime,
  pipelineRuntime, agentTurn.service, aiAgent.runtime, aiEngine.utils, contextWindow, replyPolicy)
- `src/modules/ai-agent/nodes/*` (callModel, parseDecision, runActionToolsV2, runGuardrail,
  recordUsage, recoveryDecision, structuredOutputRepair)
- `src/modules/ai-agent/rag/*` (rag.service, chunker, chunkTypeFields, similarityThreshold)
- `src/modules/ai-agent/core/agentActionTools.ts` (action tool definitions)
- Custom `PostgresSaver` checkpointer (`core/checkpointer.ts`)

**Out of scope (this slice):** `copilot`, `meta`, `order-confirmation` LLM paths, `ai-agent/chat/*`
(business-chat reply orchestration stays in monolith and becomes a *caller* of the new service),
and `ai-agent/rag` consumers outside core. These become future slices.

## 2. Architecture (official server, native API transport — no custom broker)

```
┌──────────────────────────┐     langgraph-sdk (REST + SSE)      ┌──────────────────────────────┐
│  TS Monolith (existing)  │ ─── createThread / createRun ──────▶│  LangGraph service            │
│  - business logic        │ ◀── streamed tokens / result -------│  (langgraph/langgraph-api)    │
│  - billing / quota       │                                     │  - graph (ported from TS)    │
│  - RAG source data       │ ◀── tool HTTP calls (per tool) -----│  - built-in checkpointer      │
│  - tool executor         │                                     │  - built-in queue + streaming │
│  invoke rag-ingest run ─▶│                                     │  - Qdrant (RAG)               │
└──────────────────────────┘                                     └───────────────┬──────────────┘
        │                                                                              │ upsert/query
        └── Postgres (monolith-only; BusinessProfileChunk dropped at cutover)        ▼
                                                      Qdrant (agent service owns) + Postgres/Redis (platform-managed)
```

- The monolith calls the agent **only** through the LangGraph Platform API via `langgraph-sdk`
  (JS client). No Redis Streams broker, no custom transport. The platform owns HTTP, persistence,
  queue, and streaming.
- When the graph needs a business action, the Python graph invokes a **tool** that is a thin
  HTTP client to the monolith's internal tool endpoints (see §7). This is the official
  tool-calling model — no custom broker.
- RAG ingest is a **dedicated graph run** (`rag-ingest` assistant) invoked by the monolith through
  the same platform API, keeping everything on the official server (no custom HTTP server).

## 3. Transport & Contract (the long-term asset)

We deliberately do **not** add a separate broker (that would duplicate the platform's built-in
queue/streaming — the inconsistency flagged in review). The contract is:

- **Monolith → Agent:** `langgraph-sdk`:
  - `client.threads.create()` / `client.threads.get()`
  - `client.runs.create(threadId, assistantId, { input, stream: true })` → async iterator of
    streaming events (tokens, tool calls, result).
  - `client.runs.create(...)` for the `rag-ingest` assistant.
- **Agent → Monolith (tools):** outbound HTTPS to internal endpoints:
  - `POST /internal/agent/tools/run` — execute an `agentActionTool` (monolith owns logic).
  - `GET  /internal/agent/quota` + `POST /internal/agent/usage` — quota gate + usage reporting.
  - `GET  /internal/agent/profile/:id` — RAG source data on ingest.
- All internal endpoints behind a service token (shared secret / mTLS). The **typed graph
  input/output schema** (assistant input, stream event shapes, tool arg/result shapes) is the
  durable contract — defined once in the Python service and mirrored as TS types in the monolith's
  `AgentClient` adapter.

## 4. RAG Redesign → Qdrant (multi-provider embeddings)

- Replace `BusinessProfileChunk` (pgvector) with **Qdrant**: one collection, points carrying a
  `businessProfileId` payload filter (optionally `chunkType` payload for partial re-ingest).
- Port `chunker.ts` → Python; keep the **hybrid retrieval** (vector + lexical) using Qdrant vector
  search + payload keyword `match` with RRF fusion (mirrors current vector+ILIKE+core behavior).
- **Embeddings are provider-agnostic** via LangChain embedding abstraction
  (`langchain-embeddings-*`) with config-driven provider selection (OpenAI / Google / Voyage / …).
  No Google lock-in; provider chosen by env/config.
- Ingestion: monolith invokes the `rag-ingest` assistant via the platform API, passing the profile
  payload (or the agent fetches source via the §3 profile endpoint). The agent chunks → embeds →
  upserts to Qdrant within that run. `partial` mode upserts only affected `chunkType` points.
- At cutover, drop the `BusinessProfileChunk` table and the pgvector column from the monolith.
- Quota/usage enforcement stays in the monolith (it owns billing) and is enforced on ingest and on
  run submission via the tool/quota endpoints.

## 5. Multi-provider LLM / Agent Runtime

- Port `modelRuntime`, `pipelineRuntime`, `agentGraphV2`, and the nodes to Python LangGraph,
  compiled and served by `langgraph-api` (declared in `langgraph.json`).
- Use a **provider-agnostic chat-model layer**: LangChain `init_chat_model` + a config-driven
  provider router supporting Anthropic / OpenAI / Google / Vertex behind one interface. Provider
  swap = env/config change, no code change. Matches current multi-provider posture.
- Graph persistence, checkpointing, and streaming are provided by the platform — the custom
  `PostgresSaver` checkpointer is deleted (platform manages its own Postgres).

## 6. Tool / Side-effect Handling (official tool-calling model)

- `agentActionTools.ts` becomes Python tool functions that **HTTP-call the monolith's internal
  endpoints** (§3). The monolith is the **tool executor**: it runs the real business action (the
  existing implementations) and returns the result. The agent service only declares tool
  names/schemas and forwards calls.
- No business logic is rewritten; the monolith keeps ownership.

## 7. What Moves vs Stays

**Moves to the LangGraph service:** graph definition, nodes, model runtime, RAG service + chunker,
embedding calls, agent action **tool schemas/declarations** (the HTTP wrappers). Persistence,
queue, streaming, and HTTP server are provided by `langgraph-api`.

**Stays in monolith:** all business logic behind tools, billing/quota, RAG source data, the
`ai-agent/chat/*` reply orchestration (becomes a caller), all 13 existing callers
(`admin/ai-pipeline`, `business`, `content`, `follow-up`, `integrations`, `media`, `meta`,
`order-confirmation`, `widget`, etc.), Socket.io streaming layer, and the `AgentClient` (SDK
wrapper).

**Deleted at cutover:** `ai-agent/core/*`, `ai-agent/nodes/*`, `ai-agent/rag/*`,
`ai-agent/core/agentActionTools.ts`, custom `PostgresSaver` checkpointer, `BusinessProfileChunk`
table + pgvector.

## 8. Migration Strategy (strangler-fig, zero-downtime)

1. **Stand up infra:** docker compose for `langgraph-api` (Python) + its Postgres + Redis + Qdrant.
   Deploy the ported graph via `langgraph.json`; smoke-test via the SDK.
2. **Add `AgentClient`** in the monolith (thin `langgraph-sdk` wrapper) behind a per-caller
   `USE_AGENT_SERVICE` flag. The old in-process path remains the fallback.
3. **Flip lowest-risk caller first** (recommend `admin/ai-pipeline` or `widgetChat` to exercise
   streaming). Verify outputs against recorded replays.
4. **Migrate remaining callers** one at a time (the 13 identified modules), keeping the flag as
   instant rollback.
5. **RAG dual-write:** during migration, monolith still writes pgvector; agent also ingests to
   Qdrant via the `rag-ingest` run. After stable, cut over reads to Qdrant and drop pgvector table.
6. **Decommission:** once all callers flipped and stable, delete the moved TS files and the
   `PostgresSaver` checkpointer.

## 9. Testing & Rollback

- **Contract tests:** `AgentClient` against the platform's API (mocked SDK); agent tools against
  monolith test endpoints.
- **Replay tests:** recorded conversations run through both paths; diff graph outputs.
- **Integration:** monolith `AgentClient` against a test LangGraph deployment; agent tools against
  monolith test endpoints.
- **Rollback:** flip `USE_AGENT_SERVICE` back per caller → in-process path resumes; agent service
  idles. No data loss (monolith Postgres untouched except dropped pgvector at final cutover).

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| ELv2 license (source-available) | Accepted for internal use; fallback §12 if strict OSS required |
| Streaming reassembly in monolith | Build `AgentClient` token-buffering first; cover with replay tests |
| Behavior drift vs current graph | Replay-diff suite gates each caller flip |
| Qdrant retrieval parity vs pgvector | Dual-run retrieval, compare top-k before cutover |
| Provider-abstraction gaps | Pin supported providers; config schema validated at boot |
| Platform-managed Postgres coupling | Keep platform Postgres isolated from monolith Postgres |

## 11. Open Follow-ups (future slices)

- Migrate `copilot` graph to the same service.
- Migrate `meta` / `order-confirmation` LLM paths.
- If strict 100% permissive OSS is later required: switch the runtime to embedded MIT `langgraph`
  + `langgraph-checkpoint-postgres` in a thin FastAPI service (Path B fallback), reintroducing a
  small amount of server glue.
