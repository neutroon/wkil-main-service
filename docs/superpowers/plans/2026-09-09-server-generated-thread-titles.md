# Server-generated Copilot Thread Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move deterministic Copilot title generation to the authenticated backend gateway so web and React Native only read and display server-stored titles.

**Architecture:** On each non-resume assistant run, the backend gateway extracts a normalized first-message title, reads the scoped LangGraph thread, and patches metadata only when no valid title exists. The two clients keep the assistant-ui adapter contract but replace message-based title generation with a metadata read used only to refresh local UI state.

**Tech Stack:** Express 5, TypeScript 5.9, LangGraph SDK 1.10, Vitest 3, Next.js/assistant-ui React, Expo React Native/assistant-ui React Native.

**Spec:** `back-end/docs/superpowers/specs/2026-09-09-server-generated-thread-titles-design.md`

## Global Constraints

- Server is the single authority for automatic titles.
- Automatic titles are deterministic: collapsed whitespace, word-boundary truncation, maximum 48 visible characters plus an ellipsis when truncated.
- Existing valid titles and explicit manual renames must never be overwritten by automatic generation.
- Resume commands and image-only messages must not trigger automatic title creation.
- Automatic title persistence is best effort and must not break an assistant run.
- Client `generateTitle` hooks may read server metadata but must not inspect messages or derive titles.
- Preserve all unrelated existing working-tree changes in the backend, web, and React Native repositories.

### Task 1: Add server-side title normalization and persistence

**Files:**
- Modify: `back-end/src/modules/ai-agent/assistant.gateway.ts:137-406`
- Test: `back-end/src/modules/ai-agent/assistant.gateway.test.ts`

**Interfaces:**
- Produces `deterministicThreadTitle(raw: string): string` and `automaticTitleFromRun(normalized: PlainRecord | undefined): string | undefined` as gateway internals for focused tests.
- Produces `ensureThreadTitle(params): Promise<void>`, which reads thread metadata and persisted state through the trusted LangGraph API and patches `metadata.title` only when missing.

- [ ] **Step 1: Write failing tests for string title validation and deterministic extraction**

Add tests to `assistant.gateway.test.ts`:

```ts
it("preserves string titles in create and update normalization", () => {
  expect(assistantGatewayInternals.normalizeBody("create", {
    metadata: { title: "  Existing title  " },
  }, scope)).toMatchObject({
    metadata: { workspace_id: 11, title: "Existing title" },
  });

  expect(assistantGatewayInternals.normalizeBody("update", {
    metadata: { title: "Renamed title" },
  }, scope)).toMatchObject({
    metadata: { workspace_id: 11, title: "Renamed title" },
  });
});

it("derives a deterministic title from the normalized first human message", () => {
  expect(assistantGatewayInternals.automaticTitleFromRun({
    input: {
      messages: [{
        type: "human",
        content: "  Plan   a launch\nfor my store  ",
      }],
    },
  })).toBe("Plan a launch for my store");
});

it("does not derive a title from image-only input or resume commands", () => {
  expect(assistantGatewayInternals.automaticTitleFromRun({
    input: { messages: [{ type: "human", content: [{
      type: "image_url", image_url: "data:image/png;base64,AAAA",
    }] }] },
  })).toBeUndefined();
  expect(assistantGatewayInternals.automaticTitleFromRun({
    command: { resume: { approved: true } },
  })).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused backend test and verify it fails for the expected reason**

Run: `pnpm vitest run src/modules/ai-agent/assistant.gateway.test.ts`

Expected: FAIL because string titles are currently rejected by `clientTitle`, and the automatic-title internals do not exist yet.

- [ ] **Step 3: Implement the pure server title helpers**

Replace the object check in `clientTitle` with string validation through `validTitle`, then add the following behavior near the existing message-content helpers:

```ts
function deterministicThreadTitle(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  const boundary = cut.lastIndexOf(" ");
  return `${cut.slice(0, boundary > 20 ? boundary : 48)}…`;
}

function automaticTitleFromRun(normalized: PlainRecord | undefined): string | undefined {
  if (!normalized || normalized.command !== undefined) return undefined;
  const input = isPlainRecord(normalized.input) ? normalized.input : undefined;
  const messages = input && Array.isArray(input.messages) ? input.messages : [];
  const message = messages[0];
  if (!isPlainRecord(message)) return undefined;
  const text = textFromMessageContent(message.content);
  const title = deterministicThreadTitle(text);
  return title || undefined;
}
```

Export the helpers through `assistantGatewayInternals` for tests without making them public HTTP API.

- [ ] **Step 4: Add the failing persistence test with an injected fetch implementation**

Add a test for the helper's upstream contract:

```ts
it("sets a server title from the earliest persisted human message", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ metadata: {} }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ values: {
      messages: [{ type: "human", content: "Earlier server message" }],
    } }), { status: 200 }))
    .mockResolvedValueOnce(new Response("{}", { status: 200 }));

  await assistantGatewayInternals.ensureThreadTitle({
    apiUrl: "https://agent.test",
    threadId: "thread-1",
    title: "Current message must not win",
    headers: new Headers({ "x-api-key": "test-key" }),
    signal: new AbortController().signal,
    fetchImpl,
  });

  expect(fetchImpl).toHaveBeenNthCalledWith(
    3,
    "https://agent.test/threads/thread-1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ metadata: { title: "Earlier server message" } }),
    }),
  );
});
```

Also test that a thread with `metadata.title` performs only the metadata read, an empty state falls back to the current normalized message title, and a failed read or patch resolves without throwing.

- [ ] **Step 5: Run the persistence test and verify it fails before implementation**

Run: `pnpm vitest run src/modules/ai-agent/assistant.gateway.test.ts`

Expected: FAIL because `ensureThreadTitle` does not exist.

- [ ] **Step 6: Implement scoped best-effort metadata persistence**

Add `ensureThreadTitle` with an injected `fetchImpl` defaulting to global `fetch`. It must GET `/threads/{encodedThreadId}`, parse a plain response record, return without another request when `metadata.title` passes `validTitle`, then GET `/threads/{encodedThreadId}/state` and choose the earliest persisted human message. If state has no human message, use the current-run candidate passed by the caller. PATCH the same thread with `{ metadata: { title } }` only when a non-empty title exists. Copy the gateway's trusted headers into each request and add `content-type: application/json` only to PATCH. Catch and log upstream title errors using the existing logger; never rethrow them.

In `assistantGateway`, create the request ID and trusted upstream headers before the title operation. For endpoint `run`, call `automaticTitleFromRun(normalized)` and, when both a title and `threads/{id}/runs/stream` thread ID are present, await `ensureThreadTitle` before forwarding the original run. Do not call it for resume commands or other endpoints. Keep the existing abort handling and run proxy behavior intact.

- [ ] **Step 7: Run all backend assistant gateway tests**

Run: `pnpm vitest run src/modules/ai-agent/assistant.gateway.test.ts`

Expected: PASS, including the new title tests and all existing gateway contract tests.

- [ ] **Step 8: Commit the backend implementation**

Run:

```bash
git add src/modules/ai-agent/assistant.gateway.ts src/modules/ai-agent/assistant.gateway.test.ts
git commit -m "feat: generate copilot titles on the server"
```

### Task 2: Make the web adapter read server titles only

**Files:**
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.tsx:53-148`
- Test: `app/src/components/user/copilot/overlay/CopilotRuntime.test.tsx`

**Interfaces:**
- Consumes the backend metadata contract from Task 1.
- Produces a web `generateTitle(remoteId)` adapter method that reads `client.threads.get(remoteId).metadata.title` and returns that value as an assistant stream.

- [ ] **Step 1: Write the failing web adapter test**

Extend the existing `threadMock` with `get`, then add:

```ts
it("reads the server title without deriving or updating it from messages", async () => {
  threadMock.get.mockResolvedValue({ metadata: { title: "Server title" } });
  const adapter = makeThreadListAdapter(11);

  const stream = await adapter.generateTitle("thread-1", [{
    role: "user",
    content: "A different client-only title must be ignored",
  }] as never);

  expect(threadMock.get).toHaveBeenCalledWith("thread-1");
  expect(threadMock.update).not.toHaveBeenCalled();
  expect(stream).toBeDefined();
});
```

- [ ] **Step 2: Run the focused web test and verify it fails**

Run: `pnpm vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx`

Expected: FAIL because the current adapter reads the passed message and calls `threads.update`.

- [ ] **Step 3: Replace web title derivation with a server metadata read**

Remove the web-only `textOf`, `makeTitle`, and title update logic. Implement `generateTitle(remoteId)` by reading the thread metadata, extracting a non-empty string title, and returning it via `createAssistantStream`; return an empty stream when the read fails or no title exists. Keep explicit `rename(remoteId, title)` unchanged so manual rename remains server-backed.

- [ ] **Step 4: Run web runtime tests**

Run: `pnpm vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx`

Expected: PASS, with no `threads.update` call from automatic title refresh.

- [ ] **Step 5: Commit the web implementation**

Run:

```bash
git add src/components/user/copilot/overlay/CopilotRuntime.tsx src/components/user/copilot/overlay/CopilotRuntime.test.tsx
git commit -m "refactor(web): read copilot titles from server"
```

### Task 3: Make the React Native adapter read server titles only

**Files:**
- Modify: `app-mobile-rn/hooks/use-app-runtime.ts:17-97`
- Test: `app-mobile-rn/hooks/use-app-runtime.test.ts`

**Interfaces:**
- Consumes the same backend metadata contract from Task 1.
- Produces a React Native `generateTitle(remoteId)` adapter method that reads server metadata and never derives a title from message content.

- [ ] **Step 1: Write the failing React Native adapter test**

Create a focused test with a structural thread client mock exposing `get`, `update`, `search`, `create`, and `delete`. Assert that `generateTitle` calls `get`, never calls `update`, and returns an assistant stream when passed a misleading user message.

- [ ] **Step 2: Run the focused React Native test and verify it fails**

Run: `pnpm vitest run hooks/use-app-runtime.test.ts`

Expected: FAIL because the current adapter derives a title and calls `threads.update`.

- [ ] **Step 3: Remove React Native title derivation**

Remove `messageText` and `generatedTitle`. Change `generateTitle` to read `client.threads.get(remoteId)`, extract a non-empty metadata title, and return it through `createAssistantStream`. Swallow read failures as an empty title stream so title refresh cannot break chat.

- [ ] **Step 4: Run all React Native tests**

Run: `pnpm vitest run`

Expected: PASS, including the new adapter test and the existing 11 tests.

- [ ] **Step 5: Commit the React Native implementation**

Run:

```bash
git add hooks/use-app-runtime.ts hooks/use-app-runtime.test.ts
git commit -m "refactor(mobile): read copilot titles from server"
```

### Task 4: Cross-repository verification

**Files:**
- No production files; verify the files changed in Tasks 1–3.

- [ ] **Step 1: Run backend, web, and React Native focused tests again**

Run:

```powershell
pnpm --dir back-end vitest run src/modules/ai-agent/assistant.gateway.test.ts
pnpm --dir app vitest run src/components/user/copilot/overlay/CopilotRuntime.test.tsx src/components/user/copilot/overlay/CopilotRuntime.restore.test.tsx
pnpm --dir app-mobile-rn vitest run
```

Expected: all commands exit 0.

- [ ] **Step 2: Verify no client-side automatic title algorithm remains**

Run:

```powershell
rg -n "makeTitle|generatedTitle|messageText|textOf|generateTitle" app/src/components/user/copilot app-mobile-rn/hooks/use-app-runtime.ts
```

Expected: only adapter method declarations and server metadata reads remain; no client title derivation helper or message parsing remains.

- [ ] **Step 3: Run TypeScript checks for the web and React Native clients**

Run:

```powershell
pnpm --dir app exec tsc --noEmit
pnpm --dir app-mobile-rn exec tsc --noEmit
```

Expected: both commands exit 0. Record any pre-existing backend Prisma-generated type errors separately if the backend typecheck remains red.
