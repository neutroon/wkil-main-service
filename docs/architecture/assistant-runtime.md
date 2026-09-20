# Assistant runtime and local runbook

The supported chat path is Next.js/assistant-ui → TypeScript `/v1/assistant` →
Python LangGraph Agent Server. Mobile clients use the same authenticated gateway.
LangChain provider, message, tool, embedding, splitter, and Qdrant packages are
used inside the Python workflows. Explicit LangGraph nodes retain quota checks,
context loading, bounded tool loops, human approval, and usage recording.

## Ownership

| Layer | Owns |
| --- | --- |
| assistant-ui and `@assistant-ui/react-langgraph` | Composer, messages as rendered from graph state, stream/run UI, selection, tool and approval presentation |
| App integration | Session/CSRF transport, workspace context, localization/RTL, URL selection, product renderers |
| TypeScript gateway | Authentication, workspace/business-profile authorization, canonical tenant input, allowed paths/payloads, private Agent Server credentials, SSE forwarding |
| Agent Server | Threads, checkpoints/history, run lifecycle, durable graph state, persisted interrupts, cancellation |
| Python graphs | Orchestration, model calls, validated tools, reducers, RAG, approvals before effects |
| TypeScript business services | Business authorization, database mutations, billing, external integrations and irreversible effects through authenticated callbacks |

Application code does not add a parallel message store, SSE parser, Next.js
agent proxy, or AssistantCloud persistence layer. The gateway strips/rejects
client overrides and supplies authenticated user, workspace, and business-profile
identifiers. Agent Server custom auth stamps and scopes threads by owner/workspace.
Caller credentials for interactive traffic and backend jobs are distinct.

Relevant implementation: `app/src/lib/assistanceClient.ts`,
`app/src/components/user/copilot/overlay/CopilotRuntime.tsx`,
`back-end/src/modules/ai-agent/assistant.gateway.ts`, and
`agent-svc/src/agent_svc/security.py`. Paths in this page are relative to the
parent directory containing the three repositories.

## Conversation lifecycle

1. The user signs in and selects a workspace. The remote thread adapter lists
   only that workspace's threads. Opening the welcome screen creates no thread.
2. First send lazily creates a thread and streams the latest human message through
   the gateway. The SDK consumes `messages`, `updates`, and `custom` events, and
   assistant-ui renders them. The gateway fixes the permitted assistant and tenant
   context; browser-supplied identities cannot replace them.
3. Opening a thread or refreshing its `threadId` URL loads Agent Server state:
   messages, persisted `ui` events, and pending interrupts (top-level or in tasks).
   Rename/delete persist through the same gateway. LangGraph has no archive state,
   so the current adapter's archive/unarchive methods are no-ops.
4. Editing a human message or regenerating a response requests history using
   SDK `threads.getHistory`, which sends `POST /threads/{id}/history`. The gateway
   accepts an optional limit of 1–100, defaulting to 10. The frontend matches the
   exact ordered stable message IDs and message count for the parent history,
   then supplies that checkpoint as SDK `checkpointId`. SDK 1.11.0 serializes it
   as scalar `checkpoint_id`. Edited human input remains a one-message run;
   regeneration sends SDK `input: null` so Agent Server continues from that
   checkpoint without fabricating another human message. If there is no exact
   stable-ID checkpoint match, the frontend finishes the attempted reload
   locally and does not issue a server run. The gateway rejects arbitrary
   config/namespaces and the legacy nested `checkpoint` object. The lookup returns
   null when there is no exact match; current history lookup is bounded, not a
   full-history pagination search.
5. A write tool raises a LangGraph interrupt before its effect. The existing tool
   UI shows the proposal, and refresh restores it. Approve/reject sends top-level
   `command: { resume: ... }` on the same thread, with no new human input or
   checkpoint selector. Rejection has no write effect; approved callbacks use
   stable operation/idempotency identifiers across replay.
6. Stop aborts the SDK stream. The gateway propagates premature disconnect through
   its AbortController and forces `on_disconnect: "cancel"` upstream. The
   allow-listed cancel endpoint accepts interrupt cancellation. This stops
   unfinished work; it cannot undo a business effect already committed. No extra
   assistant message is fabricated to represent an abort.
7. Switching workspaces remounts the runtime and changes the workspace-scoped
   client and thread list. An old workspace's deep link cannot bypass server
   authorization. Login, navigation, business ownership, English/Arabic layout,
   and RTL remain in the existing application flow.

## External-action continuations

An integration-action worker keeps the complete external result in its backend
action-run response/audit envelope, then starts the existing persistent
`customer_agent` thread with one transient `external_action_result` value in
Agent Server run `context`. It does not replay the original customer message,
copy backend history, or put tenant/conversation identity in that envelope;
canonical identity remains in graph state and server authorization.

The model-facing projection is deterministic and JSON-only. Both the backend
TypeScript boundary and `agent-svc` Python schema enforce the same limits:

| Field | Limit |
| --- | ---: |
| compact UTF-8 serialized `context` | 16,384 bytes |
| `actionType` / `reason` / `error` | 128 / 256 / 512 Unicode code points |
| nested data depth | 5 container levels |
| object keys / array items | 32 each |
| nested data strings / keys | 1,024 / 128 Unicode code points |

Long strings, keys, arrays, objects, and deep containers are reduced with the
stable `[truncated]` marker while preserving valid JSON; object keys are ordered
deterministically. Cycles, non-JSON values, non-finite or unsafe numbers, and
unpaired Unicode surrogates are rejected before `runs.create`. The projection
is only the bounded model context: the full envelope remains available to the
backend action-run audit and status persistence.

## Installation and private configuration

Use Node 24 (the backend manifest's engine), pnpm, Python 3.11+, uv, and Docker
Desktop. Run commands from the directory containing the three sibling repositories,
including when working in the coordinated feature worktrees:

```powershell
uv sync --project agent-svc --locked --extra dev
npm --prefix back-end ci
pnpm --dir app install --frozen-lockfile
```

Prepare untracked local environment files from the server examples, preserving
any existing files. The backend's [README](../../README.md) covers database and
migration setup; `src/config/env.ts` is authoritative for current required values.
Its business database and Redis must be available before starting it. Agent
Server's Postgres database is separate from the business database.

| Configuration | Where and purpose |
| --- | --- |
| `LANGGRAPH_API_KEY` | Private backend + agent value for authenticated interactive gateway traffic |
| `MONOLITH_AGENT_API_KEY` | Different private backend + agent value for background jobs |
| `MONOLITH_SERVICE_TOKEN` | Separate private backend + agent value for tool callbacks |
| `GOOGLE_API_KEY` | Agent provider credential required by the current Compose configuration; host development may select another supported provider |
| `POSTGRES_PASSWORD` | Required by Compose for the agent database |
| `LANGGRAPH_API_URL` | Backend Agent Server URL, default `http://localhost:8123` |
| `MONOLITH_TOOL_BASE_URL` | Agent callback URL: Compose uses `http://host.docker.internal:8080/internal/agent`; host development uses `http://localhost:8080/internal/agent` |
| `NEXT_PUBLIC_API` | Browser's public gateway URL, default `http://localhost:8080`; never an Agent Server credential |

The backend uses Agent Server directly for background agent-service paths. Keep
auth/CORS configuration aligned with the browser origin. Changing port 8080
requires updating the browser gateway URL and the agent callback URL. Changing
port 8123 requires updating the backend Agent Server URL.

## Default: Docker Agent Server

Start the agent dependencies and then its pinned server:

```powershell
docker compose --env-file agent-svc/.env -f agent-svc/docker-compose.yml up -d postgres redis qdrant
docker compose --env-file agent-svc/.env -f agent-svc/docker-compose.yml up -d --build langgraph-api
```

Wait for `http://localhost:8123/ok` to respond, then run each command below in its
own terminal. Start sending chat messages only once the backend is also ready:

```powershell
npm --prefix back-end run dev
pnpm --dir app dev
```

The Dockerfile pins Agent Server 0.13.2 and the lock constrains its paired runtime.
The entrypoint validates credentials, loads graphs/custom auth from `langgraph.json`,
and delegates to the base image. Graph exports are compiled without an application
checkpointer; Agent Server supplies persistence. This local Compose file has no
named data volumes, so it is not a production storage/backup configuration. Retain
containers to retain their local data and provision durable storage for deployment.

## Alternative: host development with hot reload

Choose this instead of the Docker Agent Server, never alongside it. Start only
Qdrant from Compose for graph retrieval. If the Docker Agent Server is already
running, stop its `langgraph-api` service before selecting this alternative.

The project lock does not install `langgraph-cli`. The following command installs
a pinned CLI into uv's temporary tool environment while keeping the project lock
unchanged and retaining Agent Server 0.13.2. `--port 8123` preserves the gateway URL;
the CLI's upstream default is 2024. `--directory agent-svc` changes the working
directory so graph, auth, and `.env` paths in the manifest resolve inside the agent
repository. `--project` alone does not change that directory. UTF-8 avoids Windows
console encoding errors.

```powershell
docker compose --env-file agent-svc/.env -f agent-svc/docker-compose.yml up -d qdrant
$env:PYTHONUTF8 = "1"
uv run --directory agent-svc --locked --with "langgraph-cli[inmem]==0.4.31" --with "langgraph-api==0.13.2" langgraph dev --config langgraph.json --port 8123 --no-browser
```

Use the host callback URL from the table and configure the selected model and
embedding provider keys in `agent-svc/.env`. Then start the backend and app using
the same commands as the Docker path. Development state uses local in-memory/
disk storage, not Docker Postgres; switching server modes does not share history.
The real CLI's parsed manifest has been checked at its server-launch boundary:
all four graphs and custom auth import from the agent repository, and `.env`
resolves there. Live startup and complete chat behavior still require configured
local services and credentials.

## Optional server-side LangSmith

In `agent-svc/.env`, or deployment server secrets/environment, use:

```dotenv
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=wkil-agent-svc
```

Tracing is opt-in. Compose forwards these values with disabled/blank defaults.
For trace export, set tracing to `true`, provide the private key, and restart or
recreate the server. The Python LangGraph/LangChain path supplies model and tool
tracing. The assistant-ui AI SDK `wrapAISDK` guide describes a different backend
integration and is not applied here. No additional frontend tracing dependency
or public key is needed. Trace data may contain conversation/tool inputs and
outputs, so opt in only for data intended for the configured LangSmith project.

With credentials available, send one authorized chat request, inspect its graph,
model/tool spans, timings, and outputs in the selected project. Without credentials,
only configuration/behavior checks can pass; dashboard delivery remains unverified.

## Verification and documentation sources

From `agent-svc`, run `uv run --locked --extra dev pytest -q
tests/test_observability_config.py` to render real Compose configuration with
controlled dummy inputs: tracing unset, `.env.example`, and explicit opt-in. Docker
Compose CLI is required, but no daemon, provider request, or LangSmith key is used.
Run `uv lock --check`, the full pytest suite, and `ruff check src tests` through uv
for the agent checks; use `npm --prefix back-end run docs:check` from the parent for
OpenAPI lint, route alignment, and bundle validation.

Check browser code and environment files without printing secret values:

```powershell
rg -l "LANGSMITH_API_KEY|LANGGRAPH_API_KEY|MONOLITH_AGENT_API_KEY|MONOLITH_SERVICE_TOKEN" app/src
rg -l --hidden "LANGSMITH_API_KEY|LANGGRAPH_API_KEY|MONOLITH_AGENT_API_KEY|MONOLITH_SERVICE_TOKEN" app -g ".env*" -g "!*.example" -g "!node_modules/**" -g "!.next/**"
```

Both scans should have no matches (ripgrep exit 1). Review tracked environment
files and `NEXT_PUBLIC_*` mappings before delivery. Authentication, create/list/load,
stream, cancel, approval restore/resume, and cross-workspace denial must also be
checked against running services; a static/docs check does not prove those live gates.

Source of truth consulted for this runbook:

- [assistant-ui LangGraph runtime](https://www.assistant-ui.com/docs/runtimes/langgraph/overview),
  [interrupts and checkpoints](https://www.assistant-ui.com/docs/runtimes/langgraph/interrupts),
  and [LangSmith integration boundary](https://www.assistant-ui.com/docs/integrations/observability/langsmith).
- [LangSmith self-hosted environment](https://docs.langchain.com/langsmith/env-var-self-hosted),
  [LangChain tracing](https://docs.langchain.com/langsmith/trace-with-langchain),
  [project selection](https://docs.langchain.com/langsmith/log-traces-to-project),
  and [Agent Server local development](https://docs.langchain.com/langsmith/local-dev-testing).

The assistant-ui and LangChain/LangGraph MCP documentation servers are references
used during implementation. This architecture does not ship product MCP tools,
user-managed MCP servers, or an MCP settings screen.
