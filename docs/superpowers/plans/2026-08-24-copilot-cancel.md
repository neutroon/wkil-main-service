# Copilot True Backend Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Stop button truly abort the backend LangGraph within milliseconds.

**Architecture:** `runId` (UUID) becomes the identity for an in-flight run. `POST /copilot/messages` returns `{ runId, conversationId }` synchronously and kicks off the graph in the background. `DELETE /copilot/runs/:runId` aborts via `AbortController`. The frontend tracks the runId for the active optimistic message, fires DELETE on Stop (fire-and-forget), and clears local state immediately.

**Tech Stack:** Node.js, TypeScript, Express, LangGraph (`graph.invoke({ signal })`), AbortController, vitest. Next.js 15, React 19, `@assistant-ui/react@0.15.16`, `sonner`.

## Global Constraints

- Backend: vitest test framework. Frontend: no test runner (manual smoke test).
- No new dependencies.
- The `error` envelope type stays in the schema for tool-level errors. The `copilot:cancelled` event is a new system-level event, not an envelope.
- `activeRuns` map is in-memory (single-instance only). Multi-instance cancel is a deferred limitation.
- On cancel: do NOT persist the assistant message (the streaming ghost was visible until cleared).
- All routes return JSON; non-2xx responses have shape `{ cancelled: false, message: string }`.
- The frontend's optimistic user message is cleared on POST response (not on socket `copilot:message`), since the server has already persisted the user message by then.
- Socket events that carry `runId`: `copilot:message`, `copilot:cancelled`, `copilot:error`. The frontend uses runId to match events to its active optimistic message.
- Security: `cancelCopilotRun` requires userId match — don't let user A cancel user B's run.
- LangGraph `signal` support: verify `langgraph@0.2+` is installed before relying on `graph.invoke({ signal })`. Fallback: `Promise.race(graphPromise, abortPromise)`.
- The `COPILOT_API` constants in `app/src/lib/copilot-api.ts` already define the messages endpoint; reuse them for the new `cancelRun` path (don't introduce parallel constants).
- `app/src/types/openapi.generated.ts` is regenerated via `npm run types:api` from `back-end/`. If generated types are wired into the frontend, regenerate after backend changes; otherwise skip this file in the affected-tasks list.

---

## File Structure

**Backend (new + modified):**
- `back-end/src/modules/copilot/copilot.service.ts` — module-level `activeRuns` map; `startCopilotTurn` (sync, returns `{ runId, conversationId }`); `runCopilotTurnInBackground` (async); `cancelCopilotRun`
- `back-end/src/modules/copilot/copilot.routes.ts` — new `DELETE /copilot/runs/:runId`; modify `POST /copilot/messages` to use `startCopilotTurn`
- `back-end/src/modules/copilot/copilot.controller.ts` — new `cancelCopilotRunController`; update `postCopilotMessageController` for new response shape
- `back-end/src/modules/copilot/copilot.controller.test.ts` — update mocks; add DELETE controller tests
- `back-end/src/modules/copilot/copilot.service.test.ts` — update tests for split; add `cancelCopilotRun` tests; add abort-persists-nothing test

**Frontend (modified):**
- `app/src/lib/copilot-api.ts` — `postMessage` returns `Promise<{ runId; conversationId }>`; new `cancelRun(runId)`
- `app/src/hooks/copilot/useCopilotSocket.ts` — callback shape adds `onMessage(runId)`, `onCancelled(runId)`, `onError(runId, message)`
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` — `currentRunId` state; clear optimistic on POST response; new socket handlers; `store.onCancel` fires DELETE fire-and-forget

---

## Task 1: Add `activeRuns` map and `cancelCopilotRun` to the service

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.service.ts` (add `activeRuns` + `cancelCopilotRun`)
- Test: `back-end/src/modules/copilot/copilot.service.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `cancelCopilotRun(runId: string, userId: number): Promise<{ cancelled: boolean }>`

- [ ] **Step 1: Read the current service file** — note the existing imports and exports at `back-end/src/modules/copilot/copilot.service.ts`. The test file at `back-end/src/modules/copilot/copilot.service.test.ts` already has the mock setup pattern; reuse it.

- [ ] **Step 2: Write the failing test**

Add the following test to `copilot.service.test.ts` inside the existing `describe("runCopilotTurn", ...)` block (a new `describe("cancelCopilotRun", ...)` sibling is also fine):

```ts
import { cancelCopilotRun } from "./copilot.service";

describe("cancelCopilotRun", () => {
  it("returns { cancelled: false } for an unknown runId", async () => {
    const out = await cancelCopilotRun("nonexistent-id", 5);
    expect(out).toEqual({ cancelled: false });
  });

  it("returns { cancelled: true } and aborts when runId is registered", async () => {
    // Reach into the service module's activeRuns map by registering one first
    // via runCopilotTurn. After the fix, this will need to use startCopilotTurn
    // (Task 2). For Task 1, we use a direct helper that the implementation
    // exposes OR the runCopilotTurn path. Choose based on what's available.
    //
    // Simplest path: import activeRuns from the module and seed it.
    const { activeRuns } = await import("./copilot.service");
    const controller = new AbortController();
    activeRuns.set("test-run-id", {
      abortController: controller,
      conversationId: 7,
      userId: 5,
    });
    const out = await cancelCopilotRun("test-run-id", 5);
    expect(out).toEqual({ cancelled: true });
    expect(controller.signal.aborted).toBe(true);
    expect(activeRuns.has("test-run-id")).toBe(false);
  });

  it("returns { cancelled: false } when runId belongs to another user", async () => {
    const { activeRuns } = await import("./copilot.service");
    const controller = new AbortController();
    activeRuns.set("other-user-run", {
      abortController: controller,
      conversationId: 7,
      userId: 99,
    });
    const out = await cancelCopilotRun("other-user-run", 5);
    expect(out).toEqual({ cancelled: false });
    expect(controller.signal.aborted).toBe(false);
    expect(activeRuns.has("other-user-run")).toBe(true); // not removed
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd back-end && npx vitest run copilot.service.test.ts -t "cancelCopilotRun"`
Expected: FAIL with "cancelCopilotRun is not exported" or similar.

- [ ] **Step 4: Implement `activeRuns` + `cancelCopilotRun`**

Add to `back-end/src/modules/copilot/copilot.service.ts` (alongside the existing `CopilotTurnResult` export):

```ts
export type ActiveRun = {
  abortController: AbortController;
  conversationId: number;
  userId: number;
};

export const activeRuns = new Map<string, ActiveRun>();

export async function cancelCopilotRun(
  runId: string,
  userId: number,
): Promise<{ cancelled: boolean }> {
  const run = activeRuns.get(runId);
  if (!run) return { cancelled: false };
  if (run.userId !== userId) return { cancelled: false };
  run.abortController.abort();
  activeRuns.delete(runId);
  return { cancelled: true };
}
```

Note: `Map` is a global; no import needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd back-end && npx vitest run copilot.service.test.ts -t "cancelCopilotRun"`
Expected: 3/3 pass.

- [ ] **Step 6: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add back-end/src/modules/copilot/copilot.service.ts back-end/src/modules/copilot/copilot.service.test.ts
git commit -m "feat(copilot): add activeRuns map and cancelCopilotRun

Foundational for the Stop button true-cancel work (design at
docs/superpowers/specs/2026-08-24-copilot-cancel-design.md).

activeRuns is a module-level Map<runId, { abortController, conversationId,
userId }>. cancelCopilotRun looks up by runId, verifies userId match,
calls abort(), and removes the entry. Returns { cancelled: false }
when the runId is unknown OR belongs to another user (no-op, no abort)."
```

---

## Task 2: Split `runCopilotTurn` into sync `startCopilotTurn` + async background runner

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.service.ts`
- Test: `back-end/src/modules/copilot/copilot.service.test.ts`

**Interfaces:**
- Consumes: `activeRuns` (from Task 1)
- Produces: `startCopilotTurn(params): Promise<{ runId; conversationId }>` (sync return). `runCopilotTurnInBackground` runs in the background, registers `activeRuns[runId]` with the AbortController, calls `runCopilotGraph` with `signal`, persists assistant message and emits socket on success, emits `copilot:cancelled` on abort, emits `copilot:error` on other failures.

- [ ] **Step 1: Write the failing test for `startCopilotTurn`**

Add to `copilot.service.test.ts`:

```ts
describe("startCopilotTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGraphMock.mockResolvedValue({
      envelopes: [{ type: "text", text: "أهلاً" }],
      usage: { promptTokens: 3, completionTokens: 2 },
      modelName: "gemini-2.5-flash",
      truncated: false,
      expectedTotal: null,
    });
  });

  it("returns { runId, conversationId } synchronously and does not await the graph", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    expect(out.runId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4-ish
    expect(out.conversationId).toBe(7);
    // runId is registered in activeRuns
    const { activeRuns } = await import("./copilot.service");
    expect(activeRuns.has(out.runId)).toBe(true);
  });

  it("registers the run with the caller's userId", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "x", locale: "ar" });
    const { activeRuns } = await import("./copilot.service");
    const run = activeRuns.get(out.runId);
    expect(run?.userId).toBe(5);
    expect(run?.conversationId).toBe(7);
    expect(run?.abortController).toBeInstanceOf(AbortController);
  });

  it("persists the user message", async () => {
    await startCopilotTurn({ userId: 5, text: "hello", locale: "en" });
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const userCall = calls.find((c: any[]) => c[0]?.role === "USER");
    expect(userCall[0].envelope).toMatchObject({ type: "text", text: "hello" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd back-end && npx vitest run copilot.service.test.ts -t "startCopilotTurn"`
Expected: FAIL with "startCopilotTurn is not exported".

- [ ] **Step 3: Refactor `runCopilotTurn` into two functions**

Replace `runCopilotTurn` in `copilot.service.ts` with two functions. Keep the `CopilotTurnResult` type or replace it with the new `{ runId, conversationId }` return type — match the design decision below.

```ts
import { randomUUID } from "node:crypto";

export async function startCopilotTurn(params: {
  userId: number;
  text: string;
  locale: "ar" | "en";
  conversationId?: number;
}): Promise<{ runId: string; conversationId: number }> {
  const conv = params.conversationId
    ? await getCopilotConversationForUser(params.conversationId, params.userId)
    : await getOrCreateCopilotConversation(params.userId, params.locale);

  await assertQuotaAvailable(params.userId, undefined);
  await appendCopilotMessage({
    conversationId: conv.id,
    role: "USER",
    envelope: { type: "text", text: params.text },
  });

  const runId = randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, {
    abortController,
    conversationId: conv.id,
    userId: params.userId,
  });

  // Fire-and-forget. Errors are caught inside the background runner.
  void runCopilotTurnInBackground(runId, params, conv, abortController.signal);

  return { runId, conversationId: conv.id };
}

async function runCopilotTurnInBackground(
  runId: string,
  params: { userId: number; text: string; locale: "ar" | "en"; conversationId?: number },
  conv: { id: number },
  signal: AbortSignal,
): Promise<void> {
  try {
    const out = await runCopilotGraph({
      conversationId: conv.id,
      userId: params.userId,
      locale: params.locale,
      text: params.text,
      signal,
    });

    await recordAiUsage({
      userId: params.userId,
      modelName: out.modelName,
      operation: "copilot_chat",
      conversationId: String(conv.id),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
    });

    await appendCopilotMessage({
      conversationId: conv.id,
      role: "ASSISTANT",
      envelope: {
        envelopes: out.envelopes,
        truncated: out.truncated,
        ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
      },
    });
    emitToCopilot(params.userId, "copilot:message", {
      runId,
      conversationId: conv.id,
      envelopes: out.envelopes,
      truncated: out.truncated,
      ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
    });
  } catch (error: any) {
    if (error?.name === "AbortError" || signal.aborted) {
      emitToCopilot(params.userId, "copilot:cancelled", {
        runId,
        conversationId: conv.id,
      });
    } else {
      logger.error("copilot.turn_failed", {
        conversationId: conv.id,
        runId,
        error: error?.message,
      });
      emitToCopilot(params.userId, "copilot:error", {
        runId,
        conversationId: conv.id,
        message: "The service is unavailable right now.",
      });
    }
  } finally {
    activeRuns.delete(runId);
  }
}
```

Also remove (or keep as a deprecation shim) the old `runCopilotTurn` export. The frontend will switch to `startCopilotTurn` in a later task — for Task 2, remove the old export only after the existing tests are updated to use `startCopilotTurn`.

- [ ] **Step 4: Update existing tests that import `runCopilotTurn`**

The current `copilot.service.test.ts` has tests like:
- "persists user + assistant messages, emits, and records usage"
- "propagates quota exhaustion as 402"
- "returns ok: false on graph failure without persisting an assistant message"

These all need to be updated to use `startCopilotTurn` and assert on the new `{ runId, conversationId }` shape. The assertions become:
- After calling `startCopilotTurn`, wait for the background runner to complete (poll until `activeRuns.has(runId)` is false, or just `await new Promise(r => setTimeout(r, 10))`).
- Assert `appendCopilotMessage` was called for both USER and ASSISTANT roles.
- Assert `emitToCopilot` was called with `copilot:message` including the `runId`.
- For the abort test, call `cancelCopilotRun` after `startCopilotTurn`, then wait for cleanup, then assert `appendCopilotMessage` was NOT called for ASSISTANT and `emitToCopilot` was called with `copilot:cancelled`.

For the quota exhaustion test, since `startCopilotTurn` no longer rejects, the test needs to wrap the call differently:
```ts
it("propagates quota exhaustion (background rejects silently)", async () => {
  assertQuotaMock.mockRejectedValueOnce(new AppError("quota", 402, true));
  const out = await startCopilotTurn({ userId: 5, text: "x", locale: "ar" });
  // runId is returned, but the background will fail silently (no copilot:error emit because quota check throws synchronously inside startCopilotTurn)
  expect(out.runId).toMatch(/^.../);
  await new Promise(r => setTimeout(r, 10));
  // USER message was never persisted because assertQuotaAvailable threw first
  const { appendCopilotMessage } = await import("./copilot.store");
  const calls = (appendCopilotMessage as any).mock.calls;
  expect(calls).toHaveLength(0);
});
```

This requires the quota check to throw BEFORE `appendCopilotMessage` (USER), which it does in `startCopilotTurn`. If quota throws inside the background, the flow would be different.

Move the assertQuotaAvailable call BEFORE the user message persist in `startCopilotTurn`. This way quota errors are surfaced synchronously, and the frontend gets a clean failure mode.

- [ ] **Step 5: Run all copilot.service tests**

Run: `cd back-end && npx vitest run copilot.service.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Run full backend test suite**

Run: `cd back-end && npx vitest run`
Expected: any unrelated failures; copilot tests all pass.

- [ ] **Step 7: Commit**

```bash
git add back-end/src/modules/copilot/copilot.service.ts back-end/src/modules/copilot/copilot.service.test.ts
git commit -m "refactor(copilot): split runCopilotTurn into sync start + async background

The Stop button fix requires async POST semantics (so the frontend
gets the runId immediately and can DELETE while the graph runs).
This refactor separates the synchronous 'save user, kick off graph,
return runId' path from the async 'run graph, persist, emit' path.

- startCopilotTurn: sync entry point, returns { runId, conversationId }
  - Asserts quota (throws on exhaustion, no USER persist)
  - Persists USER message
  - Registers AbortController in activeRuns
  - Kicks off background runner, returns
- runCopilotTurnInBackground: async, no return
  - Runs graph with signal
  - On success: persist ASSISTANT + emit copilot:message
  - On AbortError: emit copilot:cancelled, no persist
  - On other error: emit copilot:error
  - Always: activeRuns.delete(runId) in finally

runCopilotGraph now accepts an optional signal parameter (passed
through to graph.invoke)."
```

Also edit `back-end/src/modules/copilot/copilot.graph.ts` to accept the signal:

```ts
// copilot.graph.ts
export async function runCopilotGraph(params: {
  conversationId: number;
  userId: number;
  locale: "ar" | "en";
  text: string;
  signal?: AbortSignal;
}): Promise<{
  envelopes: import("./copilot.types").CopilotEnvelope[];
  usage: { promptTokens: number; completionTokens: number };
  modelName: string;
  truncated: boolean;
  expectedTotal: number | null;
}> {
  const final = await copilotGraph.invoke(
    { conversationId: params.conversationId, userId: params.userId, locale: params.locale },
    {
      configurable: { thread_id: `copilot-${params.conversationId}`, graph_version: "copilot-v1" },
      recursionLimit: 25,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  return {
    envelopes: final.envelopes,
    usage: final.usage,
    modelName: final.modelName,
    truncated: final.truncated,
    expectedTotal: final.expectedTotal,
  };
}
```

Verify LangGraph's `graph.invoke` accepts `signal`. If not, use the `Promise.race` fallback documented in the spec.

Commit the graph change in the same commit (or a separate one if review prefers).

---

## Task 3: Add `DELETE /copilot/runs/:runId` route and controller

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.routes.ts`
- Modify: `back-end/src/modules/copilot/copilot.controller.ts`
- Modify: `back-end/src/modules/copilot/copilot.controller.test.ts`

**Interfaces:**
- Consumes: `cancelCopilotRun` (from Task 1)
- Produces: `DELETE /copilot/runs/:runId` returning 200 `{ cancelled: true }`, 404 `{ cancelled: false, message }`, 403 `{ cancelled: false, message }`

- [ ] **Step 1: Read existing routes + controller** to find the pattern (e.g., `getCopilotConversationController`, `postCopilotMessageController`).

- [ ] **Step 2: Write the failing controller test**

Add to `copilot.controller.test.ts`:

```ts
import { cancelCopilotRunController } from "./copilot.controller";

describe("DELETE /copilot/runs/:runId", () => {
  it("returns 200 { cancelled: true } when the run is active for the user", async () => {
    const { cancelCopilotRun } = await import("./copilot.service");
    (cancelCopilotRun as any).mockResolvedValueOnce({ cancelled: true });
    const req: any = { user: { id: 5 }, params: { runId: "abc" } };
    const response = makeRes();
    await cancelCopilotRunController(req, response);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ data: { cancelled: true } });
  });

  it("returns 404 when the run is unknown", async () => {
    const { cancelCopilotRun } = await import("./copilot.service");
    (cancelCopilotRun as any).mockResolvedValueOnce({ cancelled: false });
    const req: any = { user: { id: 5 }, params: { runId: "nope" } };
    const response = makeRes();
    await cancelCopilotRunController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "no active run" }),
    });
  });

  it("returns 403 when the run belongs to another user", async () => {
    const { cancelCopilotRun } = await import("./copilot.service");
    (cancelCopilotRun as any).mockResolvedValueOnce({ cancelled: false });
    const req: any = { user: { id: 5 }, params: { runId: "other-user" } };
    const response = makeRes();
    await cancelCopilotRunController(req, response);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "forbidden" }),
    });
  });
});
```

You may need to mock `cancelCopilotRun` at the top of the test file:

```ts
vi.mock("./copilot.service", () => ({
  runCopilotTurn: vi.fn(async () => ({ conversationId: 7, envelopes: [{ type: "text", text: "ok" }] })),
  startCopilotTurn: vi.fn(async () => ({ runId: "test-run", conversationId: 7 })),
  cancelCopilotRun: vi.fn(async () => ({ cancelled: false })),
}));
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd back-end && npx vitest run copilot.controller.test.ts -t "DELETE"`
Expected: FAIL with "cancelCopilotRunController is not exported" or similar.

- [ ] **Step 4: Implement `cancelCopilotRunController`**

Add to `copilot.controller.ts`:

```ts
export const cancelCopilotRunController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const runId = (req as any).params.runId as string;
  const out = await cancelCopilotRun(runId, userId);
  if (out.cancelled) {
    res.status(200).json({ data: { cancelled: true } });
    return;
  }
  // Determine 403 vs 404: peek at activeRuns
  const { activeRuns } = await import("./copilot.service");
  const exists = activeRuns.has(runId);
  if (!exists) {
    res.status(404).json({ error: { message: "no active run" } });
  } else {
    res.status(403).json({ error: { message: "forbidden" } });
  }
};
```

This peeks at `activeRuns` to differentiate 404 (unknown runId) from 403 (exists but wrong user). Alternative: have `cancelCopilotRun` return a third state for the wrong-user case. The peek is simpler.

- [ ] **Step 5: Wire the route**

Add to `copilot.routes.ts`:

```ts
router.delete("/runs/:runId", cancelCopilotRunController);
```

(Place near the existing message routes. Use the same auth middleware pattern.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd back-end && npx vitest run copilot.controller.test.ts -t "DELETE"`
Expected: 3/3 pass.

- [ ] **Step 7: Commit**

```bash
git add back-end/src/modules/copilot/copilot.controller.ts back-end/src/modules/copilot/copilot.routes.ts back-end/src/modules/copilot/copilot.controller.test.ts
git commit -m "feat(copilot): add DELETE /copilot/runs/:runId endpoint

Routes the cancelCopilotRun service function. Returns:
- 200 { cancelled: true } when the run was active for the user
- 404 { error } when the runId is unknown
- 403 { error } when the runId exists but belongs to another user"
```

---

## Task 4: Update `POST /copilot/messages` controller to use `startCopilotTurn`

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.controller.ts`
- Modify: `back-end/src/modules/copilot/copilot.controller.test.ts`

**Interfaces:**
- Consumes: `startCopilotTurn` (from Task 2)
- Produces: `POST /copilot/messages` returning 200 `{ runId, conversationId }` (drop envelopes/truncated/expectedTotal from sync return)

- [ ] **Step 1: Update the existing POST controller test**

The existing test for `postCopilotMessageController` mocks `runCopilotTurn`. Update the mock to use `startCopilotTurn` returning `{ runId, conversationId }`:

```ts
// At top of file, in the mock:
vi.mock("./copilot.service", () => ({
  startCopilotTurn: vi.fn(async () => ({ runId: "test-run-id", conversationId: 7 })),
  cancelCopilotRun: vi.fn(async () => ({ cancelled: false })),
}));
```

Then the existing test:
```ts
it("POST message runs a turn for the authenticated user", async () => {
  const req: any = { user: { id: 5 }, body: { text: "hello" }, headers: {} };
  const response = makeRes();
  await postCopilotMessageController(req, response);
  expect(startCopilotTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, text: "hello" }));
  expect(response.status).toHaveBeenCalledWith(200);
  expect(response.json).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: "test-run-id", conversationId: 7 }) });
});
```

- [ ] **Step 2: Update the controller**

Replace `postCopilotMessageController`:

```ts
export const postCopilotMessageController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const { text } = (req as any).body as { text: string };
  const locale = detectLocale(req);
  const result = await startCopilotTurn({ userId, text, locale });
  res.status(200).json({ data: { runId: result.runId, conversationId: result.conversationId } });
};
```

- [ ] **Step 3: Run all controller tests**

Run: `cd back-end && npx vitest run copilot.controller.test.ts`
Expected: all pass.

- [ ] **Step 4: Run full backend suite**

Run: `cd back-end && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add back-end/src/modules/copilot/copilot.controller.ts back-end/src/modules/copilot/copilot.controller.test.ts
git commit -m "feat(copilot): POST /copilot/messages returns { runId, conversationId }

POST is now async — returns the runId synchronously after saving
the USER message, and kicks off the graph in the background. Result
delivered via the copilot:message socket event.

The frontend uses the returned runId to track the active optimistic
message and to call DELETE /copilot/runs/:runId on Stop."
```

---

## Task 5: Backend validation gate

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

- [ ] **Step 4: Smoke test the cancel endpoint**

Start the backend (`cd back-end && npm run dev`). Use `curl` to verify the new endpoint:

```bash
# Cancel a non-existent runId — should return 404
curl -X DELETE http://localhost:PORT/copilot/runs/nonexistent -H "Authorization: Bearer $TOKEN"
# Expected: {"error":{"message":"no active run"}}
```

(Without a valid token, the request will 401 before reaching the cancel handler. Skip this manual test if you don't have a live token.)

- [ ] **Step 5: Commit any version bumps or fixes**

If steps 1-3 surfaced issues, fix them in a commit before moving to frontend. Otherwise no commit.

---

## Task 6: Update `app/src/lib/copilot-api.ts` — new `postMessage` return + `cancelRun`

**Files:**
- Modify: `app/src/lib/copilot-api.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `postMessage(text): Promise<{ runId; conversationId }>`. `cancelRun(runId): Promise<{ cancelled: boolean }>`.

- [ ] **Step 1: Read `app/src/lib/copilot-api.ts`**

Note the existing `postMessage` return type and the `COPILOT_API` constants.

- [ ] **Step 2: Update the `postMessage` return type and add `cancelRun`**

```ts
class CopilotService {
  // ... existing getConversation, getMessages ...

  async postMessage(text: string): Promise<{ runId: string; conversationId: number }> {
    const res = await fetchWithAuth<{ data: { runId: string; conversationId: number } }>(
      COPILOT_API.MESSAGES,
      { method: "POST", body: JSON.stringify({ text }) },
    );
    return res.data;
  }

  async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    const res = await fetchWithAuth<{ data: { cancelled: boolean } }>(
      `${COPILOT_API.MESSAGES}/runs/${runId}`,
      { method: "DELETE" },
    );
    return res.data;
  }
}
```

(The exact `${COPILOT_API.MESSAGES}/runs/${runId}` path may need adjusting based on how the backend mounts the route. If the backend mounts `DELETE /copilot/runs/:runId` under a different base, update the constant accordingly.)

- [ ] **Step 3: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: errors in `CopilotRuntime.tsx` because it still uses the old `postMessage` return shape. That's expected — Task 7 fixes it.

- [ ] **Step 4: Commit**

```bash
cd app && git add src/lib/copilot-api.ts && git commit -m "feat(copilot): postMessage returns { runId, conversationId }; add cancelRun

Backend now returns the runId synchronously after saving the USER
message; the result arrives via socket. This updates the API client
to match the new shape and adds cancelRun for the Stop button."
```

---

## Task 7: Update `app/src/hooks/copilot/useCopilotSocket.ts` — new socket callbacks

**Files:**
- Modify: `app/src/hooks/copilot/useCopilotSocket.ts`

**Interfaces:**
- Consumes: socket events from the backend (`copilot:message`, `copilot:delta`, `copilot:progress`, `copilot:cancelled`, `copilot:error`)
- Produces: callback shape with `onMessage(payload)`, `onCancelled(payload)`, `onError(payload)` all carrying `runId`

- [ ] **Step 1: Read `useCopilotSocket.ts`**

Note the current callback shape and the socket event listeners.

- [ ] **Step 2: Update the callback params interface**

```ts
// app/src/hooks/copilot/useCopilotSocket.ts
export type CopilotSocketParams = {
  conversationId?: number;
  onDelta: (delta: string) => void;
  onStreamEnd: () => void;
  onProgress?: (message: string) => void;
  onMessage?: (payload: {
    runId: string;
    conversationId: number;
    envelopes: CopilotEnvelope[];
    truncated: boolean;
    expectedTotal: number | null;
  }) => void;
  onCancelled?: (payload: { runId: string; conversationId: number }) => void;
  onError?: (payload: { runId: string; conversationId: number; message: string }) => void;
};
```

- [ ] **Step 3: Update the socket handlers**

In the `useEffect` body, update the three handlers:

```ts
const handleMessage = (p: {
  runId: string;
  conversationId: number;
  envelopes: CopilotEnvelope[];
  truncated: boolean;
  expectedTotal: number | null;
}) => {
  if (p.conversationId !== conversationId) return;
  onStreamEnd();
  onMessage?.(p);
  queryClient.invalidateQueries({ queryKey: COPILOT_KEYS.messages() });
};

const handleCancelled = (p: { runId: string; conversationId: number }) => {
  if (p.conversationId !== conversationId) return;
  onCancelled?.(p);
};

const handleError = (p: { runId: string; conversationId: number; message: string }) => {
  if (p.conversationId !== conversationId) return;
  onError?.(p);
};

socket.on("copilot:message", handleMessage);
socket.on("copilot:cancelled", handleCancelled);
socket.on("copilot:error", handleError);
// ... existing delta + progress handlers ...

return () => {
  socket.off("copilot:message", handleMessage);
  socket.off("copilot:cancelled", handleCancelled);
  socket.off("copilot:error", handleError);
  // ... existing cleanup ...
};
```

- [ ] **Step 4: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: errors in `CopilotRuntime.tsx` for the new callbacks (it doesn't pass them yet). Task 7 fixes it.

- [ ] **Step 5: Commit**

```bash
cd app && git add src/hooks/copilot/useCopilotSocket.ts && git commit -m "feat(copilot): add onCancelled + onError socket callbacks with runId

Socket events copilot:cancelled and copilot:error are new (the
backend emits them when a run is aborted or fails). copilot:message
gains a runId field so the frontend can match events to its active
optimistic message."
```

---

## Task 8: Update `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` — wire cancel + currentRunId + handlers

**Files:**
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.tsx`

**Interfaces:**
- Consumes: `cancelRun` (Task 6), `onMessage`/`onCancelled`/`onError` callbacks (Task 7)
- Produces: `currentRunId` state; `store.onCancel` fires DELETE fire-and-forget; socket listeners clear optimistic + runId on the matching event

- [ ] **Step 1: Read `CopilotRuntime.tsx`**

Note the current `onNew` body and the `useCopilotSocket` callback shape.

- [ ] **Step 2: Add `currentRunId` state**

```ts
const [currentRunId, setCurrentRunId] = useState<string | null>(null);
```

(Place near the existing `streamingText` and `optimisticUserMessage` states.)

- [ ] **Step 3: Update the `useCopilotSocket` callback wiring**

```ts
useCopilotSocket({
  conversationId: conversation.data?.id,
  onDelta: (d) => setStreamingText((p) => p + d),
  onStreamEnd: () => setStreamingText(""),
  onMessage: (p) => {
    // The socket refetch will surface the real user + assistant messages;
    // React Query invalidation handles that. Just clear our optimistic state.
    if (p.runId === currentRunId) {
      setOptimisticUserMessage(null);
      setCurrentRunId(null);
    }
  },
  onCancelled: (p) => {
    if (p.runId === currentRunId) {
      setOptimisticUserMessage(null);
      setStreamingText("");
      setCurrentRunId(null);
    }
  },
  onError: (p) => {
    if (p.runId === currentRunId) {
      setOptimisticUserMessage(null);
      setStreamingText("");
      setCurrentRunId(null);
      // Toast via sonner
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { toast } = require("sonner");
      toast.error(p.message);
    }
  },
});
```

(Note: `currentRunId` is referenced inside the callback — wrap the body in `useCallback` if strict linting complains about exhaustive deps. Or use a ref to break the dep cycle.)

- [ ] **Step 4: Update `onNew` to capture runId and clear optimistic on POST response**

```ts
onNew: async (message: AppendMessage) => {
  const text = (message.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (!text.trim()) return;

  const tempMsg: SpokeMessage = {
    id: -Date.now(),
    role: "USER",
    envelope: { type: "text", text },
    createdAt: new Date().toISOString(),
  };
  setOptimisticUserMessage(tempMsg);

  try {
    const result = await copilotService.postMessage(text.trim());
    // Server has persisted the user message. Real messages arrive via socket.
    // Clear optimistic immediately so the React Query refetch doesn't show a duplicate.
    setOptimisticUserMessage(null);
    setCurrentRunId(result.runId);
  } catch (error) {
    setOptimisticUserMessage(null);
    throw error;
  }
},
```

- [ ] **Step 5: Update `onCancel` to fire DELETE in background**

In the `store` useMemo's returned object:

```ts
onCancel: () => {
  setStreamingText("");
  setOptimisticUserMessage(null);
  if (currentRunId) {
    const runId = currentRunId;
    setCurrentRunId(null);
    void copilotService.cancelRun(runId).catch((err) => {
      // Server abort is best-effort. If it fails, the server aborts naturally
      // at MAX_TOOL_ROUNDS time and the resulting copilot:message is ignored
      // since streamingText is already empty.
      console.warn("[copilot] cancelRun failed", err);
    });
  }
},
```

- [ ] **Step 6: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: clean (or only minor warnings).

- [ ] **Step 7: Run `npx eslint --quiet`**

Run: `cd app && npx eslint --quiet`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd app && git add src/components/user/copilot/overlay/CopilotRuntime.tsx && git commit -m "feat(copilot): wire Stop button to true backend cancel

- currentRunId state tracks the in-flight run from POST response
- onNew stores currentRunId after POST, clears optimistic immediately
- store.onCancel fires DELETE fire-and-forget then clears local state
- Socket listeners (onMessage, onCancelled, onError) match by runId
  to clean up optimistic + runId when the corresponding event arrives
- onError surfaces via sonner toast"
```

---

## Task 9: Frontend validation gate

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

With both servers running (`back-end` and `app`), verify:
1. Click Stop during streaming → local state clears immediately; assistant message does not appear; no orphan message on reload
2. Normal send → POST returns `{ runId, conversationId }`; socket `copilot:message` carries `runId`; real messages appear; user message persists
3. Cancel an in-flight run via `curl -X DELETE http://localhost:PORT/copilot/runs/$RUN_ID -H "Authorization: Bearer $TOKEN"` → 200; graph aborts; frontend receives `copilot:cancelled`; no assistant message persisted
4. Cancel a non-existent `runId` → 404
5. Cancel another user's `runId` → 403
6. Trigger a graph error (e.g., break quota) → `copilot:error` fires; toast appears
7. Switch ar ↔ en locale → no regressions in cancel behavior

- [ ] **Step 5: Fix any issues surfaced**

If validation surfaces bugs, fix them in commits. Each commit's message should reference the bug.

---

## Self-review checklist (run before handoff)

1. **Spec coverage:** each requirement in `docs/superpowers/specs/2026-08-24-copilot-cancel-design.md` maps to at least one task. Walk through:
   - activeRuns map → Task 1
   - cancelCopilotRun → Task 1
   - startCopilotTurn split → Task 2
   - DELETE route → Task 3
   - POST returns `{ runId, conversationId }` → Task 4
   - copilot:cancelled + copilot:error events → Task 2 (in background runner)
   - Frontend runId state → Task 8
   - Frontend cancelRun → Task 6
   - Frontend socket handlers → Task 7 + Task 8
   - Frontend onCancel fire-and-forget → Task 8
   - Tests + validation → Tasks 5, 9
2. **Placeholder scan:** no "TBD", "TODO", "implement later" in the plan steps.
3. **Type consistency:** `cancelCopilotRun(runId, userId)`, `startCopilotTurn(params)`, `cancelRun(runId)` — same names everywhere.
4. **Commit boundaries:** each task produces a single, reviewable commit.
