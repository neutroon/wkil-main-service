# Agent Contract Centralization Design

**Date:** 2026-09-23

**Status:** Approved in conversation on 2026-09-23; awaiting written-spec review

**Scope owner:** `back-end`, coordinated with sibling `agent-svc`, `app`, and `m` repositories

## 1. Goal

Centralize the contracts that connect the business-owner copilot and customer
agent without coupling four independently deployed repositories. The end state
must keep official LangGraph and assistant-ui integrations, eliminate accidental
web/mobile drift, and preserve the existing ownership boundary:

- `back-end` owns public HTTP behavior, authentication, authorization, tenant
  scope, business records, human handoff, follow-ups, delivery, and audit;
- `agent-svc` owns graph execution, prompts, tools, structured agent results,
  threads, runs, checkpoints, interrupts, and graph state;
- `app` and `m` are platform-specific clients of the authenticated backend
  gateway; and
- the repositories remain independently versioned, tested, and deployable.

Centralization means one authoritative wire contract and shared behavioral
invariants. It does not mean cross-repository source imports or a new monorepo.

## 2. Existing Architecture to Preserve

### 2.1 Business-owner copilot

Web and mobile use the official `@langchain/langgraph-sdk` and
`@assistant-ui/react-langgraph` packages through the authenticated backend
`/v1/assistant` gateway. The gateway permits only the registered `agent` graph,
derives canonical user/workspace/business-profile scope, forwards supported
thread/run operations, and keeps Agent Server credentials private.

Agent Server owns business-owner copilot threads and checkpoint history. These
threads are execution conversations for the signed-in owner; they are distinct
from customer-channel conversation records.

### 2.2 Customer channels

The backend owns WhatsApp, Messenger, Facebook-comment, and web-widget customer
conversation records. It also owns assignment, ordinary human handoff,
follow-up scheduling and cancellation, delivery state, channel policy, retries,
and audit history. Each backend conversation may reference one stable Agent
Server thread used by the `customer_agent` graph.

Agent Server persistence must not replace the product-domain conversation
database. Conversely, the backend must not add a second LangGraph checkpointer
or replay complete history on every run.

## 3. Chosen Approach

Use contract-first alignment with local platform adapters.

### 3.1 Why this approach

The official libraries already provide the shared runtime protocol:

- LangGraph Agent Server supplies threads, runs, checkpoints, streaming,
  cancellation, and persistence;
- `@langchain/langgraph-sdk` supplies the supported TypeScript client; and
- `@assistant-ui/react-langgraph` supplies the web/native UI runtime adapter.

The remaining duplication is small and platform-sensitive. Web uses cookie and
CSRF transport, locale-aware URLs, and Next.js navigation. Mobile uses bearer
tokens with refresh, absolute URLs, Expo/React Native navigation, and native
attachments. Sharing these implementations would create release coupling and
conditional platform code without centralizing the actual authority.

### 3.2 Rejected alternatives

#### Published shared TypeScript runtime package

A versioned internal package could share pure thread-adapter helpers, but it
would require a publication and compatibility process across Next.js and Expo.
The current reusable surface is too small and still depends on unstable
assistant-ui adapter APIs. Reconsider only after multiple releases demonstrate
a stable framework-neutral interface.

#### Workspace-root source package or monorepo import

Direct imports between sibling repositories would violate independent builds,
lockfiles, deployments, and rollback. They would also leave Python contracts
outside the supposed shared source. This option is rejected.

#### Backend-owned owner-copilot message database

Duplicating Agent Server owner-copilot messages in Prisma would add a competing
message source, custom synchronization, and recovery ambiguity. Agent Server
remains authoritative for owner-copilot thread state. Backend Prisma remains
authoritative for customer-channel records.

## 4. Authoritative Contracts

### 4.1 Public client contract: backend OpenAPI

`back-end/docs/openapi.yaml` is the authoritative public HTTP contract. The
assistant gateway section must document every client-visible requirement,
including:

- the optional `x-workspace-id` selector used by both clients;
- allowed thread create/search/read/update/delete/state/history routes;
- allowed run stream and exact-run cancellation routes;
- the fixed `agent` assistant identifier;
- the one-human-turn input invariant;
- top-level resume commands for persisted interrupts;
- scalar checkpoint selection for edit/regenerate;
- supported stream modes; and
- stable error codes relevant to client recovery.

The header selects an accessible workspace; it never authorizes one. The
gateway verifies membership and derives the canonical business profile.

Thread creation metadata supplied by clients may contain a title only. Clients
must not send `workspace_id`; the gateway stamps authorized workspace metadata
regardless of client input. Clients may defensively verify server-returned
metadata but must not treat their own metadata as authorization.

Generated web API types continue to originate from this OpenAPI source. Mobile
does not gain an unused generated API file solely for symmetry: LangGraph SDK
types remain its compile-time contract for gateway-compatible endpoints.

### 4.2 Backend-to-Agent Server contract

The official LangGraph SDK remains the transport contract. The backend keeps
separate clients and credentials for interactive BFF traffic and trusted
background jobs. Agent Server custom auth derives permissions from authenticated
headers and scopes every thread/run operation.

Graph names are stable deployment handles:

- `agent` for the business-owner copilot;
- `customer_agent` for customer-channel reasoning;
- `capability` only for supported stateless background capabilities; and
- `rag_ingest` for ingestion workflows.

Clients cannot select a graph other than `agent`. Backend background services
select other graphs through private, typed code paths.

### 4.3 Customer-agent result contract

`agent-svc` is the producer and owns the Pydantic structured-result definition.
The backend is the consumer and independently validates the wire result before
performing business effects. The stable result contains:

- `action`: `REPLY`, `HANDOFF`, `RESOLVE`, or `NO_REPLY`;
- `content`: present only when required by `REPLY`;
- `reason_code`: a stable machine-readable enum; and
- `handoff_category`: the allowed category or null.

Neither service trusts a TypeScript or Python type annotation as runtime
validation. Shared positive and negative JSON fixtures must exercise both
validators. The fixtures are contract evidence, not a runtime dependency:
each repository keeps its own test copy and a documented contract version.
A fixture change that alters accepted behavior requires coordinated commits.

This deliberately avoids a custom schema publication system in the first
iteration. If fixture synchronization becomes operationally unreliable, a
later design may introduce a generated JSON Schema artifact and release process.

## 5. Client Runtime Invariants

Web and mobile keep local runtime code but must implement the same protocol
semantics:

1. Construct an official LangGraph SDK client targeting the absolute or
   configured backend `/v1/assistant` URL.
2. Send the authenticated workspace selector header when a workspace is active.
3. Lazily create a thread on first send, never merely by opening the chat.
4. Send exactly the latest new human turn for an ordinary run.
5. Load messages, persisted UI data, and pending interrupts from thread state.
6. Resume an interrupt with a top-level `command`, no new human input, and no
   checkpoint selector.
7. Resolve edit/regenerate against the exact persisted checkpoint by ordered,
   stable message IDs. If no checkpoint can be proven, do not issue a divergent
   server run.
8. Abort the local stream and cancel unfinished server work on Stop or
   disconnect. Never fabricate an assistant message for cancellation.
9. Let the server generate and persist the canonical thread title.
10. Remount or reload runtime state when the authenticated workspace changes.

The clients may differ in presentation and platform capabilities. Native image
attachments may remain mobile-only until web exposes an equivalent composer.
Platform capability differences must not change authorization or graph policy.

## 6. Clean-Code Boundaries

### 6.1 Backend

- Route handlers perform HTTP translation only.
- Gateway normalization and allow-listing remain in focused pure functions with
  regression tests.
- Business services own authorization and side effects.
- Customer conversation, handoff, and follow-up state never move into gateway
  passthrough code.
- Private Agent Server credentials never enter client-visible configuration.

### 6.2 Agent service

- Graph construction, state schemas, middleware, tools, and HTTP callbacks stay
  in explicit modules.
- Pydantic validates runtime context, tool boundaries, and structured results.
- Graphs compile without an application checkpointer because Agent Server owns
  persistence.
- Business mutations remain authenticated backend tool calls.
- Customer-channel adapters and delivery policy do not move into Python.

### 6.3 Web and mobile

- A small client factory owns URL, authentication transport, workspace header,
  timeout, and retry policy.
- A thread-list adapter owns only remote thread metadata lifecycle.
- A runtime hook owns streaming, state loading, checkpoints, interrupts, and
  cancellation through official library APIs.
- UI components use assistant-ui elements/primitives and do not parse SSE or
  maintain a second message store.
- Pure protocol helpers receive unit tests; platform auth and navigation remain
  outside them.

## 7. Dependency Policy

- Align `@langchain/langgraph-sdk` to one tested version across backend, web,
  and mobile when their lockfiles are updated.
- Keep `@assistant-ui/react-langgraph` aligned across web and mobile.
- Web remains on the supported `@assistant-ui/react` 0.15.x line; mobile uses
  the compatible `@assistant-ui/react-native` line rather than web DOM Elements.
- Preserve exact lockfile ownership: npm for backend, pnpm for web/mobile, uv
  for agent service.
- Do not update unrelated frameworks merely to make version numbers visually
  identical.
- Treat unstable assistant-ui APIs as local adapter seams with focused tests,
  so a future library migration does not affect product-domain services.

## 8. Error Handling and Security

- The backend rejects unknown assistant routes, fields, query parameters,
  stream modes, graph IDs, run config, checkpoint shapes, and resume shapes.
- Workspace and business scope are always server-derived and verified.
- Cross-workspace thread access returns a stable authorization failure without
  revealing thread existence or metadata.
- Client retry behavior must not duplicate a run. Mobile token refresh may
  retry authentication once; SDK run retries remain disabled unless a proven
  idempotent policy is added.
- Invalid customer-agent structured output becomes an agent failure and follows
  backend handoff/recovery policy; it is never silently coerced into a reply.
- Logs and fixtures exclude credentials, customer content, production IDs, and
  complete provider payloads.

## 9. Implementation Sequence

Implementation will use focused commits in dependency order:

1. **Backend contract correction**
   - document the workspace header and current gateway behavior in OpenAPI;
   - strengthen OpenAPI/gateway regression tests; and
   - regenerate the coordinated web API types.
2. **Client request cleanup**
   - remove redundant `workspace_id` from web/mobile thread creation;
   - align list limits and stable adapter behavior where platform-neutral; and
   - add contract-focused client tests.
3. **Mobile runtime parity**
   - align the LangGraph SDK version;
   - implement checkpoint-safe edit/regenerate and exact resume semantics using
     official runtime callbacks; and
   - preserve native attachment behavior, auth refresh, and cancellation.
4. **Backend/agent contract fixtures**
   - add matching valid/invalid customer-agent fixtures and runtime-validation
     tests in both repositories; and
   - document the contract version and coordinated-change rule.
5. **Durable documentation and cleanup**
   - update the central runtime runbook and repository READMEs;
   - clarify owner-copilot versus customer-conversation persistence; and
   - remove only dead code made obsolete by the changes.

No database migration, public deployment, package publication, or broad UI
redesign is part of this implementation.

## 10. Verification

### 10.1 Agent service

- focused Pydantic/structured-result contract tests;
- `uv run --locked --extra dev ruff check src tests`;
- `uv run --locked --extra dev ruff format --check src tests`; and
- `uv run --locked --extra dev pytest -q`.

### 10.2 Backend

- focused gateway, OpenAPI, customer-agent, handoff, and follow-up tests;
- `npm test`;
- `npm run docs:check`; and
- `npm run build`.

### 10.3 Web

- focused copilot runtime and generated-contract tests;
- `pnpm lint`;
- `pnpm exec tsc --noEmit`;
- `pnpm test`; and
- `pnpm build`.

### 10.4 Mobile

- focused runtime, auth, interrupt, attachment, and thread-adapter tests;
- local TypeScript typecheck;
- `pnpm test`; and
- an Expo/Android runtime smoke test when the configured runtime tooling and a
  reachable backend are available.

### 10.5 Cross-system acceptance

Against running local services with non-production credentials:

- create/list/load/rename/delete an owner-copilot thread;
- stream one ordinary turn from web and mobile;
- stop and cancel the exact active run;
- restore and approve/reject a persisted interrupt;
- edit/regenerate from an exact checkpoint;
- deny a cross-workspace thread request;
- run one customer-agent result for each action; and
- verify handoff and follow-up state remains in backend persistence.

Static checks do not substitute for these live gates. Any live check blocked by
credentials, simulator availability, or local services must be reported as
unverified rather than passing.

## 11. Acceptance Criteria

- Backend OpenAPI accurately describes the workspace-scoped assistant gateway.
- Web and mobile do not send client-owned workspace metadata.
- Web and mobile use aligned official SDK/runtime semantics for ordinary runs,
  checkpoint edits, regeneration, interrupts, and cancellation.
- Mobile cannot create divergent edit/regenerate runs when checkpoint lookup
  fails.
- Backend and agent service accept and reject the same customer-agent result
  fixtures.
- Customer conversation, handoff, and follow-up records remain backend-owned.
- Owner-copilot threads and graph state remain Agent Server-owned.
- No cross-repository runtime source import, duplicate message store, custom
  checkpointer, custom stream parser, or new orchestration framework is added.
- Required focused and repository-wide checks pass, with unavailable live
  verification disclosed precisely.

## 12. Authoritative References

- assistant-ui LangGraph runtime: `/docs/runtimes/langgraph/overview`
- assistant-ui threads: `/docs/runtimes/langgraph/threads`
- assistant-ui interrupts and message editing:
  `/docs/runtimes/langgraph/interrupts`
- assistant-ui React Native thread lists: `/docs/react-native/thread-list`
- LangGraph persistence: `/oss/python/langgraph/persistence`
- LangGraph Agent Server architecture: `/langsmith/agent-server`
- Repository runtime runbook: `back-end/docs/architecture/assistant-runtime.md`
- Customer-channel architecture:
  `../docs/superpowers/specs/2026-09-15-customer-agent-channel-architecture-design.md`
