# Design: Extract `ai-agent` core into an event-driven Python LangGraph microservice

**Date:** 2026-08-25
**Status:** Approved (design), pending spec review
**Author:** Architecture brainstorming session

## 1. Goal & Scope

Migrate the **`ai-agent` core** module of the `wkil-backend` monolith into a standalone,
officially self-hosted **LangGraph (Python)** microservice in order to:

- Remove hand-rolled LangGraph orchestration/runtime code (custom `StateGraph`, `PostgresSaver`
  checkpointer, `modelRuntime`, queue wiring) that introduces bugs.
- Adopt the official `langgraph/langgraph-api` server (self-hosted) for the graph runtime,
  persistence, streaming, and worker management.
- Decouple the agent from the monolith via an **event-driven broker** so each side scales and
  deploys independently.
- Replace Postgres/pgvector RAG with a dedicated **Qdrant** vector store.
- Be **provider-agnostic** for LLM and embeddings (no Google lock-in) — multi-provider from day one.

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

## 2. Architecture (event-driven, broker-based)

```
┌──────────────────────────┐        Redis Streams         ┌──────────────────────────────┐
│  TS Monolith (existing)  │ ─── agent.task.submit ─────▶ │  Python LangGraph service     │
│  - business logic        │                               │  (langgraph/langgraph-api)    │
│  - billing / quota       │ ◀── agent.task.token --------│  - graph (ported from TS)     │
│  - RAG source data       │ ◀── agent.task.completed ----│  - built-in checkpointer      │
│  - tool executor         │ ◀── agent.task.failed -------│  - Qdrant (RAG)               │
│                          │                               │  - Redis (platform state)     │
│  publish rag.ingest ───▶ │                               └───────────────┬──────────────┘
│  consume tool_request ◀─ │ ◀── agent.task.tool_request ───────┐          │
│  publish tool_response ─│ ───────────────────────────────────┘          │ upsert/query
└──────────────────────────┘                                              ▼
        │                                         Qdrant (agent service owns)
        └── Postgres (shared, monolith-only access; BusinessProfileChunk dropped at cutover)
```

- The monolith **never calls the agent synchronously**. It publishes a task carrying a
  `correlationId`, then subscribes to `agent.task.result.{correlationId}` and reassembles
  streamed tokens / final state for Socket.io or HTTP SSE.
- The Python service consumes tasks, runs the graph (with built-in persistence + streaming),
  and publishes progress and result events back.
- Tool execution is **fully event-driven**: when the graph needs a business action, the Python
  service publishes `agent.task.tool_request`; the monolith executes the real logic and publishes
  `agent.task.tool_response`.

## 3. Broker: Redis Streams

- Reuse the **existing Redis** (already run for BullMQ/cache-bus). BullMQ job consumers are
  Node-only, so the Python service consumes **native Redis Streams** (`XADD`/`XREAD`/`XGROUP`),
  not BullMQ jobs. Both `ioredis` (TS) and `redis`/`redis.asyncio` (Python) support this.
- **Contract is broker-agnostic**: events are plain JSON payloads. Swapping to Kafka or NATS
  JetStream later requires only a transport adapter, not service logic changes.
- One task stream + consumer groups per event type; `correlationId` used for result routing and
  idempotency.

## 4. Event Contract (the long-term asset)

Defined as JSON Schema + Pydantic models (Python) and generated TS types (monolith). Versioned
(`schemaVersion`). Core events:

| Event | Direction | Key fields |
|-------|-----------|------------|
| `agent.task.submit` | mono → agent | `correlationId`, `threadId`, `userId`, `businessProfileId`, `input`, `mode`, `schemaVersion` |
| `agent.task.token` | agent → mono | `correlationId`, `delta` (streaming chunk) |
| `agent.task.tool_request` | agent → mono | `correlationId`, `tool`, `args`, `toolCallId` |
| `agent.task.tool_response` | mono → agent | `correlationId`, `toolCallId`, `result` |
| `agent.task.completed` | agent → mono | `correlationId`, `output`, `usage` |
| `agent.task.failed` | agent → mono | `correlationId`, `error`, `stage` |
| `rag.ingest` | mono → agent | `businessProfileId`, `mode` (`full`\|`partial`), `updatedFields?` |
| `rag.ingest.done` | agent → mono | `businessProfileId`, `chunkCount` |

Result routing: monolith subscribes to `agent.task.result.{correlationId}` (a stream per
correlation id, or a single stream filtered by `correlationId` field) to receive `token`,
`completed`, `failed`. `tool_request`/`tool_response` use a shared request/response stream keyed
by `toolCallId`.

## 5. RAG Redesign → Qdrant (multi-provider embeddings)

- Replace `BusinessProfileChunk` (pgvector) with **Qdrant**: one collection, points carrying a
  `businessProfileId` payload filter (optionally `chunkType` payload for partial re-ingest).
- Port `chunker.ts` → Python; keep the **hybrid retrieval** (vector + lexical) using Qdrant vector
  search + payload keyword `match` with RRF fusion (mirrors current vector+ILIKE+core behavior).
- **Embeddings are provider-agnostic** via LangChain embedding abstraction
  (`langchain-embeddings-*`) with config-driven provider selection (OpenAI / Google / Voyage / …).
  No Google lock-in; provider chosen by env/config.
- Ingestion: monolith publishes `rag.ingest` on profile create/update. Agent service fetches the
  needed source data via an internal monolith endpoint (or receives payload in the event),
  chunks → embeds → upserts to Qdrant. `partial` mode upserts only affected `chunkType` points.
- At cutover, drop the `BusinessProfileChunk` table and the pgvector column from the monolith.
- Quota/usage enforcement stays in the monolith (it owns billing) and is enforced on ingest and on
  `agent.task.submit` via a broker round-trip or pre-check.

## 6. Multi-provider LLM / Agent Runtime

- Port `modelRuntime`, `pipelineRuntime`, `agentGraphV2`, and the nodes to Python LangGraph.
- Use a **provider-agnostic chat-model layer**: LangChain `init_chat_model` + a config-driven
  provider router supporting Anthropic / OpenAI / Google / Vertex behind one interface. Provider
  swap = env/config change, no code change. Matches current multi-provider posture.
- Model selection (reasoning vs fast vs fallback) preserved from `aiEngine.utils`/`modelRuntime`.
- Graph persistence, checkpointing, and streaming are provided by the LangGraph platform — the
  custom `PostgresSaver` checkpointer is deleted.

## 7. Tool / Side-effect Handling (pure event-driven)

- `agentActionTools.ts` becomes Python tool functions that publish `agent.task.tool_request` to the
  broker. The monolith is the **tool executor**: it consumes `tool_request`, runs the real business
  action (the existing implementations in `ai-agent/core/agentActionTools.ts` and downstream
  modules), and publishes `tool_response`.
- No business logic is rewritten; the monolith keeps ownership. The agent service only declares
  tool names/schemas.
- Latency note: each tool call is one broker round-trip. If a specific tool proves latency-critical
  in production, a direct internal HTTP callback can be added later as an escape hatch — but the
  default is pure broker.

## 8. What Moves vs Stays

**Moves to Python service:** graph definition, nodes, model runtime, checkpointer (platform-built-in),
RAG service + chunker, embedding calls, agent action **tool schemas/declarations**.

**Stays in monolith:** all business logic behind tools, billing/quota, RAG source data, the
`ai-agent/chat/*` reply orchestration (becomes a caller), all 13 existing callers
(`admin/ai-pipeline`, `business`, `content`, `follow-up`, `integrations`, `media`, `meta`,
`order-confirmation`, `widget`, etc.), Socket.io streaming layer, and the `AgentEventClient`.

**Deleted at cutover:** `ai-agent/core/*`, `ai-agent/nodes/*`, `ai-agent/rag/*`,
`ai-agent/core/agentActionTools.ts`, custom `PostgresSaver` checkpointer, `BusinessProfileChunk`
table + pgvector.

## 9. Migration Strategy (strangler-fig, zero-downtime)

1. **Stand up infra:** docker compose for `langgraph-api` (Python) + Redis (existing) + Qdrant.
   Deploy the ported graph; smoke-test via a test publisher/consumer.
2. **Add `AgentEventClient`** in the monolith (publish/subscribe wrapper over Redis Streams) behind
   a per-caller `USE_AGENT_EVENTS` flag. The old in-process path remains the fallback.
3. **Flip lowest-risk caller first** (recommend `admin/ai-pipeline` or `widgetChat` to exercise
   streaming reassembly). Verify outputs against recorded replays.
4. **Migrate remaining callers** one at a time (the 13 identified modules), keeping the flag as
   instant rollback.
5. **RAG dual-write:** during migration, monolith still writes pgvector; agent also ingests to
   Qdrant via `rag.ingest`. After stable, cut over reads to Qdrant and drop pgvector table.
6. **Decommission:** once all callers flipped and stable, delete the moved TS files and the
   `PostgresSaver` checkpointer.

## 10. Testing & Rollback

- **Contract tests:** each event type validated against schema on both sides (Pydantic + TS).
- **Replay tests:** recorded conversations run through both paths; diff graph outputs.
- **Integration:** monolith `AgentEventClient` against a fake/stub agent consumer; agent tools
  against monolith test endpoints.
- **Rollback:** flip `USE_AGENT_EVENTS` back per caller → in-process path resumes; agent service
  idles. No data loss (Postgres untouched except dropped pgvector at final cutover).

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Broker round-trip latency for tools | Start with non-latency-critical callers; add HTTP escape hatch if needed |
| Streaming reassembly complexity in monolith | Build `AgentEventClient` token-buffering first; cover with replay tests |
| Behavior drift vs current graph | Replay-diff suite gates each caller flip |
| Qdrant retrieval parity vs pgvector | Dual-run retrieval, compare top-k before cutover |
| Provider-abstraction gaps | Pin supported providers; config schema validated at boot |

## 12. Open Follow-ups (future slices)

- Migrate `copilot` graph to the same service.
- Migrate `meta` / `order-confirmation` LLM paths.
- Consider Kafka/NATS if durability/scale demands exceed Redis Streams.
