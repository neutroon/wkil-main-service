# Agent Contract Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize the owner-copilot and customer-agent contracts at the backend/Agent Server boundary so the web and mobile clients remain thin, compatible assistant-ui adapters with matching checkpoint, interrupt, tenant, and structured-decision behavior.

**Architecture:** The Node.js backend remains the authenticated public API and business-system owner, while the self-hosted LangGraph Agent Server remains the durable execution/checkpoint owner. OpenAPI is the canonical client-facing wire contract; web and mobile use official LangGraph SDK and assistant-ui runtime APIs without a cross-repository source package, and the TypeScript/Python customer-decision validators remain local enforcement points pinned by identical versioned fixtures.

**Tech Stack:** Node.js 24, Express 5, OpenAPI 3, `@langchain/langgraph-sdk` 1.11.0, Vitest, Next.js, assistant-ui, Expo/React Native, Python 3.11+, Pydantic 2, LangGraph Agent Server, pytest, Ruff, pnpm, npm, uv.

**Spec:** `docs/superpowers/specs/2026-09-23-agent-contract-centralization-design.md`

## Global Constraints

- Work on the current `main` branch in each independent repository; do not create worktrees.
- Produce focused commits per repository and task; do not push, merge, deploy, publish packages, or run database migrations.
- `back-end/` owns authentication, workspace/business authorization, the public OpenAPI contract, Prisma business records, human handoff, follow-up scheduling, and delivery effects.
- `agent-svc/` owns graph execution, tools, structured outputs, Agent Server threads/runs/checkpoints, and retrieval behavior.
- `app/` and `m/` remain thin clients; they must not duplicate server authorization or business invariants.
- Use official `@langchain/langgraph-sdk` 1.11.0 and assistant-ui runtime semantics; do not add a manual SSE parser, parallel message store, custom thread protocol, AssistantCloud, or a shared monorepo package.
- Preserve separate durable identities: business-owner copilot sessions are Agent Server threads; customer-channel conversations are backend/Prisma records that point at stable Agent Server thread IDs.
- A normal or edited turn sends exactly one latest human message; regeneration sends `input: null` with an exact scalar `checkpoint_id`; interrupt continuation sends top-level `command` with no human input or checkpoint selector.
- Web and mobile thread creation must not send tenant metadata. The backend derives and stamps `workspace_id`, user ID, and business-profile ID from authenticated scope.
- Mobile must preserve official image content parts and use assistant-ui React Native primitives; no custom chat UI or hand-written widget surface is introduced by this work.
- Customer decision validation stays strict in both TypeScript/Zod and Python/Pydantic and is pinned by contract version `1` with identical valid and invalid fixture cases.
- Follow-ups remain backend-scheduled business work that invokes the existing customer graph when due; LangGraph does not become a custom scheduler or business record store.
- Add tests before implementation changes, run the smallest relevant checks first, and preserve unrelated user changes.

## Review Focus

1. A malicious or stale `x-workspace-id` must never become trusted graph metadata: the backend must require authorized workspace scope and stamp its resolved workspace ID.
2. A missing, stale, reordered, or ID-less checkpoint history match must not start a divergent edit/regeneration run; the client must stop locally with a `MessageNotSentError` or an empty regeneration stream.
3. An interrupt resume that also carries human input or a checkpoint must remain invalid and must never be forwarded as a fresh graph turn.
4. An image-only mobile human message must retain its `image_url` content part instead of becoming an empty string or empty message.
5. A malformed customer decision—including unknown fields, non-reply content, or an attachment on a non-reply action—must be rejected by both the TypeScript and Python boundaries.

---

## File Map

### `back-end/`

- `docs/openapi.yaml`: canonical public assistant gateway paths, optional tenant selector header, and strict request schemas.
- `src/modules/ai-agent/assistant.openapi.test.ts`: executable OpenAPI behavior and request-shape checks.
- `src/modules/ai-agent/assistant.gateway.test.ts`: server-stamping and interrupt/checkpoint safety regression tests.
- `src/modules/ai-agent/assistant.sdk-contract.test.ts`: exact official SDK camelCase-to-wire snake_case serialization proof.
- `src/modules/ai-agent/customer/customerAgent.types.ts`: strict Zod decision boundary and decision contract version.
- `src/modules/ai-agent/customer/customerAgent.types.test.ts`: fixture-driven TypeScript decision contract tests.
- `src/modules/ai-agent/customer/fixtures/customer-agent-decision.v1.json`: TypeScript copy of the versioned parity corpus.
- `docs/architecture/assistant-runtime.md`: durable ownership, client boundary, SDK version, and follow-up/handoff runbook.
- `package.json`, `package-lock.json`: exact compatible LangGraph SDK dependency resolution.

### `app/`

- `src/components/user/copilot/overlay/CopilotRuntime.tsx`: web runtime and thread adapter; remove client-owned workspace metadata only.
- `src/components/user/copilot/overlay/CopilotRuntime.test.tsx`: thread-creation contract regression test.
- `src/types/openapi.generated.ts`: generated backend OpenAPI types; never edit by hand.
- `src/types/assistant-run-contract.type-test.ts`: compile-time header and strict request-shape assertions.

### `m/`

- `hooks/use-app-runtime.ts`: small React hook that wires auth, the thread list, and the extracted official LangGraph adapter.
- `hooks/use-app-runtime.test.ts`: server-owned thread metadata and workspace-filter tests.
- `lib/mobile-langgraph-runtime.ts`: focused checkpoint, stream, and load adapter using official SDK calls.
- `lib/mobile-langgraph-runtime.test.ts`: exact checkpoint, interrupt, latest-human, cancellation, and image-part tests.
- `README.md`: mobile runtime ownership and official-library notes.
- `package.json`, `pnpm-lock.yaml`: SDK 1.11.0 plus a direct compatible `@assistant-ui/core` dependency for `MessageNotSentError`.

### `agent-svc/`

- `src/agent_svc/customer_schemas.py`: Python decision contract version constant; Pydantic remains the runtime validator.
- `tests/fixtures/customer-agent-decision.v1.json`: Python copy of the exact versioned parity corpus.
- `tests/test_customer_schemas.py`: fixture-driven Python validation tests.
- `tests/test_langgraph_manifest.py`: stable deployed graph-handle regression test.
- `README.md`: Agent Server versus backend business-record ownership.

---

### Task 1: Publish the canonical backend assistant wire contract

**Files:**
- Modify: `back-end/docs/openapi.yaml`
- Modify: `back-end/src/modules/ai-agent/assistant.openapi.test.ts`
- Modify: `back-end/src/modules/ai-agent/assistant.gateway.test.ts`
- Create: `back-end/src/modules/ai-agent/assistant.sdk-contract.test.ts`
- Modify: `back-end/package.json`
- Modify: `back-end/package-lock.json`

**Interfaces:**
- Consumes: existing `assistantGatewayInternals.normalizeBody(endpoint, body, scope)` and official `Client.runs.stream(threadId, assistantId, payload)`.
- Produces: every gateway operation declares optional selector header `x-workspace-id: string`; thread-create metadata accepts only optional `title`; SDK 1.11.0 demonstrably serializes `checkpointId` as scalar `checkpoint_id`.

- [ ] **Step 1: Add failing OpenAPI tests for the shared workspace header and strict thread metadata**

Move the parsed document to module scope, generalize the request-schema helper, and add these assertions in `src/modules/ai-agent/assistant.openapi.test.ts`:

```ts
const ASSISTANT_OPERATION_IDS = [
  "createAssistantThread",
  "searchAssistantThreads",
  "getAssistantThread",
  "updateAssistantThread",
  "deleteAssistantThread",
  "getAssistantThreadState",
  "getAssistantThreadHistory",
  "streamAssistantRun",
  "cancelAssistantRun",
] as const;

const document = parse(
  fs.readFileSync(path.resolve(process.cwd(), "docs/openapi.yaml"), "utf8"),
) as JsonRecord;

function requestSchema(pathName: string, method: "post" | "patch"): JsonRecord {
  const operation = ((document.paths as JsonRecord)[pathName] as JsonRecord)[method] as JsonRecord;
  const requestBody = operation.requestBody as JsonRecord;
  const content = requestBody.content as JsonRecord;
  return {
    ...((content["application/json"] as JsonRecord).schema as JsonRecord),
    components: document.components,
  };
}

it("publishes the optional workspace selector on every LangGraph gateway operation", () => {
  const operations = Object.values(document.paths as JsonRecord)
    .flatMap((pathItem) => Object.values(pathItem as JsonRecord))
    .filter((value): value is JsonRecord => Boolean(value) && typeof value === "object")
    .filter((operation) => ASSISTANT_OPERATION_IDS.includes(operation.operationId as never));

  expect(operations).toHaveLength(ASSISTANT_OPERATION_IDS.length);
  for (const operation of operations) {
    expect(operation.parameters).toEqual(expect.arrayContaining([
      { $ref: "#/components/parameters/AssistantWorkspaceId" },
    ]));
  }
  expect(((document.components as JsonRecord).parameters as JsonRecord).AssistantWorkspaceId)
    .toMatchObject({ name: "x-workspace-id", in: "header", required: false });
});

it("does not publish workspace_id as client-owned thread metadata", () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(requestSchema("/v1/assistant/threads", "post"));
  expect(validate({ metadata: { title: "Quarterly review" } })).toBe(true);
  expect(validate({ metadata: { workspace_id: 999 } })).toBe(false);
});
```

Replace `assistantRunSchema()` calls with `requestSchema("/v1/assistant/threads/{threadId}/runs/stream", "post")` while retaining all current run tests.

- [ ] **Step 2: Run the OpenAPI test and verify the new cases fail**

Run: `npm test -- src/modules/ai-agent/assistant.openapi.test.ts`

Expected: FAIL because `AssistantWorkspaceId` is not referenced by the gateway operations and thread metadata still permits undeclared keys.

- [ ] **Step 3: Add the reusable header and strict request schema to OpenAPI**

Add this component under `components.parameters` in `docs/openapi.yaml`:

```yaml
    AssistantWorkspaceId:
      name: x-workspace-id
      in: header
      required: false
      description: Authenticated workspace selected by the client; the server verifies membership and resolves canonical tenant scope.
      schema:
        type: string
        pattern: "^[1-9][0-9]*$"
```

Reference it from the `parameters` array of each operation named in `ASSISTANT_OPERATION_IDS`:

```yaml
      parameters:
        - $ref: "#/components/parameters/AssistantWorkspaceId"
```

Where an operation already has path/query parameters, prepend the reference and keep those parameters. Make thread-create metadata strict:

```yaml
                metadata:
                  type: object
                  additionalProperties: false
                  properties:
                    title: { type: string, maxLength: 200 }
```

Also set `additionalProperties: false` on the outer create body and its optional `input` object so the published schema matches `normalizeBody`.

- [ ] **Step 4: Add gateway regression tests for server-owned tenant scope and resume exclusivity**

Append to `assistant.gateway.test.ts`:

```ts
it("ignores client tenant metadata and stamps the authorized workspace", () => {
  expect(assistantGatewayInternals.normalizeBody("create", {
    metadata: { title: " Owner chat ", workspace_id: 999 },
  }, scope)).toEqual({
    metadata: { workspace_id: 11, title: "Owner chat" },
    input: {
      user_id: 42,
      business_profile_id: 7,
      workspace_id: 11,
      channel: "internal_copilot",
    },
  });
});

it.each([
  { command: { resume: { approved: true } }, checkpoint_id: "cp-1" },
  { command: { resume: { approved: true } }, input: { messages: [{ type: "human", content: "also send" }] } },
])("rejects mixed interrupt resume payloads: %j", (payload) => {
  expect(() => assistantGatewayInternals.normalizeBody("run", {
    assistant_id: "agent",
    ...payload,
  }, scope)).toThrow();
});
```

The first case intentionally proves that a malicious `workspace_id` cannot survive normalization; do not change `normalizeBody` to trust it. Also mock `getActiveProfileId` and `requireWorkspaceProfileAccess` at the top of the file and exercise the exported handler so unauthorized selection is pinned before any upstream request:

```ts
const workspaceAccess = vi.hoisted(() => ({
  getActiveProfileId: vi.fn(async () => 7),
  requireWorkspaceProfileAccess: vi.fn(),
}));

vi.mock("@modules/workspace/workspace.service", () => workspaceAccess);

it("rejects an unauthorized workspace selector before contacting Agent Server", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  workspaceAccess.requireWorkspaceProfileAccess.mockRejectedValueOnce(
    Object.assign(new Error("forbidden"), { statusCode: 403 }),
  );

  await expect(assistantGateway({
    user: { id: 42 },
    path: "threads",
    method: "POST",
    query: {},
    headers: { "x-workspace-id": "999" },
    cookies: {},
    body: {},
  } as never, {} as never)).rejects.toMatchObject({ statusCode: 403 });

  expect(workspaceAccess.getActiveProfileId).toHaveBeenCalledWith(42, undefined, 999);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
```

Extend the existing imports to include `beforeEach` and `assistantGateway`. Reset the two workspace mocks so this test cannot leak rejected state into other cases:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  workspaceAccess.getActiveProfileId.mockResolvedValue(7);
  workspaceAccess.requireWorkspaceProfileAccess.mockResolvedValue({
    workspaceId: 11,
    role: "owner",
  });
});
```

- [ ] **Step 5: Add the failing official SDK wire-serialization test**

Create `assistant.sdk-contract.test.ts`:

```ts
import { Client } from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";

describe("LangGraph SDK wire contract", () => {
  it("serializes checkpointId as scalar checkpoint_id", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new Client({
      apiUrl: "https://agent.test",
      callerOptions: { fetch: request, maxRetries: 0 },
    });

    for await (const _event of client.runs.stream("thread-1", "agent", {
      input: null,
      checkpointId: "cp-123",
      streamMode: ["messages", "updates", "custom"],
    })) {
      // Empty test stream.
    }

    const init = request.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      assistant_id: "agent",
      input: null,
      checkpoint_id: "cp-123",
    });
    expect(body).not.toHaveProperty("checkpoint");
  });
});
```

- [ ] **Step 6: Run the SDK test against the old package and verify it fails**

Run: `npm test -- src/modules/ai-agent/assistant.sdk-contract.test.ts`

Expected: FAIL because the currently locked 1.10.2 stream payload does not emit scalar `checkpoint_id`.

- [ ] **Step 7: Upgrade only the backend LangGraph SDK and refresh its npm lockfile**

Change `package.json` to:

```json
"@langchain/langgraph-sdk": "1.11.0"
```

Run: `npm install --package-lock-only`

Expected: `package-lock.json` resolves `@langchain/langgraph-sdk` 1.11.0 without unrelated dependency churn.

- [ ] **Step 8: Run focused backend checks**

Run:

```powershell
npm test -- src/modules/ai-agent/assistant.openapi.test.ts src/modules/ai-agent/assistant.gateway.test.ts src/modules/ai-agent/assistant.sdk-contract.test.ts
npm run docs:check
npm run build
git diff --check
```

Expected: all tests PASS; Redocly lint/routes/bundle pass; TypeScript build passes; no whitespace errors.

- [ ] **Step 9: Commit the backend contract change**

```powershell
git add docs/openapi.yaml src/modules/ai-agent/assistant.openapi.test.ts src/modules/ai-agent/assistant.gateway.test.ts src/modules/ai-agent/assistant.sdk-contract.test.ts package.json package-lock.json
git commit -m "fix(assistant): publish canonical gateway contract"
```

---

### Task 2: Regenerate the web contract and remove client-owned workspace metadata

**Files:**
- Modify (generated): `app/src/types/openapi.generated.ts`
- Modify: `app/src/types/assistant-run-contract.type-test.ts`
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.tsx`
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.test.tsx`

**Interfaces:**
- Consumes: Task 1 OpenAPI operation header `x-workspace-id` and the existing `createAssistanceClient(workspaceId)` transport that supplies it.
- Produces: generated web types exposing the optional selector header and a thread adapter that calls `client.threads.create()` without tenant metadata.

- [ ] **Step 1: Add a failing web thread-creation test**

In `CopilotRuntime.test.tsx`, add:

```ts
it("creates a thread without client-owned workspace metadata", async () => {
  threadMock.create.mockResolvedValueOnce({ thread_id: "thread-1" });
  const adapter = makeThreadListAdapter(11, clientMock as never);

  await expect(adapter.initialize()).resolves.toEqual({
    remoteId: "thread-1",
    externalId: "thread-1",
  });
  expect(threadMock.create).toHaveBeenCalledWith();
});
```

Keep the existing test that a null workspace rejects with `workspace_required`; this verifies the client still refuses unscoped initialization before transport.

- [ ] **Step 2: Run the focused web test and verify it fails**

Run: `pnpm exec vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx`

Expected: FAIL because `initialize()` currently passes `{ metadata: { workspace_id: 11 } }`.

- [ ] **Step 3: Remove redundant client tenant metadata**

Change only the create call in `makeThreadListAdapter`:

```ts
const thread = await client.threads.create();
return { remoteId: thread.thread_id, externalId: thread.thread_id };
```

Do not remove the workspace filter from `list()` or the workspace header from `createAssistanceClient`; those are defense-in-depth and transport scope, respectively.

- [ ] **Step 4: Regenerate OpenAPI types from the backend source**

From `back-end/`, run: `npm run types:api`

Expected: only `app/src/types/openapi.generated.ts` changes in the app repository, and assistant operations expose optional header `x-workspace-id`.

- [ ] **Step 5: Add compile-time proof for the generated header and strict metadata**

Append to `assistant-run-contract.type-test.ts`:

```ts
type CreateAssistantThreadParameters = operations["createAssistantThread"]["parameters"];
type CreateAssistantThreadBody = operations["createAssistantThread"]["requestBody"]["content"]["application/json"];

declare function acceptAssistantThreadParameters(value: CreateAssistantThreadParameters): void;
declare function acceptAssistantThreadBody(value: CreateAssistantThreadBody): void;

acceptAssistantThreadParameters({ header: { "x-workspace-id": "11" } });
acceptAssistantThreadParameters({});
acceptAssistantThreadBody({ metadata: { title: "Quarterly review" } });

// @ts-expect-error Tenant metadata is stamped by the backend, never by a client.
acceptAssistantThreadBody({ metadata: { workspace_id: 11 } });
```

- [ ] **Step 6: Run focused and static web checks**

Run:

```powershell
pnpm exec vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx
pnpm exec tsc --noEmit
pnpm exec eslint src/components/user/copilot/overlay/CopilotRuntime.tsx src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/types/assistant-run-contract.type-test.ts
git diff --check
```

Expected: test, typecheck, and lint PASS; the `@ts-expect-error` lines are consumed; no hand-edited divergence appears in generated types.

- [ ] **Step 7: Commit the web consumer change**

```powershell
git add src/types/openapi.generated.ts src/types/assistant-run-contract.type-test.ts src/components/user/copilot/overlay/CopilotRuntime.tsx src/components/user/copilot/overlay/CopilotRuntime.test.tsx
git commit -m "refactor(copilot): consume server-owned workspace scope"
```

---

### Task 3: Align mobile dependencies and thread creation with the canonical contract

**Files:**
- Modify: `m/package.json`
- Modify: `m/pnpm-lock.yaml`
- Modify: `m/hooks/use-app-runtime.ts`
- Modify: `m/hooks/use-app-runtime.test.ts`

**Interfaces:**
- Consumes: backend-owned tenant metadata and SDK 1.11.0 established in Task 1.
- Produces: a mobile thread adapter that keeps the workspace-scoped transport/list filter but calls `threads.create()` without metadata; direct `@assistant-ui/core` 0.3.18 access for the official `MessageNotSentError` used in Task 4.

- [ ] **Step 1: Expand failing mobile thread-adapter tests**

Replace the single-purpose setup in `use-app-runtime.test.ts` with a reusable client and add these cases:

```ts
const makeClient = () => ({
  threads: {
    search: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
});

it("creates a thread without client-owned workspace metadata", async () => {
  const client = makeClient();
  client.threads.create.mockResolvedValue({ thread_id: "thread-1" });
  const adapter = makeThreadListAdapter(client as never, 11);

  await adapter.initialize();

  expect(client.threads.create).toHaveBeenCalledWith();
});

it("does not search or initialize without an active workspace", async () => {
  const client = makeClient();
  const adapter = makeThreadListAdapter(client as never, null);

  await expect(adapter.list()).resolves.toEqual({ threads: [] });
  await expect(adapter.initialize()).rejects.toThrow("workspace_required");
  expect(client.threads.search).not.toHaveBeenCalled();
  expect(client.threads.create).not.toHaveBeenCalled();
});

it("keeps only threads stamped for the selected workspace", async () => {
  const client = makeClient();
  client.threads.search.mockResolvedValue([
    { thread_id: "kept", metadata: { workspace_id: 11 } },
    { thread_id: "rejected", metadata: { workspace_id: 12 } },
  ]);
  const adapter = makeThreadListAdapter(client as never, 11);

  await expect(adapter.list()).resolves.toMatchObject({
    threads: [{ remoteId: "kept", externalId: "kept" }],
  });
  expect(client.threads.search).toHaveBeenCalledWith({ limit: 30 });
});
```

Retain the server-title test and reset mocks between tests.

- [ ] **Step 2: Run the mobile adapter tests and verify the create case fails**

Run: `pnpm exec vitest run hooks/use-app-runtime.test.ts`

Expected: the create-without-metadata test FAILS; existing title/list behavior remains green.

- [ ] **Step 3: Remove workspace metadata from mobile thread creation**

Change the adapter create call to:

```ts
const thread = await client.threads.create();
return { remoteId: thread.thread_id, externalId: thread.thread_id };
```

Change the mobile search page from `{ limit: 50 }` to the web adapter's bounded `{ limit: 30 }`. Keep `defaultHeaders: { "x-workspace-id": String(workspaceId) }` and the exact metadata filter in `list()`.

- [ ] **Step 4: Align official runtime dependencies**

Set exact versions in `m/package.json`:

```json
"@assistant-ui/core": "0.3.18",
"@langchain/langgraph-sdk": "1.11.0"
```

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` records the two direct dependencies without upgrading Expo, React Native, or assistant-ui packages.

- [ ] **Step 5: Run focused mobile checks**

Run:

```powershell
pnpm exec vitest run hooks/use-app-runtime.test.ts
pnpm exec tsc --noEmit
git diff --check
```

Expected: PASS with no workspace metadata supplied by thread creation and no type regressions.

- [ ] **Step 6: Commit the dependency and thread-scope alignment**

```powershell
git add package.json pnpm-lock.yaml hooks/use-app-runtime.ts hooks/use-app-runtime.test.ts
git commit -m "chore(copilot): align mobile thread contract"
```

---

### Task 4: Implement checkpoint-safe mobile LangGraph runtime parity

**Files:**
- Create: `m/lib/mobile-langgraph-runtime.ts`
- Create: `m/lib/mobile-langgraph-runtime.test.ts`
- Modify: `m/hooks/use-app-runtime.ts`
- Modify: `m/README.md`

**Interfaces:**
- Consumes: official SDK 1.11.0 `Client`, assistant-ui `useLangGraphRuntime`, `MessageNotSentError`, `LangChainMessage`, `LangGraphInterruptState`, and `UIMessage`.
- Produces: `checkpointForMessages(history, parentMessages): string | null` and `makeMobileLangGraphRuntime(client, checkpointLookup): { stream; load; getCheckpointId }`, where `checkpointLookup` is `{ current: boolean }`.

- [ ] **Step 1: Write failing pure checkpoint matching tests**

Create `lib/mobile-langgraph-runtime.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";
import { MessageNotSentError } from "@assistant-ui/core";
import {
  checkpointForMessages,
  makeMobileLangGraphRuntime,
} from "./mobile-langgraph-runtime";

const state = (ids: Array<string | undefined>, checkpointId = "cp-1") => ({
  values: { messages: ids.map((id) => ({ type: "human", id, content: "x" })) },
  checkpoint: { checkpoint_id: checkpointId },
});

it("matches only the exact ordered stable message IDs", () => {
  expect(checkpointForMessages(
    [state(["h-1", "a-1"], "cp-exact")] as never,
    [{ id: "h-1" }, { id: "a-1" }] as never,
  )).toBe("cp-exact");
  expect(checkpointForMessages(
    [state(["a-1", "h-1"])] as never,
    [{ id: "h-1" }, { id: "a-1" }] as never,
  )).toBeNull();
  expect(checkpointForMessages(
    [state(["h-1", undefined])] as never,
    [{ id: "h-1" }, { id: "a-1" }] as never,
  )).toBeNull();
});
```

- [ ] **Step 2: Run the new test and verify it fails to import the missing module**

Run: `pnpm exec vitest run lib/mobile-langgraph-runtime.test.ts`

Expected: FAIL because `mobile-langgraph-runtime.ts` does not exist.

- [ ] **Step 3: Implement exact checkpoint matching**

Create `lib/mobile-langgraph-runtime.ts` and start with:

```ts
import { MessageNotSentError } from "@assistant-ui/core";
import type { Client, ThreadState } from "@langchain/langgraph-sdk";
import type {
  LangChainMessage,
  LangGraphStreamCallback,
  LangGraphInterruptState,
  UIMessage,
  UseLangGraphRuntimeOptions,
} from "@assistant-ui/react-langgraph";

const ASSISTANT_ID = "agent";
const STREAM_MODE = ["messages", "updates", "custom"] as const;

export function checkpointForMessages(
  history: readonly ThreadState[],
  parentMessages: readonly LangChainMessage[],
): string | null {
  for (const item of history) {
    const messages = (item.values as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length !== parentMessages.length) continue;
    if (!parentMessages.every((message) => typeof message.id === "string")) continue;
    if (!messages.every((message) => typeof (message as { id?: unknown })?.id === "string")) continue;
    if (parentMessages.every((message, index) =>
      message.id === (messages[index] as { id: string }).id)) {
      return item.checkpoint.checkpoint_id ?? null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Add failing stream tests for all three official run modes and image preservation**

Append to the new test file:

```ts
const makeClient = () => ({
  runs: { stream: vi.fn(() => (async function* () {})()) },
  threads: {
    getHistory: vi.fn(),
    getState: vi.fn(),
  },
});

const streamConfig = (overrides: Record<string, unknown> = {}) => ({
  command: undefined,
  checkpointId: undefined,
  abortSignal: new AbortController().signal,
  initialize: vi.fn().mockResolvedValue({ remoteId: "thread-1" }),
  ...overrides,
});

it("sends only the latest human message and preserves image-only content", async () => {
  const client = makeClient();
  const runtime = makeMobileLangGraphRuntime(client as never, { current: false });
  const image = [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }];

  await runtime.stream([
    { type: "human", id: "h-old", content: "old" },
    { type: "ai", id: "a-old", content: "answer" },
    { type: "human", id: "h-new", content: image },
  ] as never, streamConfig() as never);

  expect(client.runs.stream).toHaveBeenCalledWith("thread-1", "agent", expect.objectContaining({
    input: { messages: [{ type: "human", id: "h-new", content: image }] },
    streamMode: ["messages", "updates", "custom"],
  }));
});

it("regenerates with null input and the exact checkpoint", async () => {
  const client = makeClient();
  const runtime = makeMobileLangGraphRuntime(client as never, { current: false });
  await runtime.stream([], streamConfig({ checkpointId: "cp-1" }) as never);
  expect(client.runs.stream).toHaveBeenCalledWith("thread-1", "agent", expect.objectContaining({
    input: null,
    checkpointId: "cp-1",
  }));
});

it("resumes an interrupt with top-level command only", async () => {
  const client = makeClient();
  const runtime = makeMobileLangGraphRuntime(client as never, { current: false });
  const command = { resume: { approved: true } };
  await runtime.stream([], streamConfig({ command, checkpointId: "must-not-forward" }) as never);
  expect(client.runs.stream).toHaveBeenCalledWith("thread-1", "agent", {
    command,
    streamMode: ["messages", "updates", "custom"],
    signal: expect.any(AbortSignal),
  });
});
```

- [ ] **Step 5: Add failing tests that missing checkpoints never create runs**

Append:

```ts
it("returns an empty regeneration stream when no checkpoint was selected", async () => {
  const client = makeClient();
  const runtime = makeMobileLangGraphRuntime(client as never, { current: false });
  const result = await runtime.stream([], streamConfig() as never);
  await expect(result.next()).resolves.toMatchObject({ done: true });
  expect(client.runs.stream).not.toHaveBeenCalled();
});

it("rejects an edited send after an exact checkpoint lookup fails", async () => {
  const client = makeClient();
  client.threads.getHistory.mockResolvedValue([state(["different"])]);
  const lookup = { current: false };
  const runtime = makeMobileLangGraphRuntime(client as never, lookup);

  await expect(runtime.getCheckpointId("thread-1", [{ id: "h-1" }] as never)).resolves.toBeNull();
  await expect(runtime.stream(
    [{ type: "human", id: "h-edited", content: "edited" }] as never,
    streamConfig() as never,
  )).rejects.toBeInstanceOf(MessageNotSentError);
  expect(client.runs.stream).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Implement the official stream/load/checkpoint adapter**

Complete `makeMobileLangGraphRuntime`:

```ts
type CheckpointLookup = { current: boolean };
type MobileLangGraphRuntime = Pick<
  UseLangGraphRuntimeOptions,
  "stream" | "load" | "getCheckpointId"
>;

export function makeMobileLangGraphRuntime(
  client: Client,
  checkpointLookup: CheckpointLookup,
): MobileLangGraphRuntime {
  const stream: LangGraphStreamCallback<LangChainMessage> = async (messages, options) => {
    const failedLookup = checkpointLookup.current;
    checkpointLookup.current = false;
    if (!options.command && failedLookup) {
      if (messages.length === 0) return (async function* emptyRun() {})();
      throw new MessageNotSentError(
        "The persisted checkpoint for this message is unavailable. Reload the conversation and try again.",
      );
    }
    if (!options.command && messages.length === 0 && !options.checkpointId) {
      return (async function* emptyRun() {})();
    }

    const { remoteId } = await options.initialize();
    if (options.command) {
      return client.runs.stream(remoteId, ASSISTANT_ID, {
        command: options.command,
        streamMode: [...STREAM_MODE],
        signal: options.abortSignal,
      });
    }
    const latestHuman = messages.filter((message) => message.type === "human").slice(-1);
    return client.runs.stream(remoteId, ASSISTANT_ID, {
      input: messages.length === 0 ? null : { messages: latestHuman },
      checkpointId: options.checkpointId,
      streamMode: [...STREAM_MODE],
      signal: options.abortSignal,
    });
  };

  return {
    stream,
    load: async (threadId: string, options?: { signal?: AbortSignal }) => {
      const state = await client.threads.getState(threadId, undefined, { signal: options?.signal });
      const value = state as unknown as {
        values?: { messages?: LangChainMessage[]; ui?: unknown[] };
        interrupts?: LangGraphInterruptState[];
        tasks?: Array<{ interrupts?: LangGraphInterruptState[] }>;
      };
      return {
        messages: (value.values?.messages ?? []).filter((message) =>
          message.type === "human" || message.type === "ai" || message.type === "tool"),
        interrupts: value.interrupts ?? value.tasks?.flatMap((task) => task.interrupts ?? []),
        uiMessages: Array.isArray(value.values?.ui) ? value.values.ui as UIMessage[] : [],
      };
    },
    getCheckpointId: async (threadId: string, parentMessages: LangChainMessage[]) => {
      const checkpointId = checkpointForMessages(
        await client.threads.getHistory(threadId),
        parentMessages,
      );
      checkpointLookup.current = !checkpointId;
      return checkpointId;
    },
  };
}
```

- [ ] **Step 7: Rewire the React hook to the focused adapter**

In `hooks/use-app-runtime.ts`:

```ts
import { useMemo, useRef } from "react";
import { makeMobileLangGraphRuntime } from "@/lib/mobile-langgraph-runtime";
```

Remove `unstable_createLangGraphStream` and the inline `load`. Then wire:

```ts
const checkpointLookupFailed = useRef(false);
const langGraph = useMemo(
  () => makeMobileLangGraphRuntime(client, checkpointLookupFailed),
  [client],
);

return useLangGraphRuntime({
  ...langGraph,
  unstable_threadListAdapter: threadListAdapter,
  unstable_allowCancellation: true,
  uiComponents: { fallback: GenericDataFallback },
});
```

Do not add a manual fetch/SSE implementation; `client.runs.stream` remains the sole transport.

- [ ] **Step 8: Document mobile ownership and platform-specific UI**

Add this concise section to `m/README.md`:

```markdown
## Assistant runtime boundary

The mobile assistant uses the official assistant-ui React Native primitives and
`useLangGraphRuntime` with the official LangGraph SDK. It calls the authenticated
backend `/v1/assistant` gateway; it does not connect to Agent Server directly,
store a second conversation history, or own tenant metadata. The backend owns
authorization and business records, while Agent Server owns copilot thread state,
checkpoints, interrupts, runs, and cancellation.
```

- [ ] **Step 9: Run focused mobile verification**

Run:

```powershell
pnpm exec vitest run lib/mobile-langgraph-runtime.test.ts hooks/use-app-runtime.test.ts
pnpm exec tsc --noEmit
git diff --check
```

Expected: all cases PASS, including exact checkpoint matching, no-run failure behavior, top-level resume, latest-human selection, abort signal forwarding, and image-only content preservation.

- [ ] **Step 10: Commit mobile runtime parity**

```powershell
git add lib/mobile-langgraph-runtime.ts lib/mobile-langgraph-runtime.test.ts hooks/use-app-runtime.ts README.md
git commit -m "fix(copilot): add checkpoint-safe mobile runtime"
```

---

### Task 5: Pin the TypeScript customer-decision boundary to versioned fixtures

**Files:**
- Create: `back-end/src/modules/ai-agent/customer/fixtures/customer-agent-decision.v1.json`
- Modify: `back-end/src/modules/ai-agent/customer/customerAgent.types.ts`
- Modify: `back-end/src/modules/ai-agent/customer/customerAgent.types.test.ts`
- Modify: `back-end/docs/architecture/assistant-runtime.md`

**Interfaces:**
- Consumes: existing `customerAgentDecisionSchema` and backend ownership of handoff/follow-up/delivery.
- Produces: `CUSTOMER_AGENT_DECISION_CONTRACT_VERSION = 1`, strict outer/attachment Zod objects, and a fixture corpus copied exactly by Task 6.

- [ ] **Step 1: Create the versioned decision corpus**

Create `customer-agent-decision.v1.json` with exactly:

```json
{
  "contract_version": 1,
  "valid": [
    {
      "name": "reply_with_attachment",
      "value": {
        "action": "REPLY",
        "content": "Here is the brochure.",
        "reason_code": "KNOWLEDGE_MATCH",
        "handoff_category": null,
        "attachment": { "asset_name": "brochure", "caption": "Product details" }
      }
    },
    {
      "name": "handoff_without_content",
      "value": {
        "action": "HANDOFF",
        "content": null,
        "reason_code": "HUMAN_ACTION_REQUIRED",
        "handoff_category": "SUPPORT",
        "attachment": null
      }
    },
    {
      "name": "policy_no_reply",
      "value": {
        "action": "NO_REPLY",
        "reason_code": "POLICY_SUPPRESSED"
      }
    }
  ],
  "invalid": [
    {
      "name": "reply_without_content",
      "value": { "action": "REPLY", "reason_code": "KNOWLEDGE_MATCH" }
    },
    {
      "name": "no_reply_with_content",
      "value": {
        "action": "NO_REPLY",
        "content": "must not send",
        "reason_code": "POLICY_SUPPRESSED"
      }
    },
    {
      "name": "attachment_on_handoff",
      "value": {
        "action": "HANDOFF",
        "reason_code": "HUMAN_ACTION_REQUIRED",
        "handoff_category": "SUPPORT",
        "attachment": { "asset_name": "brochure" }
      }
    },
    {
      "name": "blank_attachment_name",
      "value": {
        "action": "REPLY",
        "content": "Attached.",
        "reason_code": "KNOWLEDGE_MATCH",
        "attachment": { "asset_name": "   " }
      }
    },
    {
      "name": "unknown_top_level_field",
      "value": {
        "action": "NO_REPLY",
        "reason_code": "POLICY_SUPPRESSED",
        "workspace_id": 999
      }
    },
    {
      "name": "unknown_attachment_field",
      "value": {
        "action": "REPLY",
        "content": "Attached.",
        "reason_code": "KNOWLEDGE_MATCH",
        "attachment": { "asset_name": "brochure", "url": "https://untrusted.test" }
      }
    }
  ]
}
```

- [ ] **Step 2: Add failing fixture-driven TypeScript tests**

At the top of `customerAgent.types.test.ts`, load the JSON with `readFileSync` and add:

```ts
import fs from "node:fs";
import path from "node:path";
import {
  CUSTOMER_AGENT_DECISION_CONTRACT_VERSION,
  customerAgentDecisionSchema,
} from "./customerAgent.types";

const decisionFixture = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), "src/modules/ai-agent/customer/fixtures/customer-agent-decision.v1.json"),
  "utf8",
)) as {
  contract_version: number;
  valid: Array<{ name: string; value: unknown }>;
  invalid: Array<{ name: string; value: unknown }>;
};

it("matches customer decision contract version 1", () => {
  expect(decisionFixture.contract_version).toBe(CUSTOMER_AGENT_DECISION_CONTRACT_VERSION);
});

it.each(decisionFixture.valid)("accepts parity fixture $name", ({ value }) => {
  expect(() => customerAgentDecisionSchema.parse(value)).not.toThrow();
});

it.each(decisionFixture.invalid)("rejects parity fixture $name", ({ value }) => {
  expect(() => customerAgentDecisionSchema.parse(value)).toThrow();
});
```

- [ ] **Step 3: Run the schema tests and verify unknown fields fail the test expectation**

Run: `npm test -- src/modules/ai-agent/customer/customerAgent.types.test.ts`

Expected: FAIL on the unknown-field fixtures because Zod currently strips unknown keys.

- [ ] **Step 4: Make the decision schema strict and versioned**

In `customerAgent.types.ts`:

```ts
export const CUSTOMER_AGENT_DECISION_CONTRACT_VERSION = 1 as const;

const customerAttachmentRequestSchema = z.object({
  asset_name: z.string().trim().min(1).max(255),
  caption: z.string().trim().max(1000).nullable().optional(),
}).strict();

export const customerAgentDecisionSchema = z.object({
  action: z.enum(["REPLY", "HANDOFF", "RESOLVE", "NO_REPLY"]),
  content: z.string().trim().min(1).max(4000).nullable().optional(),
  reason_code: z.enum([
    "KNOWLEDGE_MATCH",
    "HUMAN_ACTION_REQUIRED",
    "INSUFFICIENT_KNOWLEDGE",
    "CUSTOMER_CLOSED",
    "POLICY_SUPPRESSED",
    "QUOTA_EXCEEDED",
  ]),
  handoff_category: z.enum(["SALES", "SUPPORT", "COMPLAINT", "OTHER"]).nullable().optional(),
  attachment: customerAttachmentRequestSchema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "REPLY" && !value.content) {
    ctx.addIssue({
      code: "custom",
      path: ["content"],
      message: "REPLY requires content",
    });
  }
  if (value.action !== "REPLY" && value.content) {
    ctx.addIssue({
      code: "custom",
      path: ["content"],
      message: "Only REPLY may contain content",
    });
  }
  if (value.action !== "REPLY" && value.attachment) {
    ctx.addIssue({
      code: "custom",
      path: ["attachment"],
      message: "Only REPLY may request an attachment",
    });
  }
});
```

- [ ] **Step 5: Document the two conversation ownership paths**

Update `docs/architecture/assistant-runtime.md` so its opening and ownership sections explicitly include:

```markdown
There are two durable conversation paths:

1. Business-owner copilot sessions are LangGraph Agent Server threads reached
   through `/v1/assistant`; Agent Server owns their messages, runs, checkpoints,
   interrupts, and cancellation.
2. Customer-channel conversations (web widget, WhatsApp, Messenger, and Facebook
   comments) are backend/Prisma business records. Each record points to a stable
   `customer_agent` Agent Server thread for execution state. The backend owns
   delivery, human handoff, follow-up schedules, audit state, and channel effects.

Follow-ups are ordinary backend-scheduled jobs. When work is due, the backend
starts or resumes the existing customer graph run; the graph does not sleep as a
scheduler and does not replace the business conversation record.
```

Also replace any stale backend SDK statement with the exact supported version `@langchain/langgraph-sdk` 1.11.0.

- [ ] **Step 6: Run focused backend decision checks**

Run:

```powershell
npm test -- src/modules/ai-agent/customer/customerAgent.types.test.ts src/modules/ai-agent/customer/customerAgent.service.test.ts src/modules/ai-agent/customer/customerDecision.service.test.ts
npm run build
git diff --check
```

Expected: fixtures and existing decision/handoff behavior PASS; build and whitespace check pass.

- [ ] **Step 7: Commit the backend decision contract**

```powershell
git add src/modules/ai-agent/customer/fixtures/customer-agent-decision.v1.json src/modules/ai-agent/customer/customerAgent.types.ts src/modules/ai-agent/customer/customerAgent.types.test.ts docs/architecture/assistant-runtime.md
git commit -m "test(agent): version customer decision contract"
```

---

### Task 6: Enforce the same decision corpus in the Python agent service

**Files:**
- Create: `agent-svc/tests/fixtures/customer-agent-decision.v1.json`
- Create: `agent-svc/tests/test_langgraph_manifest.py`
- Modify: `agent-svc/src/agent_svc/customer_schemas.py`
- Modify: `agent-svc/tests/test_customer_schemas.py`
- Modify: `agent-svc/README.md`

**Interfaces:**
- Consumes: Task 5 fixture bytes and contract version `1`.
- Produces: `CUSTOMER_AGENT_DECISION_CONTRACT_VERSION = 1` and Pydantic tests that accept/reject the same named cases as the backend.

- [ ] **Step 1: Copy the exact parity fixture into the agent repository**

Create `tests/fixtures/customer-agent-decision.v1.json` with byte-for-byte identical JSON content from Task 5. Do not translate field names to Python snake_case; the fixture represents the external JSON contract.

- [ ] **Step 2: Add failing versioned fixture tests**

In `tests/test_customer_schemas.py`, add:

```py
from pathlib import Path

from agent_svc.customer_schemas import (
    CUSTOMER_AGENT_DECISION_CONTRACT_VERSION,
    CustomerAgentDecision,
)

DECISION_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "customer-agent-decision.v1.json").read_text(
        encoding="utf-8"
    )
)


def test_customer_decision_contract_version_matches_fixture():
    assert DECISION_FIXTURE["contract_version"] == CUSTOMER_AGENT_DECISION_CONTRACT_VERSION


@pytest.mark.parametrize("case", DECISION_FIXTURE["valid"], ids=lambda case: case["name"])
def test_customer_decision_accepts_parity_fixture(case):
    CustomerAgentDecision.model_validate(case["value"])


@pytest.mark.parametrize("case", DECISION_FIXTURE["invalid"], ids=lambda case: case["name"])
def test_customer_decision_rejects_parity_fixture(case):
    with pytest.raises(ValidationError):
        CustomerAgentDecision.model_validate(case["value"])
```

- [ ] **Step 3: Run the focused Python test and verify the missing version constant fails collection**

Run: `uv run --locked --extra dev pytest -q tests/test_customer_schemas.py`

Expected: FAIL during import because `CUSTOMER_AGENT_DECISION_CONTRACT_VERSION` is not defined.

- [ ] **Step 4: Add the Python contract version constant**

Near the customer-decision declarations in `customer_schemas.py`, add:

```py
CUSTOMER_AGENT_DECISION_CONTRACT_VERSION = 1
```

Keep `ConfigDict(extra="forbid")` on `CustomerAgentDecision` and `CustomerAttachmentRequest`; the fixture tests must prove that tenant fields and undeclared attachment URLs do not cross the model boundary.

- [ ] **Step 5: Pin graph handles and document the agent-service ownership boundary**

Create `tests/test_langgraph_manifest.py` so the deployment handles cannot drift silently from backend/client contracts:

```py
import json
from pathlib import Path


def test_deployed_graph_handles_are_stable():
    manifest = json.loads(
        (Path(__file__).parents[1] / "langgraph.json").read_text(encoding="utf-8")
    )

    assert manifest["graphs"] == {
        "agent": "./src/agent_svc/agent_graph.py:graph",
        "customer_agent": "./src/agent_svc/customer_graph.py:graph",
        "rag_ingest": "./src/agent_svc/rag/rag_ingest_graph.py:graph",
        "capability": "./src/agent_svc/capability_graph.py:graph",
    }
```

Then document the agent-service side of the ownership boundary.

Add to `agent-svc/README.md`:

```markdown
## Durable ownership boundary

Agent Server owns graph runs, checkpoints, interrupts, and retrieval state. It
does not own the business system of record for web-widget, WhatsApp, Messenger,
or Facebook-comment conversations. The Node.js backend owns those conversation
and message records, human handoff, follow-up scheduling, delivery, and channel
effects; it invokes the stable `customer_agent` thread when execution is needed.
Business-owner copilot sessions use the separate `agent` graph through the
authenticated backend `/v1/assistant` gateway.
```

- [ ] **Step 6: Run focused Python validation**

Run:

```powershell
uv run --locked --extra dev pytest -q tests/test_customer_schemas.py tests/test_customer_graph.py tests/test_langgraph_manifest.py
uv run --locked --extra dev ruff check src tests
uv run --locked --extra dev ruff format --check src tests
uv lock --check
git diff --check
```

Expected: fixture parity, graph tests, Ruff, lock verification, and whitespace checks PASS.

- [ ] **Step 7: Commit the Python parity contract**

```powershell
git add tests/fixtures/customer-agent-decision.v1.json tests/test_langgraph_manifest.py src/agent_svc/customer_schemas.py tests/test_customer_schemas.py README.md
git commit -m "test(customer-agent): pin decision contract parity"
```

---

### Task 7: Run cross-repository verification and review the focused commits

**Files:**
- Verify only: all files and commits produced by Tasks 1–6.

**Interfaces:**
- Consumes: canonical OpenAPI header/request contract, web and mobile adapters, SDK 1.11.0 serialization, versioned TypeScript/Python decision corpus.
- Produces: evidence that all four repositories remain independently buildable and that no unrelated files, database migrations, or custom protocol/UI layers were introduced.

- [ ] **Step 1: Verify the backend repository**

Run from `back-end/`:

```powershell
npm test
npm run docs:check
npm run build
git diff --check
git status --short
git log -3 --oneline
```

Expected: complete suite/docs/build PASS; status clean; only the focused Task 1 and Task 5 commits appear above the prior spec commit.

- [ ] **Step 2: Verify the agent service repository**

Run from `agent-svc/`:

```powershell
uv run --locked --extra dev pytest -q
uv run --locked --extra dev ruff check src tests
uv run --locked --extra dev ruff format --check src tests
uv lock --check
git diff --check
git status --short
git log -2 --oneline
```

Expected: complete suite and Ruff PASS; lock valid; status clean; one focused parity/docs commit.

- [ ] **Step 3: Verify the web repository**

Run from `app/`:

```powershell
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
git diff --check
git status --short
git log -2 --oneline
```

Expected: tests, typecheck, lint, and production build PASS; status clean; generated OpenAPI type update is committed with its consumer.

- [ ] **Step 4: Verify the mobile repository**

Run from `m/`:

```powershell
pnpm exec vitest run
pnpm exec tsc --noEmit
pnpm run export:web
git diff --check
git status --short
git log -3 --oneline
```

Expected: tests, typecheck, and Expo web export PASS; status clean; dependency/thread alignment and checkpoint runtime remain separate focused commits.

- [ ] **Step 5: Audit forbidden architecture drift across the workspace**

Run from `D:\wkil` using PowerShell because `rg` may be unavailable on this host:

```powershell
Get-ChildItem app/src,m/hooks,m/lib,m/components,back-end/src -Recurse -File | Select-String -Pattern "EventSource|ReadableStream.*getReader|AssistantCloud|workspace_id.*threads.create"
Get-ChildItem back-end/src,agent-svc/src -Recurse -File | Select-String -Pattern "setTimeout.*follow|sleep.*follow|schedule.*LangGraph"
```

Expected: no newly introduced manual SSE parser, AssistantCloud store, client-supplied workspace metadata, or graph-owned follow-up scheduler. Existing unrelated matches must be reviewed in context rather than modified opportunistically.

- [ ] **Step 6: Run the live acceptance gate when local services and non-production credentials are available**

First check service availability without printing configuration values:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:8123/ok
Invoke-WebRequest -UseBasicParsing http://localhost:8080/health
```

If both services are reachable and a non-production authenticated account is already configured, use the existing web app and Expo development client to verify: create/list/load/rename/delete; one ordinary turn; Stop/cancel; refresh and approve/reject an interrupt; exact-checkpoint edit/regenerate; image-only mobile send; and cross-workspace denial. Then trigger one controlled customer-agent result for each of `REPLY`, `HANDOFF`, `RESOLVE`, and `NO_REPLY`, confirming that handoff and follow-up records remain in the backend database. Do not expose credentials or production customer data. If services, credentials, or a simulator are absent, record each live case as unverified rather than passed.

- [ ] **Step 7: Perform fresh review gates using the user-selected models**

Use a fresh `gpt-6-sol` reviewer at `high` effort after each implementation task and a final `gpt-6-sol` reviewer at `high` effort across all commits. Implementation tasks are assigned to fresh `gpt-6-luna` workers at `max` effort. Review specifically against the five Review Focus cases and reject any custom protocol, duplicated authorization, client-owned tenant metadata, or widget/mobile UI rewrite.

- [ ] **Step 8: Report the verified result without pushing or deploying**

Report the commit hashes per repository, exact verification commands/results, any unavailable live credential-dependent checks, and the unchanged deployment/migration state. Do not push, merge, deploy, publish, or migrate.
