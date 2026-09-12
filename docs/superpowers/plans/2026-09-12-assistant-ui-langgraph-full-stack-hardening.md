# Assistant UI + LangGraph Full-Stack Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. The user explicitly selected fresh implementation subagents with independent task reviews. Use `superpowers:using-git-worktrees` for isolation before Task 1.

**Goal:** Deliver and verify one production-shaped chat path in which assistant-ui owns the web chat experience, the authenticated TypeScript gateway owns client access and tenant scoping, and LangGraph Agent Server owns durable execution, checkpoints, interrupts, and streaming.

**Architecture:** Keep the existing three-tier boundary: Next.js/assistant-ui -> Express `/v1/assistant` gateway -> Python LangGraph Agent Server. Add the missing checkpoint-history contract needed for safe edit/regenerate, compile every registered graph for deployment without an application checkpointer, repair the current checkout's dependency installation, and verify existing streaming, cancellation, HITL, tool, RAG, and workspace-isolation behavior without introducing parallel state stores or protocols.

**Tech Stack:** Next.js 15.5, React 19, assistant-ui 0.15.x, `@assistant-ui/react-langgraph`, LangGraph JS SDK 1.10.x, Express 5, Vitest, Python 3.11+, LangGraph 1.2.x, LangChain Core/provider packages, LangGraph Agent Server 0.13.2, Qdrant, pytest, Ruff, LangSmith.

**Spec:** `back-end/docs/superpowers/specs/2026-09-12-assistant-ui-langgraph-full-stack-hardening-design.md`

## Global Constraints

- Run commands from `D:\wkil` unless a step explicitly changes the working directory.
- Execute from coordinated `app`, `back-end`, and `agent-svc` worktrees on matching feature branches. Record their absolute paths and base SHAs in the SDD ledger before Task 1.
- Dispatch exactly one implementation subagent at a time because all agents share the filesystem. After each implementation, dispatch a separate read-only reviewer; resolve Critical/Important findings through the bounded fix/re-review loop before continuing.
- Give subagents task briefs and report/review-package file paths from this plan's `.superpowers/sdd/<plan-name>/` workspace. Do not paste the complete plan or accumulated chat history into their prompts.
- Before each implementation task, re-read the named skills and the exact MCP resources listed in the approved spec. Installed package types decide ambiguous method signatures.
- Use `superpowers:test-driven-development` for every behavior change: add one focused failing test, observe the expected failure, implement the minimum change, then observe it pass.
- Use `superpowers:systematic-debugging` for unexpected failures. Do not paper over dependency, environment, or test-runner problems.
- Preserve the three independent Git histories in `app`, `back-end`, and `agent-svc`. Never include unrelated user changes in a task commit.
- Update the Durable Execution Ledger at the bottom of this file after every completed task with the command, result, and commit SHA. That ledger is the fallback after context compaction.
- Do not add AssistantCloud, a second frontend message store, a custom SSE parser, a Next.js agent proxy, browser-visible service keys, product MCP configuration, or a plain `create_agent` replacement for the explicit graphs.
- Do not upgrade `langgraph-api` independently of its paired Agent Server runtime/image. Keep 0.13.2 unless a separate compatibility migration is approved.
- Treat missing provider credentials as a named unverified live smoke gate, never as a passing result.

## Task 1: Repair and Reconcile the Frontend Dependency Installation

**Skills:** `setup`, `update`, `langchain-dependencies`, `superpowers:systematic-debugging`

**MCP sources:** `assistant-ui://docs/installation`, `assistant-ui://docs/cli`, `assistant-ui://docs/migrations/v0-15`, `langchain://llms.txt`

**Files:**

- Modify: `app/package.json`
- Modify: `app/pnpm-lock.yaml`
- Verify only: `app/src/**/*.{ts,tsx}`

1. Record the broken-install evidence before changing dependencies:

   ```powershell
   Get-Item app\node_modules\vitest -ErrorAction SilentlyContinue | Select-Object FullName,LinkType,Target
   pnpm --dir app exec vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx
   ```

   Expected: the link target references the previous checkout or Vitest fails before test discovery because a linked package cannot be resolved.

2. Recreate the installation from the committed lockfile in the current checkout:

   ```powershell
   pnpm --dir app install --force --frozen-lockfile
   ```

3. Confirm every inspected junction now resolves beneath `D:\wkil\app`:

   ```powershell
   Get-Item app\node_modules\vitest,app\node_modules\@assistant-ui\react | Select-Object FullName,LinkType,Target
   ```

4. Query the live registry immediately before updating. If the versions remain compatible with the approved baseline, record exact patch versions:

   ```powershell
   pnpm view @assistant-ui/react version
   pnpm view @assistant-ui/react-langgraph version
   pnpm view @assistant-ui/react-markdown version
   pnpm view @langchain/langgraph-sdk version
   ```

5. Install the approved compatible patch set exactly. The audited set is:

   ```powershell
   pnpm --dir app add --save-exact @assistant-ui/react@0.15.19 @assistant-ui/react-langgraph@0.14.27 @assistant-ui/react-markdown@0.14.15 @langchain/langgraph-sdk@1.10.2
   ```

   If the registry has moved, stop and compare peer ranges and migration notes before substituting versions.

6. Run assistant-ui diagnostics and the focused baseline tests:

   ```powershell
   pnpm --dir app dlx assistant-ui@latest info
   pnpm --dir app dlx assistant-ui@latest doctor
   pnpm --dir app exec vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx
   pnpm --dir app exec tsc --noEmit
   ```

7. Inspect `git -C app diff -- package.json pnpm-lock.yaml`; ensure only the intended package entries changed.

8. Commit in `app`:

   ```powershell
   git -C app add package.json pnpm-lock.yaml
   git -C app commit -m "chore: repair and update assistant ui dependencies"
   ```

## Task 2: Add the Tenant-Scoped Checkpoint History Gateway Contract

**Skills:** `runtime`, `streaming`, `langgraph-persistence`, `langchain-dependencies`, `superpowers:test-driven-development`

**MCP sources:** `assistant-ui://docs/runtimes/langgraph/interrupts`, `assistant-ui://docs/runtimes/langgraph/quickstart`, `https://reference.langchain.com/javascript/langchain-langgraph-sdk.md`

**Files:**

- Modify: `back-end/src/modules/ai-agent/assistant.gateway.test.ts`
- Modify: `back-end/src/modules/ai-agent/assistant.gateway.ts`
- Modify if the documented route surface is explicit: `back-end/docs/openapi.yaml`
- Regenerate if OpenAPI changes: `app/src/types/openapi.generated.ts`

1. Add a failing allow-list test proving that only the SDK history operation is exposed:

   ```ts
   expect(endpointFor(["threads", "thread-1", "history"], "POST")).toBe("history");
   expect(endpointFor(["threads", "thread-1", "history"], "GET")).toBeUndefined();
   ```

2. Add failing normalization tests proving history pagination is bounded and client identity/unknown fields are rejected. Accept only the fields present in the installed SDK `ThreadStateSearch` type; at minimum, enforce `limit` as an integer from 1 through 100.

3. Add failing run-normalization tests for checkpoint forking:

   ```ts
   expect(normalizeBody("run", {
     assistant_id: "agent",
     input: { messages: [{ type: "human", content: "edited" }] },
   checkpoint_id: "cp-123",
   }, scope)).toMatchObject({
     checkpoint_id: "cp-123",
   });
   ```

   Also prove the legacy/nested `checkpoint` object, blank IDs, oversized IDs, client-supplied thread namespaces, and checkpoint IDs on approval resumes are rejected unless later installed SDK/documentation requires them.

4. Run the focused test and observe the intended failures:

   ```powershell
   npm --prefix back-end test -- src/modules/ai-agent/assistant.gateway.test.ts
   ```

5. Extend `GatewayEndpoint` with `"history"` and add exactly this path/method shape to `endpointFor`:

   ```ts
   if (parts.length === 3 && parts[2] === "history" && method === "POST") {
     return "history";
   }
   ```

6. Add a dedicated history body normalizer. It must return a new object, bound `limit`, and copy only SDK-documented pagination/filter fields. It must never accept `user_id`, `workspace_id`, `assistant_id`, or arbitrary metadata from the browser.

7. Add a dedicated checkpoint-ID normalizer for runs. SDK 1.11.0 accepts `checkpointId` in TypeScript and sends the scalar `checkpoint_id` field on the wire:

   ```ts
   function normalizeCheckpointId(value: unknown): string | undefined {
     if (value === undefined) return undefined;
     if (typeof value !== "string") {
       throw new AppError("Invalid checkpoint", 400, true, "INVALID_CHECKPOINT");
     }
     const checkpointId = value.trim();
     if (!checkpointId || checkpointId.length > 256) {
       throw new AppError("Invalid checkpoint", 400, true, "INVALID_CHECKPOINT");
     }
     return checkpointId;
   }
   ```

8. Accept `checkpoint_id` in the run field allow-list and forward the normalized scalar only for a new/edited human run. Preserve the current top-level `command.resume`, tenant-derived input, stream mode, `on_disconnect: "cancel"`, and `multitask_strategy: "reject"` behavior. Continue rejecting the older `checkpoint` object.

9. Re-run the focused test, then the client contract test:

   ```powershell
   npm --prefix back-end test -- src/modules/ai-agent/assistant.gateway.test.ts src/modules/ai-agent/client/agent.client.test.ts
   ```

10. If the gateway routes are enumerated in OpenAPI, add `POST /v1/assistant/threads/{threadId}/history`, run:

    ```powershell
    npm --prefix back-end run docs:check
    npm --prefix back-end run types:api
    ```

11. Commit gateway changes in `back-end`; commit regenerated API types separately in `app` if produced:

    ```powershell
    git -C back-end add src/modules/ai-agent/assistant.gateway.ts src/modules/ai-agent/assistant.gateway.test.ts docs/openapi.yaml
    git -C back-end commit -m "feat: proxy langgraph checkpoint history safely"
    ```

## Task 3: Wire Safe Edit and Regenerate Through Server Checkpoints

**Skills:** `assistant-ui`, `runtime`, `thread-list`, `primitives`, `elements`, `streaming`, `superpowers:test-driven-development`

**MCP sources:** `assistant-ui://docs/runtimes/langgraph/threads`, `assistant-ui://docs/runtimes/langgraph/interrupts`, `assistant-ui://docs/guides/editing`, `assistant-ui://docs/primitives/action-bar`

**Files:**

- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.tsx`
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx`
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.test.tsx`
- Verify only: `app/src/components/thread.tsx`
- Verify only: `app/src/lib/assistanceClient.ts`

1. Add a pure exported helper and failing tests for exact stable-ID history matching:

   ```ts
   export function checkpointForMessages(
     history: readonly ThreadState[],
     parentMessages: readonly LangChainMessage[],
   ): string | null;
   ```

   Cover exact ordered ID match, different length, missing IDs, reordered IDs, and missing checkpoint ID. Never fall back to content comparison.

2. Add a runtime-hook test proving `getCheckpointId(threadId, parentMessages)` calls `client.threads.getHistory(threadId)` and returns the pure helper result.

3. Add a stream test proving assistant-ui's `config.checkpointId` is passed to SDK 1.11.0 using its typed camelCase option; the SDK maps this to wire-level `checkpoint_id`:

   ```ts
   checkpointId: checkpointId ?? undefined
   ```

   Confirm this exact property against `app/node_modules/@langchain/langgraph-sdk`; do not build the wire body manually.

4. Run the focused tests and observe the intended failures:

   ```powershell
   pnpm --dir app exec vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx
   ```

5. Implement `checkpointForMessages` exactly as the assistant-ui MCP example: iterate server history, require equal message counts, require string IDs on both sides, compare each ID in order, and return `state.checkpoint.checkpoint_id ?? null` for the first match.

6. Pass `getCheckpointId` to `useLangGraphRuntime`. Do not add edit/regenerate visibility state: assistant-ui enables `ActionBarPrimitive.Edit` and `ActionBarPrimitive.Reload` only when checkpoint lookup exists.

7. Destructure `checkpointId` in `stream` and forward it only in ordinary/edited human runs. Approval resumes retain top-level `command` semantics and do not accept an arbitrary checkpoint ID. Preserve `initialize()`, `abortSignal`, stream modes, and the one-new-human-message input.

8. Verify that `app/src/components/thread.tsx` still uses supported assistant-ui primitives for user edit composer and assistant reload. Do not redesign the component.

9. Re-run focused tests and typecheck:

   ```powershell
   pnpm --dir app exec vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx
   pnpm --dir app exec tsc --noEmit
   ```

10. Commit in `app`:

    ```powershell
    git -C app add src/components/user/copilot/overlay/CopilotRuntime.tsx src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx src/types/openapi.generated.ts
    git -C app commit -m "feat: fork edited assistant runs from checkpoints"
    ```

## Task 4: Export Deployment-Ready Compiled LangGraph Graphs

**Skills:** `ecosystem-primer`, `langgraph-fundamentals`, `langgraph-cli`, `langgraph-persistence`, `superpowers:test-driven-development`

**MCP sources:** `mintlify://skills/langchain`, `https://reference.langchain.com/python/langgraph.md`, `https://reference.langchain.com/python/langgraph-cli.md`

**Files:**

- Modify: `agent-svc/src/agent_svc/agent_graph.py`
- Modify: `agent-svc/src/agent_svc/customer_graph.py`
- Modify: `agent-svc/src/agent_svc/rag/rag_ingest_graph.py`
- Modify: `agent-svc/tests/test_agent_graph.py`
- Modify: `agent-svc/tests/test_customer_graph.py`
- Modify: `agent-svc/tests/rag/test_rag_ingest_graph.py`
- Verify only: `agent-svc/src/agent_svc/capability_graph.py`
- Verify only: `agent-svc/langgraph.json`

1. Replace the current “builder compiles” assertions with failing deployment-contract assertions that every object referenced by `langgraph.json` is a `CompiledStateGraph` (or the current public compiled graph type exposed by installed LangGraph).

2. Preserve a named `builder` for tests that require an explicit `MemorySaver`, and export a server-ready graph compiled without an application checkpointer:

   ```python
   builder = StateGraph(AgentState)
   # existing nodes and edges
   graph = builder.compile()
   ```

   Agent Server injects production persistence; do not attach `MemorySaver` or PostgresSaver to the exported graph.

3. Update checkpoint-specific tests to import `builder` and call `builder.compile(checkpointer=MemorySaver())`; production/deployment tests import `graph`.

4. Apply the same builder/compiled-export split to `customer_graph.py` and `rag_ingest_graph.py`. Keep `capability_graph.py` unchanged because it already exports a compiled graph.

5. Run focused tests:

   ```powershell
   uv run --project agent-svc pytest agent-svc/tests/test_agent_graph.py agent-svc/tests/test_customer_graph.py agent-svc/tests/rag/test_rag_ingest_graph.py -q
   ```

6. Validate all `langgraph.json` imports in one credential-independent process:

   ```powershell
   uv run --project agent-svc python -c "from agent_svc.agent_graph import graph as a; from agent_svc.customer_graph import graph as c; from agent_svc.rag.rag_ingest_graph import graph as r; from agent_svc.capability_graph import graph as p; print(*(type(x).__name__ for x in (a,c,r,p)))"
   ```

7. Commit in `agent-svc`:

   ```powershell
   git -C agent-svc add src/agent_svc/agent_graph.py src/agent_svc/customer_graph.py src/agent_svc/rag/rag_ingest_graph.py tests/test_agent_graph.py tests/test_customer_graph.py tests/rag/test_rag_ingest_graph.py
   git -C agent-svc commit -m "fix: export deployable compiled langgraph graphs"
   ```

## Task 5: Lock Down Graph Loop, Message, Interrupt, and Side-Effect Contracts

**Skills:** `langchain-fundamentals`, `langgraph-fundamentals`, `langgraph-human-in-the-loop`, `langgraph-persistence`, `superpowers:test-driven-development`

**MCP sources:** `mintlify://skills/langchain`, `https://reference.langchain.com/python/langchain-core.md`, `https://reference.langchain.com/python/langgraph.md`

**Files:**

- Modify: `agent-svc/tests/test_hitl_interrupt.py`
- Modify: `agent-svc/tests/test_agent_graph.py`
- Modify: `agent-svc/tests/test_customer_graph.py`
- Modify only if a new test fails: `agent-svc/src/agent_svc/nodes/call_model.py`
- Modify only if a new test fails: `agent-svc/src/agent_svc/nodes/run_action_tools.py`
- Modify only if a new test fails: `agent-svc/src/agent_svc/state.py`

1. Add structural tests, not exact model prose assertions, for all of these invariants:

   - `messages` uses the LangGraph `add_messages` reducer and `ui`/`usage_events` remain additive.
   - the ninth attempted model call produces a terminal AI message with no tool calls.
   - every executed, denied, unknown, or failed tool call emits one matching `ToolMessage.tool_call_id` in model-call order.
   - all write-tool interrupts are collected before any side effect executes.
   - rejection produces a ToolMessage and no business-service call.
   - approval after checkpoint resume executes each write at most once using the stable operation key.
   - the customer graph cannot execute owner-only tools.

2. Run the tests and observe whether any behavior gap is real:

   ```powershell
   uv run --project agent-svc pytest agent-svc/tests/test_agent_graph.py agent-svc/tests/test_customer_graph.py agent-svc/tests/test_hitl_interrupt.py -q
   ```

3. If a test fails, make the smallest production correction in the listed node/state files. Preserve top-level `interrupt()`/`Command(resume=...)`, existing `GraphBubbleUp` propagation, and the two-pass “resolve all decisions, then execute effects” structure.

4. Re-run the focused tests and Ruff:

   ```powershell
   uv run --project agent-svc pytest agent-svc/tests/test_agent_graph.py agent-svc/tests/test_customer_graph.py agent-svc/tests/test_hitl_interrupt.py -q
   uv run --project agent-svc ruff check src tests
   ```

5. Commit the tests and any minimal correction in `agent-svc`:

   ```powershell
   git -C agent-svc add tests/test_agent_graph.py tests/test_customer_graph.py tests/test_hitl_interrupt.py src/agent_svc/nodes/call_model.py src/agent_svc/nodes/run_action_tools.py src/agent_svc/state.py
   git -C agent-svc commit -m "test: enforce langgraph execution invariants"
   ```

## Task 6: Prove LangChain RAG Package and Embedding Consistency

**Skills:** `langchain-rag`, `langchain-dependencies`, `langchain-fundamentals`, `superpowers:test-driven-development`

**MCP sources:** `mintlify://skills/langchain`, `https://reference.langchain.com/python/langchain-text-splitters.md`, `https://reference.langchain.com/python/langchain-qdrant.md`

**Files:**

- Modify: `agent-svc/tests/rag/test_embeddings.py`
- Modify: `agent-svc/tests/rag/test_vector_store.py`
- Modify only if a new test fails: `agent-svc/src/agent_svc/rag/embeddings.py`
- Modify only if a new test fails: `agent-svc/src/agent_svc/rag/vector_store.py`
- Verify only: `agent-svc/src/agent_svc/rag/chunker.py`
- Verify only: `agent-svc/pyproject.toml`
- Verify/update lock only through uv: `agent-svc/uv.lock`

1. Add tests proving ingestion and retrieval obtain embeddings through the same provider/model factory and Qdrant collection configuration.

2. Add tests proving unknown providers fail closed and tenant filters include `metadata.business_profile_id` plus the active revision.

3. Run focused tests and observe failures before any production edit:

   ```powershell
   uv run --project agent-svc pytest agent-svc/tests/rag -q
   ```

4. If required, correct imports only through the dedicated packages already declared in `pyproject.toml`: `langchain-text-splitters`, provider packages, and `langchain-qdrant`. Do not add `langchain-community` or duplicate embedding construction.

5. Reconcile the Python environment and prove the lock is current without independently installing packages:

   ```powershell
   uv sync --project agent-svc --extra dev --extra server-compat --locked
   uv lock --project agent-svc --check
   ```

6. Re-run RAG tests and Ruff, then commit only if files changed:

   ```powershell
   uv run --project agent-svc pytest agent-svc/tests/rag -q
   uv run --project agent-svc ruff check src tests
   git -C agent-svc add pyproject.toml uv.lock src/agent_svc/rag tests/rag
   git -C agent-svc commit -m "test: lock down langchain rag configuration"
   ```

## Task 7: Document Optional Server-Side LangSmith Tracing and the Runbook

**Skills:** `observability`, `langchain-dependencies`, `langgraph-cli`, `superpowers:test-driven-development`

**MCP sources:** `mintlify://skills/langchain`, `assistant-ui://docs/integrations/observability/langsmith`, `https://reference.langchain.com/python/langsmith.md`

**Files:**

- Modify: `agent-svc/.env.example`
- Modify: `agent-svc/README.md`
- Modify or create: `back-end/docs/architecture/assistant-runtime.md`
- Modify: `back-end/docs/superpowers/plans/2026-09-12-assistant-ui-langgraph-full-stack-hardening.md`

1. Add a credential-independent config test or static assertion that tracing variables are optional and do not appear in any `NEXT_PUBLIC_*` configuration.

2. Document these server-only variables in `agent-svc/.env.example` with blank secrets:

   ```dotenv
   LANGSMITH_TRACING=false
   LANGSMITH_API_KEY=
   LANGSMITH_PROJECT=wkil-agent-svc
   ```

3. Document service startup in dependency order and the exact local commands:

   ```powershell
   docker compose -f agent-svc/docker-compose.yml up -d
   uv run --project agent-svc langgraph dev --config agent-svc/langgraph.json
   npm --prefix back-end run dev
   pnpm --dir app dev
   ```

4. Document the request path and ownership boundaries: assistant-ui owns UI/runtime state; gateway owns authentication and canonical tenant input; Agent Server owns threads/checkpoints/runs; Python graphs own orchestration; TypeScript business services own irreversible effects.

5. Document the checkpoint edit flow, interrupt refresh/resume flow, cancellation flow, workspace switch behavior, required private keys, and the fact that MCP is a documentation source rather than a shipped product integration.

6. Run secret/public-variable scans and documentation checks:

   ```powershell
   rg -n "LANGSMITH_API_KEY|LANGGRAPH_API_KEY" app\src app -g ".env*" -g "!*.example"
   npm --prefix back-end run docs:check
   ```

   Expected: no browser source or committed non-example environment file exposes secret values.

7. Commit documentation in its owning repositories. Keep this plan's ledger update in the `back-end` documentation commit.

## Task 8: Verify the Complete Cross-Repository Delivery

**Skills:** `superpowers:verification-before-completion`, `superpowers:requesting-code-review`, `assistant-ui`, `langgraph-cli`

**MCP sources:** Re-read every source named by the tasks whose files changed, plus the approved spec's full source list.

**Files:**

- Verify all changed files in `app`, `back-end`, and `agent-svc`
- Update: `back-end/docs/superpowers/plans/2026-09-12-assistant-ui-langgraph-full-stack-hardening.md`

1. Run fresh frontend verification:

   ```powershell
   pnpm --dir app test
   pnpm --dir app exec tsc --noEmit
   pnpm --dir app lint
   pnpm --dir app build
   ```

2. Run fresh gateway verification:

   ```powershell
   npm --prefix back-end test
   npm --prefix back-end run build
   npm --prefix back-end run docs:check
   ```

3. Run fresh agent verification:

   ```powershell
   uv lock --project agent-svc --check
   uv run --project agent-svc pytest -q
   uv run --project agent-svc ruff check src tests
   uv run --project agent-svc python -c "import json; from pathlib import Path; c=json.loads(Path('agent-svc/langgraph.json').read_text()); assert set(c['graphs']) == {'agent','customer_agent','rag_ingest','capability'}; print('langgraph config ok')"
   ```

4. With local services and non-production test credentials available, execute credential-independent portions of `agent-svc/scripts/e2e_driver.py` or add a bounded replacement that proves:

   - authenticated thread create/search/get-state/get-history;
   - streamed first run;
   - checkpoint-based edited run;
   - cancellation/disconnect;
   - interrupt refresh and approve/reject resume;
   - a second workspace cannot see or mutate the first workspace's thread.

5. If provider/API credentials are unavailable, record each skipped live operation in the ledger. Do not weaken unit/integration assertions to compensate.

6. Review repository hygiene independently:

   ```powershell
   git -C app status --short
   git -C app diff --check
   git -C back-end status --short
   git -C back-end diff --check
   git -C agent-svc status --short
   git -C agent-svc diff --check
   ```

7. Perform a final requirement-by-requirement review against all thirteen items in the approved spec. Scan changed files for incomplete work:

   ```powershell
   rg -n "TODO|FIXME|HACK|placeholder|not implemented" app\src back-end\src agent-svc\src
   ```

   Classify pre-existing matches separately; no new placeholder is allowed.

8. Update the ledger below with every command's fresh result and all three repository SHAs. Only then use `superpowers:verification-before-completion` to claim completion and close the app-level goal.

## Durable Execution Ledger

This table is the recovery point after context compaction. Update it immediately after each task; do not rely on chat history.

| Task | Status | Evidence | Commit(s) | Remaining concern |
|---|---|---|---|---|
| Approved design and implementation plan | Complete | User approved spec and selected subagent-driven execution on 2026-09-12; plan self-review and `git diff --check` passed | `back-end: 63b92eb`, `a8da6bf` | Set up SDD worktrees and ledger |
| 1. Frontend dependencies | Complete | ESM import, assistant-ui doctor, 12 focused tests, and `tsc --noEmit` passed; scoped re-review clean | `app: c19ade2` | Vite peer warning deferred to final review |
| 2. Gateway history/checkpoint | Complete | 51 focused tests; OpenAPI lint/routes/bundle/type generation passed; two scoped fix reviews clean | `back-end: 275bf88, 113afb8`; `app: ec60623, daf623a` | None |
| 3. Frontend checkpoint editing | Complete | 21 focused tests and `tsc --noEmit` passed; independent review passed | `app: f1a475d` | Minor test-strengthening items deferred to final review |
| 4. Compiled graph exports | Complete | 14 focused tests, four-target import validation, Ruff, and independent review passed | `agent-svc: c9998bc` | None |
| 5. Graph/HITL invariants | Complete | 78 focused tests and edited-file Ruff passed; independent review passed | `agent-svc: ea366fd` | Full-scope pre-existing Ruff cleanup deferred to final gate |
| 6. RAG consistency | Pending | Not run | — | Verify dedicated packages and shared embeddings |
| 7. LangSmith/runbook | Pending | Not run | — | Server-only optional tracing documentation |
| 8. Full verification/review | Pending | Not run | — | All suites, builds, config, smoke, diff review |

### Current checkpoint

- Approved design is durable in `back-end/docs/superpowers/specs/2026-09-12-assistant-ui-langgraph-full-stack-hardening-design.md`.
- This implementation plan was self-reviewed against the approved thirteen-item end state.
- Coordinated worktrees and the SDD ledger are active; Task 1 is complete after one reviewed fix round.
- Tasks 1 through 5 are complete with independent review gates.
- The next action is Task 6: LangChain RAG package and embedding consistency.
- No product code or dependency manifest has been changed yet.

### Resume instruction

On continuation, read the approved spec, this entire plan, the current app-level goal, and `git status --short` in all three repositories. Start at the first Pending ledger row. Re-read that task's skills and MCP sources before touching code.
