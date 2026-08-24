# Copilot True Regenerate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Reload button truly regenerate the assistant response (replace the original) instead of appending a duplicate user message + new assistant.

**Architecture:** New endpoint `POST /v1/copilot/messages/:userMsgId/regenerate` deletes messages after the parent user message, then runs the graph with the parent's text. Background runner persists ASSISTANT and emits the existing `copilot:message`/`copilot:cancelled`/`copilot:error` socket events. Frontend `store.onReload` calls the new endpoint instead of `postMessage`.

**Tech Stack:** Node.js, TypeScript, Express, LangGraph (`graph.invoke({ signal })`), AbortController, vitest. Next.js 15, React 19, `@assistant-ui/react@0.15.16`.

## Global Constraints

- No new dependencies.
- Backend test framework: vitest. Frontend: no test runner (manual smoke test).
- `userId` for the regenerate request is derived from `req.user.id` (authenticated user), not request body.
- `userMsgId` is validated via ownership check (returns 404 for both missing AND foreign-owned — no info leak).
- On success: delete messages after parent, run graph, persist ASSISTANT, emit `copilot:message` with `runId`.
- On AbortError: emit `copilot:cancelled`, no persist.
- On other error: emit `copilot:error`, no persist.
- `always`: `activeRuns.delete(runId)` in `finally`.
- HTTP responses follow the codebase `{ data: ... }` / `{ error: ... }` envelope convention (same convention as the cancel feature).
- The frontend uses the existing `currentRunId` + `cancelRun` infrastructure — Stop button works during regenerate with no additional wiring.
- No DB migration — uses existing `copilot_messages` table.

---

## File Structure

**Backend (modified):**
- `back-end/src/modules/copilot/copilot.store.ts` — add `getCopilotMessageById`, `deleteCopilotMessagesAfter`
- `back-end/src/modules/copilot/copilot.service.ts` — add `startCopilotRegenerate`, `runCopilotRegenerateBackground`
- `back-end/src/modules/copilot/copilot.controller.ts` — add `regenerateCopilotMessageController`
- `back-end/src/modules/copilot/copilot.routes.ts` — add `POST /v1/copilot/messages/:userMsgId/regenerate`
- `back-end/src/modules/copilot/copilot.service.test.ts` — add regenerate tests
- `back-end/src/modules/copilot/copilot.controller.test.ts` — add controller tests

**Frontend (modified):**
- `app/src/lib/copilot-api.ts` — add `regenerateMessage(userMsgId)` method
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` — `store.onReload` rewires to call `regenerateMessage`

---

## Task 1: Add store helpers `getCopilotMessageById` + `deleteCopilotMessagesAfter`

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.store.ts`
- Test: existing test patterns (none directly — these are exercised by Task 2's service tests)

**Interfaces:**
- Consumes: existing `getCopilotMessageById(messageId, userId): Promise<CopilotMessage | null>` returns one message scoped to user, or null
- Produces: `deleteCopilotMessagesAfter(conversationId, userMsgId, userId): Promise<void>` deletes all messages with `conversationId = X AND user_id = Y AND created_at > parent.created_at`

- [ ] **Step 1: Read existing store** — note the existing functions (`getOrCreateCopilotConversation`, `getCopilotConversationForUser`, `appendCopilotMessage`, `listCopilotMessages`, etc.) and their import pattern.

- [ ] **Step 2: Write the failing test (in `copilot.service.test.ts` — the existing service tests cover the store layer via mocks, but for the actual store SQL we'd need an integration test)**

Skip the integration test for the store SQL — the service-level tests in Task 2 will exercise the store functions via the service mock. Document in the test that the SQL was hand-written per the spec.

- [ ] **Step 3: Add `getCopilotMessageById` to `copilot.store.ts`**

Read `copilot.store.ts` to find the right pattern (Prisma client + existing query helpers). Add:

```ts
export async function getCopilotMessageById(
  messageId: number,
  userId: number,
): Promise<CopilotMessage | null> {
  const msg = await prisma.copilotMessage.findFirst({
    where: { id: messageId, userId },
  });
  return msg;
}
```

Verify: the Prisma model name is `copilotMessage` (or whatever the existing code uses for similar queries — match it).

- [ ] **Step 4: Add `deleteCopilotMessagesAfter` to `copilot.store.ts`**

```ts
export async function deleteCopilotMessagesAfter(
  conversationId: number,
  userMsgId: number,
  userId: number,
): Promise<void> {
  // Two-step: fetch the parent's created_at, then delete by strict > comparison.
  // Done in a transaction so a race with a concurrent insert can't delete the parent.
  await prisma.$transaction(async (tx) => {
    const parent = await tx.copilotMessage.findFirst({
      where: { id: userMsgId, userId },
      select: { createdAt: true },
    });
    if (!parent) return;
    await tx.copilotMessage.deleteMany({
      where: {
        conversationId,
        userId,
        createdAt: { gt: parent.createdAt },
      },
    });
  });
}
```

- [ ] **Step 5: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add back-end/src/modules/copilot/copilot.store.ts
git commit -m "feat(copilot): add store helpers for regenerate

- getCopilotMessageById(messageId, userId): single-message lookup
  scoped to the user (returns null for missing OR foreign-owned, no
  info leak)
- deleteCopilotMessagesAfter(conversationId, userMsgId, userId):
  deletes messages with created_at > parent.created_at AND same
  conversation + user. Wrapped in a Prisma transaction so a concurrent
  insert can't delete the parent."
```

---

## Task 2: Add `startCopilotRegenerate` + `runCopilotRegenerateBackground` to the service

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.service.ts`
- Modify: `back-end/src/modules/copilot/copilot.service.test.ts`

**Interfaces:**
- Consumes: `getCopilotMessageById`, `listCopilotMessages`, `deleteCopilotMessagesAfter` (from Task 1); `runCopilotGraph`, `recordAiUsage`, `appendCopilotMessage`, `emitToCopilot`, `activeRuns` (existing)
- Produces: `startCopilotRegenerate(params: { userId, userMsgId, locale }): Promise<{ runId, conversationId }>`; `runCopilotRegenerateBackground(runId, params, parent, signal): Promise<void>` (internal)

- [ ] **Step 1: Read `copilot.service.ts`**

Note the existing `startCopilotTurn` and `runCopilotTurnInBackground` patterns — copy their structure for the regenerate equivalents. Note the test setup with `vi.mock("./copilot.store", ...)`.

- [ ] **Step 2: Write the failing tests**

Add to `copilot.service.test.ts` (inside the existing `describe("runCopilotTurn", ...)` block — or a new sibling block):

```ts
describe("startCopilotRegenerate", () => {
  it("returns { runId, conversationId } for a valid parent with an assistant child", async () => {
    const { startCopilotRegenerate, getCopilotMessageById, listCopilotMessages } = await import("./copilot.service");
    const parent = { id: 41, role: "USER", conversationId: 7, createdAt: new Date("2026-08-24T10:00:00Z"), envelope: { type: "text", text: "hello" } };
    (getCopilotMessageById as any).mockResolvedValueOnce(parent);
    (listCopilotMessages as any).mockResolvedValueOnce([
      parent,
      { ...parent, id: 42, role: "ASSISTANT", createdAt: new Date("2026-08-24T10:00:01Z") },
    ]);
    const out = await startCopilotRegenerate({ userId: 5, userMsgId: 41, locale: "ar" });
    expect(out.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.conversationId).toBe(7);
  });

  it("throws AppError(404) when parent not found", async () => {
    const { startCopilotRegenerate, getCopilotMessageById } = await import("./copilot.service");
    (getCopilotMessageById as any).mockResolvedValueOnce(null);
    await expect(startCopilotRegenerate({ userId: 5, userMsgId: 99, locale: "ar" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws AppError(422) when parent exists but no assistant child", async () => {
    const { startCopilotRegenerate, getCopilotMessageById, listCopilotMessages } = await import("./copilot.service");
    (getCopilotMessageById as any).mockResolvedValueOnce({
      id: 41, role: "USER", conversationId: 7, createdAt: new Date("2026-08-24T10:00:00Z"), envelope: { type: "text", text: "hello" },
    });
    (listCopilotMessages as any).mockResolvedValueOnce([
      { id: 41, role: "USER", conversationId: 7, createdAt: new Date("2026-08-24T10:00:00Z"), envelope: {} },
    ]); // no assistant child
    await expect(startCopilotRegenerate({ userId: 5, userMsgId: 41, locale: "ar" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd back-end && npx vitest run copilot.service.test.ts -t "startCopilotRegenerate"`
Expected: FAIL with "startCopilotRegenerate is not exported".

- [ ] **Step 4: Update the test mock factory** to mock `getCopilotMessageById` and `deleteCopilotMessagesAfter`:

```ts
vi.mock("./copilot.store", () => ({
  getOrCreateCopilotConversation: vi.fn(...),
  getCopilotConversationForUser: vi.fn(...),
  appendCopilotMessage: vi.fn(async () => ({ id: 100 })),
  listCopilotMessages: vi.fn(async () => []),
  getCopilotMessageById: vi.fn(async () => null),
  deleteCopilotMessagesAfter: vi.fn(async () => undefined),
}));
```

- [ ] **Step 5: Implement `startCopilotRegenerate`**

Add to `copilot.service.ts` (after the existing `startCopilotTurn` + `runCopilotTurnInBackground`):

```ts
export type RegenerateParams = {
  userId: number;
  userMsgId: number;
  locale: "ar" | "en";
};

export async function startCopilotRegenerate(
  params: RegenerateParams,
): Promise<{ runId: string; conversationId: number }> {
  const parent = await getCopilotMessageById(params.userMsgId, params.userId);
  if (!parent) throw new AppError("parent message not found", 404, false);
  if (parent.role !== "USER") {
    throw new AppError("parent must be a user message", 422, false);
  }

  // Verify there's an assistant response to regenerate.
  const children = await listCopilotMessages(parent.conversationId, 50);
  const hasAssistant = children.some(
    (m) =>
      m.role === "ASSISTANT" &&
      new Date(m.createdAt) >= new Date(parent.createdAt),
  );
  if (!hasAssistant) {
    throw new AppError("no assistant response to regenerate", 422, false);
  }

  // Delete messages after the parent (including original assistant + later turns).
  await deleteCopilotMessagesAfter(parent.conversationId, params.userMsgId, params.userId);

  // Register the new runId + kick off background runner.
  const runId = randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, {
    abortController,
    conversationId: parent.conversationId,
    userId: params.userId,
  });

  // Fire-and-forget.
  void runCopilotRegenerateBackground(runId, params, parent, abortController.signal);

  return { runId, conversationId: parent.conversationId };
}

async function runCopilotRegenerateBackground(
  runId: string,
  params: RegenerateParams,
  parent: Awaited<ReturnType<typeof getCopilotMessageById>> & { id: number; conversationId: number; envelope: { type: "text"; text: string } },
  signal: AbortSignal,
): Promise<void> {
  try {
    const out = await runCopilotGraph({
      conversationId: parent.conversationId,
      userId: params.userId,
      locale: params.locale,
      text: parent.envelope.text,
      signal,
    });

    await recordAiUsage({
      userId: params.userId,
      modelName: out.modelName,
      operation: "copilot_chat",
      conversationId: String(parent.conversationId),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
    });

    await appendCopilotMessage({
      conversationId: parent.conversationId,
      role: "ASSISTANT",
      envelope: {
        envelopes: out.envelopes,
        truncated: out.truncated,
        ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
      },
    });
    emitToCopilot(params.userId, "copilot:message", {
      runId,
      conversationId: parent.conversationId,
      envelopes: out.envelopes,
      truncated: out.truncated,
      ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
    });
  } catch (error: any) {
    if (error?.name === "AbortError" || signal.aborted) {
      emitToCopilot(params.userId, "copilot:cancelled", {
        runId,
        conversationId: parent.conversationId,
      });
    } else {
      logger.error("copilot.regenerate_failed", {
        parentId: params.userMsgId,
        runId,
        error: error?.message,
      });
      emitToCopilot(params.userId, "copilot:error", {
        runId,
        conversationId: parent.conversationId,
        message: "The service is unavailable right now.",
      });
    }
  } finally {
    activeRuns.delete(runId);
  }
}
```

Add the new import at the top:
```ts
import { getCopilotMessageById, listCopilotMessages, deleteCopilotMessagesAfter } from "./copilot.store";
```

(Verify the actual Prisma store import pattern in `copilot.store.ts` — match what's already imported.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd back-end && npx vitest run copilot.service.test.ts -t "startCopilotRegenerate"`
Expected: 3/3 pass.

- [ ] **Step 7: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add back-end/src/modules/copilot/copilot.service.ts back-end/src/modules/copilot/copilot.service.test.ts
git commit -m "feat(copilot): add startCopilotRegenerate service function

- startCopilotRegenerate: verifies parent (404 if missing, 422 if no
  assistant child), deletes messages after parent, registers
  AbortController, kicks off background runner, returns { runId,
  conversationId }
- runCopilotRegenerateBackground: runs graph with parent's text,
  persists ASSISTANT, emits copilot:message/cancelled/error with runId
- Reuses the cancel feature's activeRuns pattern for Stop-button
  support during regenerate"
```

---

## Task 3: Add the controller + route

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.controller.ts`
- Modify: `back-end/src/modules/copilot/copilot.routes.ts`
- Modify: `back-end/src/modules/copilot/copilot.controller.test.ts`

**Interfaces:**
- Consumes: `startCopilotRegenerate` (from Task 2)
- Produces: `POST /v1/copilot/messages/:userMsgId/regenerate` returning 200 `{ data: { runId, conversationId } }`, 404 `{ error: { message: "parent message not found" } }`, 422 `{ error: { message: "no assistant response to regenerate" } }`

- [ ] **Step 1: Read existing routes + controller** to find the pattern (the existing `cancelCopilotRunController` is a sibling that uses similar shape).

- [ ] **Step 2: Write the failing tests**

Add to `copilot.controller.test.ts` (extend the `vi.mock("./copilot.service", ...)` factory to include `startCopilotRegenerate`):

```ts
// At top of file:
vi.mock("./copilot.service", () => ({
  startCopilotTurn: vi.fn(...),
  cancelCopilotRun: vi.fn(...),
  startCopilotRegenerate: vi.fn(...),
}));
```

Then add tests:

```ts
describe("regenerateCopilotMessageController", () => {
  it("POST regenerate returns 200 with runId + conversationId", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    (startCopilotRegenerate as any).mockResolvedValueOnce({
      runId: "regen-123",
      conversationId: 7,
    });
    const req: any = { user: { id: 5 }, params: { userMsgId: 41 } };
    const response = makeRes();
    await regenerateCopilotMessageController(req, response);
    expect(startCopilotRegenerate).toHaveBeenCalledWith({ userId: 5, userMsgId: 41 });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      data: { runId: "regen-123", conversationId: 7 },
    });
  });

  it("POST regenerate returns 404 when startCopilotRegenerate throws 404", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    (startCopilotRegenerate as any).mockRejectedValueOnce(new AppError("parent message not found", 404, false));
    const req: any = { user: { id: 5 }, params: { userMsgId: 99 } };
    const response = makeRes();
    await regenerateCopilotMessageController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "parent message not found" }),
    });
  });

  it("POST regenerate returns 422 when startCopilotRegenerate throws 422", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    (startCopilotRegenerate as any).mockRejectedValueOnce(new AppError("no assistant response to regenerate", 422, false));
    const req: any = { user: { id: 5 }, params: { userMsgId: 41 } };
    const response = makeRes();
    await regenerateCopilotMessageController(req, response);
    expect(response.status).toHaveBeenCalledWith(422);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd back-end && npx vitest run copilot.controller.test.ts -t "regenerateCopilotMessageController"`
Expected: FAIL with "regenerateCopilotMessageController is not exported".

- [ ] **Step 4: Implement `regenerateCopilotMessageController`**

Add to `copilot.controller.ts` (importing `startCopilotRegenerate` at the top):

```ts
import { cancelCopilotRun, startCopilotTurn, startCopilotRegenerate, activeRuns } from "./copilot.service";
// (extend the existing import line — don't duplicate)

export const regenerateCopilotMessageController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const userMsgId = Number((req as any).params.userMsgId);
  try {
    const result = await startCopilotRegenerate({ userId, userMsgId, locale: detectLocale(req) });
    res.status(200).json({ data: { runId: result.runId, conversationId: result.conversationId } });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    const message = err?.message ?? "The service is unavailable right now.";
    res.status(status).json({ error: { message } });
  }
};
```

- [ ] **Step 5: Wire the route**

Add to `copilot.routes.ts`:

```ts
router.post("/messages/:userMsgId/regenerate", regenerateCopilotMessageController);
```

(Place near the existing message routes.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd back-end && npx vitest run copilot.controller.test.ts -t "regenerateCopilotMessageController"`
Expected: 3/3 pass.

- [ ] **Step 7: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add back-end/src/modules/copilot/copilot.controller.ts back-end/src/modules/copilot/copilot.routes.ts back-end/src/modules/copilot/copilot.controller.test.ts
git commit -m "feat(copilot): add POST /messages/:userMsgId/regenerate endpoint

Routes startCopilotRegenerate. Returns 200 with { runId, conversationId }
on success; 404 when parent not found (or wrong user — no info leak);
422 when parent has no assistant child to regenerate.

Cancel feature's activeRuns + Stop button integration carries over
automatically — the regenerate run is registered the same way, so
Stop mid-regenerate aborts via DELETE /copilot/runs/:runId."
```

---

## Task 4: Backend validation gate

**Files:** none modified

- [ ] **Step 1: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Run full test suite**

Run: `cd back-end && npx vitest run`
Expected: all tests pass.

- [ ] **Step 3: Run `npm run build`**

Run: `cd back-end && npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit any version bumps or fixes**

If validation surfaces issues, fix them in a commit. Otherwise no commit.

---

## Task 5: Add `regenerateMessage` to the API client

**Files:**
- Modify: `app/src/lib/copilot-api.ts`

**Interfaces:**
- Consumes: `COPILOT_API.MESSAGES` constant (existing)
- Produces: `regenerateMessage(userMsgId: number): Promise<{ runId; conversationId }>`

- [ ] **Step 1: Read `copilot-api.ts`**

Note the existing `postMessage` and `cancelRun` methods for the pattern (fetchWithAuth, response shape handling).

- [ ] **Step 2: Add `regenerateMessage` method**

```ts
// inside CopilotService class
async regenerateMessage(userMsgId: number): Promise<{ runId: string; conversationId: number }> {
  const res = await fetchWithAuth<{ data: { runId: string; conversationId: number } }>(
    `${COPILOT_API.MESSAGES}/${userMsgId}/regenerate`,
    { method: "POST" },
  );
  return res.data;
}
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: errors in `CopilotRuntime.tsx` because it still calls `postMessage` for reload. That's expected — Task 6 fixes it.

- [ ] **Step 4: Commit**

```bash
cd app && git add src/lib/copilot-api.ts && git commit -m "feat(copilot): regenerateMessage calls POST /messages/:userMsgId/regenerate"
```

---

## Task 6: Update `CopilotRuntime.tsx` `store.onReload` to call `regenerateMessage`

**Files:**
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.tsx`

**Interfaces:**
- Consumes: `regenerateMessage` (from Task 5)
- Produces: `store.onReload(parentId)` calls `regenerateMessage(parentMsgId)` and uses the same `currentRunId` + cancel infrastructure as `onNew`

- [ ] **Step 1: Read the current `store.onReload`** in `CopilotRuntime.tsx`. Note the pattern from `store.onNew` — it clears optimistic, calls the service, stores currentRunId on success, re-throws on failure.

- [ ] **Step 2: Update `store.onReload`**

Replace the current `onReload`:

```ts
onReload: async (parentId: string | null) => {
  if (!parentId) return;
  const userMsg = visibleMessages.find((m) => String(m.id) === parentId);
  if (!userMsg || userMsg.role !== "USER") return;

  // Clear local state so the user sees the streaming indicator + a clean reload.
  setStreamingText("");
  setOptimisticUserMessage(null);
  setCurrentRunId(null);

  try {
    const result = await copilotService.regenerateMessage(userMsg.id);
    // Server has deleted messages after the parent and registered a new runId.
    // Real messages arrive via socket. Clear optimistic defensively.
    setOptimisticUserMessage(null);
    setCurrentRunId(result.runId);
  } catch (error) {
    console.warn("[copilot] regenerateMessage failed", error);
    throw error; // Let assistant-ui surface the error in the composer.
  }
},
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Run `npx eslint --quiet`**

Run: `cd app && npx eslint --quiet`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd app && git add src/components/user/copilot/overlay/CopilotRuntime.tsx && git commit -m "feat(copilot): Reload button calls regenerate endpoint

store.onReload(parentId) now calls copilotService.regenerateMessage
instead of postMessage. Reuses the existing currentRunId state +
cancel infrastructure — Stop button works during regenerate via the
existing DELETE /copilot/runs/:runId flow."
```

---

## Task 7: Frontend validation gate

**Files:** none modified

- [ ] **Step 1: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Run `npx eslint --quiet`**

Run: `cd app && npx eslint --quiet`
Expected: clean.

- [ ] **Step 3: Run `npx next build --turbopack --no-lint`**

Run: `cd app && npx next build --turbopack --no-lint`
Expected: succeeds.

- [ ] **Step 4: Manual smoke test**

With both servers running, verify:
1. Click Regenerate → original AI response replaced; user message unchanged
2. Click Regenerate mid-stream → Stop button cancels the regenerate
3. Click Regenerate twice on the same parent → both runs complete; thread shows the latest
4. Trigger server error (e.g., call regenerate on a USER message with no assistant child) → toast appears; thread state consistent

- [ ] **Step 5: Fix any issues surfaced**

If validation surfaces bugs, fix them in commits. Each commit's message should reference the bug.

---

## Self-review checklist (run before handoff)

1. **Spec coverage:** each requirement in `docs/superpowers/specs/2026-08-24-copilot-regenerate-design.md` maps to at least one task. Walk through:
   - `startCopilotRegenerate` flow → Tasks 2 (service), 3 (controller)
   - `runCopilotRegenerateBackground` → Task 2
   - `deleteCopilotMessagesAfter` SQL helper → Task 1
   - `getCopilotMessageById` helper → Task 1
   - Route `POST /v1/copilot/messages/:userMsgId/regenerate` → Task 3
   - Status codes 200/404/422 → Task 3 (tests) + Task 2 (service-level tests for the underlying throws)
   - Socket events `copilot:message`/`copilot:cancelled`/`copilot:error` with `runId` → Task 2 (background runner)
   - `regenerateMessage` API method → Task 5
   - `store.onReload` rewires → Task 6
   - Cancel-during-regenerate (Stop button works) → implicit (uses cancel infrastructure; documented)
2. **Placeholder scan:** no "TBD", "TODO", "implement later" in the plan steps.
3. **Type consistency:** `startCopilotRegenerate({ userId, userMsgId, locale })`, `regenerateMessage(userMsgId)`, `deleteCopilotMessagesAfter(conversationId, userMsgId, userId)` — same names everywhere.
4. **Commit boundaries:** each task produces a single, reviewable commit.
