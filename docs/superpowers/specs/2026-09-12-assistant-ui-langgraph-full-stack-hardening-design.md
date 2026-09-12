# Assistant UI + LangGraph Full-Stack Hardening Design

**Date:** 2026-09-12  
**Status:** Revised after goal/source review; pending written-spec approval
**Scope owner:** `back-end` repository, spanning sibling `app` and `agent-svc` repositories

## 1. Goal

Deliver one verified, production-shaped chat path with these fixed boundaries:

- the web application uses official assistant-ui primitives and the official LangGraph runtime;
- the TypeScript backend remains the single authenticated, tenant-scoped gateway for web and mobile clients;
- the Python Agent Server remains the durable execution and persistence layer for LangGraph workflows;
- conversations stream, cancel, reload, and resume human approvals correctly;
- dependencies are reproducible from the current workspace paths and compatible lockfiles;
- LangSmith tracing can be enabled without exposing credentials to clients; and
- the architecture and implementation status remain recoverable after conversation compaction.

### 1.1 Required end state

The goal is achieved only when every requirement below has direct evidence:

1. **Official assistant-ui frontend:** the web chat uses assistant-ui primitives/elements and `@assistant-ui/react-langgraph`; there is no parallel application-owned message store, thread store, stream parser, or composer state.
2. **Authenticated shared gateway:** web and mobile LangGraph SDK traffic goes through `back-end` `/v1/assistant`; clients never receive either Agent Server key.
3. **Tenant isolation:** every thread and run operation is authorized from the authenticated user plus an accessible workspace/profile; client-supplied identity and graph selection cannot override server context.
4. **Durable conversation lifecycle:** thread creation is lazy, list/fetch/load/delete/rename are server-backed, deep links reload correctly, and workspace switching cannot display stale threads.
5. **Correct streaming lifecycle:** token messages, updates, and custom UI events render through the official runtime; Stop and disconnect abort the upstream run without inventing a message.
6. **Correct checkpoint lifecycle:** persisted history and UI data reload from Agent Server; edit/regenerate is either implemented with the exact server checkpoint or removed from the rendered UI.
7. **Correct human-in-the-loop lifecycle:** mutating tools interrupt before their side effect, refresh restores pending interrupts, and approve/reject resumes the same thread using top-level `Command(resume=...)` semantics.
8. **Correct LangGraph backend:** the explicit quota/context/model/tool/usage workflows are registered as deployable graphs, have valid reducers and bounded loops, and produce valid AI/tool message ordering.
9. **Correct LangChain integrations:** provider models, structured output, tool schemas, text splitting, embeddings, and Qdrant access use supported dedicated LangChain packages and consistent embedding configuration.
10. **Reproducible dependencies:** Node and Python installations are recreated from their lockfiles in the current checkout; compatible patch updates are recorded in manifests/locks; no stale junction points outside `D:\wkil` remain.
11. **Server-side observability:** documented LangSmith tracing variables are accepted without becoming public browser variables or required test secrets.
12. **Verified delivery:** focused tests, complete repository test suites, static checks, production builds, Agent Server import/config checks, and credential-independent integration checks pass. Any live-provider check that cannot run is named precisely and is not reported as passing.
13. **Durable continuation:** the implementation plan contains task checkboxes, evidence commands, repository commits, and a current/remaining-work ledger that is updated after each task.

Passing a subset of tests, completing only one repository, or preserving the existing architecture without proving these behaviors does not satisfy the goal.

## 2. Mandatory Skills and MCP Sources

### 2.1 Workflow skills

These govern how the work is performed:

- `superpowers:using-superpowers` — route each phase to the applicable skill before acting.
- `superpowers:brainstorming` — architecture, approval, written specification, and review gate.
- `superpowers:receiving-code-review` — evaluate and incorporate review feedback against repository evidence.
- `superpowers:writing-plans` — produce the executable plan after this specification is approved.
- `superpowers:executing-plans` — execute the approved plan inline with review checkpoints; no subagents are assumed.
- `superpowers:systematic-debugging` — determine root cause before repairing failures.
- `superpowers:test-driven-development` — add a failing test before each behavior fix.
- `superpowers:verification-before-completion` — run fresh evidence commands before any completion claim.
- `superpowers:requesting-code-review` — perform the final cross-repository review before handoff.

### 2.2 assistant-ui skills

These are required when their named surface is inspected or changed:

- `assistant-ui` — architecture and runtime selection router.
- `setup` — CLI/dependency setup and project diagnostics.
- `update` — 0.15.x dependency and API migration procedure.
- `runtime` — `useLangGraphRuntime`, provider configuration, adapters, and runtime behavior.
- `thread-list` — remote IDs, lazy initialization, list lifecycle, URL selection, and workspace remounts.
- `streaming` — native LangGraph event streaming, cancellation, and custom UI channels.
- `tools` — LangGraph tool-call renderers and approval UI registration.
- `elements` and `primitives` — verify copied Thread/ThreadList/tool components use supported composition without duplicating runtime behavior.
- `markdown` — verify the existing markdown renderer remains on the supported assistant-ui integration.
- `react-native` — consult only when a gateway change could alter the shared mobile contract; no mobile UI rewrite is in scope.
- `react-mcp` — consult to distinguish documentation MCP from a product MCP integration; its package and UI are not installed in this scope.

### 2.3 LangChain and LangGraph skills

- `ecosystem-primer` — required first framework decision; it selects LangGraph for deterministic, stateful control flow.
- `langchain-dependencies` — Python/TypeScript runtime requirements, package boundaries, and upgrade policy.
- `langchain-fundamentals` — supported models, `@tool`, structured output, and message/tool-result contracts used inside graph nodes. The project does not replace its explicit graphs with `create_agent`.
- `langgraph-fundamentals` — state, reducers, nodes, conditional edges, loop bounds, streaming, and error handling.
- `langgraph-persistence` — Agent Server checkpoints, thread isolation, state history, and checkpoint-based forks.
- `langgraph-human-in-the-loop` — `interrupt()`, top-level `Command(resume=...)`, checkpointer requirements, and side-effect idempotency.
- `langgraph-cli` — `langgraph.json`, deployable compiled-graph contract, local server validation, and production-shaped build checks.
- `langchain-rag` — splitter, embedding, retrieval, metadata filtering, and persistent-vector-store checks for the existing Qdrant path.

### 2.4 MCP documentation resources

The MCP documents below—not remembered APIs—are authoritative at each implementation checkpoint:

**assistant-ui MCP server (`assistant-ui`)**

- `assistant-ui://docs/architecture`
- `assistant-ui://docs/runtimes/pick-a-runtime`
- `assistant-ui://docs/runtimes/langgraph/overview`
- `assistant-ui://docs/runtimes/langgraph/quickstart`
- `assistant-ui://docs/runtimes/langgraph/threads`
- `assistant-ui://docs/runtimes/langgraph/streaming`
- `assistant-ui://docs/runtimes/langgraph/interrupts`
- `assistant-ui://docs/runtimes/langgraph/generative-ui`
- `assistant-ui://docs/runtimes/concepts/threads`
- `assistant-ui://docs/tools/tool-ui`
- `assistant-ui://docs/tools/mcp`
- `assistant-ui://docs/migrations/v0-15`

**LangChain guide MCP server (`langchain-docs`)**

- `mintlify://skills/langchain` for framework choice, deployment, tools, persistence, HITL, RAG, and LangSmith guidance.

**LangChain API-reference MCP server (`langchain-reference`)**

- `langchain://llms.txt`, then the current linked reference pages for `langgraph`, `langgraph-sdk`, `langchain-core`, provider packages, text splitters, Qdrant, and LangSmith symbols actually touched by a task.

Registry versions and package metadata may be checked immediately before installation, but code patterns come from the MCP documentation and the installed type definitions.

MCP is a documentation source for this project. This scope does not add user-managed MCP servers, an MCP configuration screen, or MCP tools to the Wkil product.

## 3. Evidence Collected Before Implementation

The repository audit established the following baseline:

- `app` is a Next.js 15.5 application using React 19 and assistant-ui.
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` already uses `useLangGraphRuntime`, a remote thread-list runtime, server history loading, interrupt restoration, custom UI messages, and SDK streaming.
- `app/src/lib/assistanceClient.ts` sends browser traffic to the TypeScript backend at `/v1/assistant`; the browser does not know the private Agent Server credential.
- `back-end/src/modules/ai-agent/assistant.gateway.ts` exposes an allow-listed LangGraph API subset and replaces client-provided identity with authenticated user, workspace, and business-profile identifiers.
- `agent-svc/langgraph.json` registers the `agent`, `customer_agent`, `rag_ingest`, and `capability` graphs with Agent Server authentication.
- `agent-svc` uses explicit `StateGraph` workflows because quota checks, deterministic routing, action loops, usage recording, persistence, and human interrupts require more control than a plain LangChain `create_agent` loop.
- The three repositories were clean at audit time.
- Current published frontend patch versions observed on 2026-09-12 are `@assistant-ui/react` 0.15.19, `@assistant-ui/react-langgraph` 0.14.27, `@assistant-ui/react-markdown` 0.14.15, and `@langchain/langgraph-sdk` 1.10.2.
- The Python lock already resolves `langgraph` 1.2.11. Agent Server is deliberately pinned to 0.13.2 for its base-image/runtime compatibility and must not be upgraded independently.
- Frontend tests currently fail before discovery because `app/node_modules` contains junctions to the old checkout at `D:\zTechy Org\pagespilot.com\wkil-fullstack\app`. The lockfile contains `@vitest/utils`; the missing-module error is an invalid installation layout, not a missing direct dependency.

No implementation files or dependency manifests were changed during the audit.

## 4. Selected Architecture

```text
Web (Next.js + assistant-ui)              Mobile (Expo + assistant-ui native)
                 \                         /
                  \ authenticated HTTP/SSE
                   v
        TypeScript /v1/assistant gateway
        - session and CSRF enforcement
        - workspace/profile authorization
        - request allow-list and normalization
        - private service credentials
                   |
                   | LangGraph SDK/REST/SSE
                   v
              LangGraph Agent Server
        - durable threads and checkpoints
        - run queue, streaming, cancellation
        - interrupt persistence and resume
                   |
          +--------+------------------+
          |                           |
          v                           v
  Python LangGraph workflows      Qdrant retrieval
  - quota and context                 
  - model calls                   authenticated tool callbacks
  - typed tools                       |
  - usage recording                   v
                              TypeScript business services
                              - authorization and effects
                              - Prisma/PostgreSQL
```

### 4.1 Frontend ownership

assistant-ui owns composer state, run state, message rendering, thread selection, and tool/interrupt presentation. LangGraph state remains authoritative for persisted messages and UI events. Application code supplies authentication, workspace selection, localization, URL synchronization, and product-specific renderers.

The runtime continues to use `@assistant-ui/react-langgraph`; it is not replaced with the AI SDK runtime or a custom stream parser. Existing remote-thread integration may be simplified only when tests prove equivalent behavior against the currently installed assistant-ui API.

### 4.2 Gateway ownership

The Express gateway remains the only browser/mobile path to Agent Server. It must:

- authenticate the user;
- resolve and authorize the active workspace and business profile;
- reject unsupported Agent Server endpoints and graph IDs;
- accept only the LangGraph SDK fields required by the frontend runtime;
- inject canonical tenant identifiers into thread and run input;
- forward streaming responses without buffering;
- propagate cancellation on client disconnect; and
- keep interactive and internal-service credentials distinct.

### 4.3 Agent ownership

Agent Server owns persistence, checkpoints, run lifecycle, and streaming. Python graphs own deterministic orchestration. LangChain packages inside graph nodes own provider-neutral model, message, tool, embedding, splitter, and Qdrant integrations.

Graphs keep raw canonical state and format prompts inside model nodes. Message and UI collections retain reducers. Unexpected errors surface to Agent Server; transient retry behavior is added only where a failing test and live documentation justify it.

### 4.4 Business-service ownership

The TypeScript backend remains responsible for authorization, billing state, Prisma persistence, external integrations, and irreversible effects. Agent tools call narrow authenticated internal endpoints; they do not duplicate business logic in Python.

## 5. Planned Changes

### 5.1 Reproducible dependency installation

- Reinstall `app` dependencies from `app/pnpm-lock.yaml` so all junctions target `D:\wkil\app`.
- Update the three assistant-ui packages to their compatible current patch versions and regenerate only the affected lockfile entries.
- Keep `@langchain/langgraph-sdk` at 1.10.2 unless the live registry changes before implementation.
- Reconcile `agent-svc` through `uv.lock`; do not install individual Python packages outside the lock workflow.
- Keep Agent Server 0.13.2 until its paired runtime and Docker image can be upgraded and tested as one unit.

### 5.2 Frontend LangGraph contract

- Add or strengthen tests for lazy thread initialization, workspace-scoped lists, deep-link loading, history and persisted UI restoration, stream modes, abort propagation, and interrupt resume.
- Implement checkpoint lookup and forwarding only if the product's edit/regenerate actions remain exposed. Editing or regenerating without a server checkpoint is forbidden because it would create client/server history divergence.
- Preserve the existing Arabic/English UI, RTL behavior, assistant-ui components, and chat layout.

### 5.3 Gateway contract

- Extend focused tests for thread history/checkpoint access if the frontend needs it.
- Permit only the exact SDK path and request fields required for checkpoint-based editing.
- Verify tenant isolation for thread list, fetch, state/history, update, delete, run, resume, and cancel.
- Preserve SSE headers, request IDs, locale headers, disconnect cancellation, and stable user-message IDs.

### 5.4 LangGraph correctness

- Verify every registered graph is accepted by the pinned Agent Server and has the required message state.
- Test reducers, quota routing, model/tool loop bounds, `ToolMessage` ordering, UI-event persistence, interrupt payloads, and resume behavior.
- Retain explicit graphs instead of replacing them with a plain LangChain agent.
- Avoid unrelated prompt, tool, RAG, or business-feature changes.

### 5.5 Observability and operational configuration

- Document `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, and `LANGSMITH_PROJECT` in the agent environment example.
- Ensure tracing credentials remain server-side and optional for local tests.
- Update architecture/run documentation with dependency installation, service startup order, and verification commands.

## 6. User Flow After the Change

1. The user signs in and selects a workspace through the existing application flow.
2. The chat sidebar requests only threads authorized for that workspace.
3. Opening the chat welcome state does not create an empty server thread.
4. Sending the first message creates the server thread and starts a run through the authenticated gateway.
5. The response streams into assistant-ui while Agent Server persists graph state.
6. Read-only tools execute and render results in the existing tool UI.
7. Mutating tools pause through a LangGraph interrupt and show the existing confirmation UI.
8. Refreshing or switching threads restores messages, persisted UI events, and pending interrupts.
9. Approving or rejecting resumes the same interrupted run without fabricating a new human message.
10. Pressing Stop or leaving an unfinished request cancels through the frontend, gateway, and Agent Server.
11. Switching workspaces remounts the runtime and loads only the newly selected workspace's threads.

There is no intentional visual redesign. Login, workspace switching, dashboards, localization, RTL, business data ownership, and the shared mobile gateway contract remain unchanged.

## 7. Error Handling

- Authentication and tenant failures return explicit 401/403 responses before an Agent Server request is made.
- Invalid SDK paths or payloads return bounded 400/403 errors.
- Agent Server network failures map to a stable 502 response and a user-visible retryable chat error.
- Client aborts terminate the upstream request without writing an extra assistant message.
- Rejected or expired approval resumes remain retryable in the UI when the runtime permits it.
- Graph/model/tool failures retain request IDs and LangSmith trace correlation without exposing secrets or raw internal errors.

## 8. Verification Gates

Implementation is complete only when all applicable gates pass from clean dependency installations:

- `app`: focused runtime tests, full Vitest suite, TypeScript check, ESLint, and production Next.js build.
- `back-end`: focused assistant gateway and AgentClient tests, full Vitest suite, TypeScript build, and OpenAPI route check when the gateway contract changes.
- `agent-svc`: focused graph/interrupt/security tests, full pytest suite, Ruff, and deployment-config import validation.
- Cross-layer: local Agent Server health, authenticated thread create/list/load, streamed run, cancel, interrupt resume, and workspace-isolation smoke checks.
- Repository hygiene: review diffs independently in all changed repositories and confirm no secrets, generated caches, or unrelated edits are included.

Live-provider smoke tests may be skipped only when credentials or services are unavailable; the exact unverified gate must then be reported rather than described as passing.

## 9. Alternatives Rejected

### Next.js-to-Agent-Server gateway

This would shorten the web path but duplicate authentication and workspace logic, split web and mobile behavior, and move sensitive agent-service credentials into another deployment boundary.

### Plain LangChain agent endpoint

This would reduce graph code but lose explicit quota/usage routing, durable checkpoints, server-managed threads, interrupt resume, and deterministic tool-loop bounds.

### Custom streaming protocol

This would duplicate capabilities already supplied by the LangGraph SDK, Agent Server, and assistant-ui adapter and would increase message reconstruction and cancellation risk.

## 10. Durable Continuation Ledger

This section is the fallback checkpoint for future compacted sessions. The implementation plan will provide task-level checkboxes and must be updated as work completes.

### Completed

- Classified the work as architectural.
- Inspected `app`, `back-end`, `agent-svc`, and the shared mobile contract.
- Verified that the selected three-tier architecture already exists.
- Consulted live assistant-ui and LangChain/LangGraph MCP documentation.
- Compared installed/locked versions with current published versions.
- Identified the broken frontend dependency-junction root cause.
- Received user approval for the architecture and affected user flow.
- Created a persistent Codex goal for the full outcome.
- Incorporated review feedback by replacing the broad goal with thirteen evidence-based completion requirements.
- Enumerated the mandatory workflow, assistant-ui, LangChain, and LangGraph skills plus the exact MCP documentation resources.

### Current checkpoint

- Review this revised written specification.
- No product code or dependency manifest has been modified.

### Remaining phases

1. Receive written-spec approval.
2. Write and self-review the task-by-task implementation plan.
3. Repair dependency installation and update compatible patch versions.
4. Add failing contract tests for each confirmed behavior gap.
5. Implement the smallest frontend, gateway, and agent changes required by those tests.
6. Add LangSmith environment documentation and architecture/runbook updates.
7. Run focused, full-suite, build, and cross-layer verification.
8. Review all repository diffs and report verified results and any credential-dependent checks not run.
