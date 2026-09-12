# Assistant UI + LangGraph Full-Stack Hardening Design

**Date:** 2026-09-12  
**Status:** Approved in chat; pending written-spec review  
**Scope owner:** `back-end` repository, spanning sibling `app` and `agent-svc` repositories

## 1. Goal

Complete and harden Wkil's existing AI chat architecture so that:

- the web application uses official assistant-ui primitives and the official LangGraph runtime;
- the TypeScript backend remains the single authenticated, tenant-scoped gateway for web and mobile clients;
- the Python Agent Server remains the durable execution and persistence layer for LangGraph workflows;
- conversations stream, cancel, reload, and resume human approvals correctly;
- dependencies are reproducible from the current workspace paths and compatible lockfiles;
- LangSmith tracing can be enabled without exposing credentials to clients; and
- the architecture and implementation status remain recoverable after conversation compaction.

Success means the relevant frontend, gateway, and agent test suites pass; production builds complete; the cross-layer contract tests pass; and a documented smoke flow proves tenant isolation, thread persistence, streaming, cancellation, and interrupt resume.

## 2. Source of Truth

Implementation decisions must be checked against live documentation before code changes:

1. assistant-ui MCP resources, especially:
   - `assistant-ui://docs/runtimes/langgraph/overview`
   - `assistant-ui://docs/runtimes/langgraph/threads`
   - `assistant-ui://docs/runtimes/langgraph/streaming`
   - `assistant-ui://docs/runtimes/langgraph/interrupts`
   - `assistant-ui://docs/tools/mcp`
2. LangChain documentation MCP resources:
   - `mintlify://skills/langchain`
   - `langchain://llms.txt`
3. The local assistant-ui, LangGraph, dependency-management, testing, and verification skills.

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

### Current checkpoint

- Persist and review this written specification.
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

