# Copilot True Backend Cancel — Design

**Date:** 2026-08-24
**Status:** Approved (brainstorming)
**Scope:** Backend + Frontend
**Author:** Brainstorming session

## Problem

The `Stop` button in the copilot overlay currently clears local state but does NOT stop the backend LangGraph. Clicking Stop during streaming hides the UI updates, but the server keeps running until `MAX_TOOL_ROUNDS` is exhausted or the graph completes naturally. Wasted compute, wasted quota, and (in multi-tenant scenarios) the in-flight graph occupies a thread slot until it terminates.

## Goals

- Clicking `Stop` truly aborts the backend graph within milliseconds.
- Backend persists no assistant message on cancel (per design choice — see "Persistence behavior").
- Frontend UX stays local-first: clearing the UI does not block on the server confirm.
- Existing cancel flow that works when graph already finished (no-op 404) is preserved.

## Non-Goals

- Per-user thread slot accounting (cancel still uses server resources until abort completes — milliseconds in practice).
- Distributed cancel across multiple backend instances. The `activeRuns` map is in-memory; cancel only works for runs on the same instance. For multi-instance deployments, the spec would need Redis or DB-backed run tracking. Deferred.
- Cancelling an already-persisted assistant message. Cancel only applies to in-flight runs.
- True regenerate, feedback submission, GFM markdown — separate follow-ups.

---

## Architecture

```
┌─ Frontend (app/) ─────────────────┐  ┌─ Backend (back-end/) ──────────────┐
│                                  │  │                                    │
│ onSend(text)                     │  │ POST /copilot/messages             │
│   └→ POST → { runId, convId }   │──→│   ├ save USER message               │
│                                  │  │   ├ generate runId (UUID)           │
│ store.onCancel(runId)            │  │   ├ register AbortController        │
│   ├─ clear streamingText +       │  │   ├ kick off graph in background    │
│   │  optimisticUserMessage       │  │   └ return { runId, conversationId }│
│   └─ fire-and-forget DELETE       │  │                                    │
│        /copilot/runs/:runId       │──→│ DELETE /copilot/runs/:runId        │
│                                  │  │   ├ lookup activeRuns[runId]        │
│ socket listener:                 │  │   ├ AbortController.abort()         │
│   copilot:message { runId, ... }  │←─│   ├ emit "copilot:cancelled"        │
│   copilot:cancelled { runId }    │←─│   └ activeRuns.delete(runId)        │
│   copilot:error { runId }        │←─│                                    │
│                                  │  │ Background:                        │
│ onCancel clears optim on POST    │  │   graph.invoke({ signal })          │
│ response (real user msg already   │  │   └ catches AbortError → no persist  │
│ saved; socket message refetches) │  │                                    │
└──────────────────────────────────┘  └────────────────────────────────────┘
```

---

## Backend changes

### Files touched

| File | Change |
|---|---|
| `back-end/src/modules/copilot/copilot.service.ts` | Split `runCopilotTurn` into `startCopilotTurn` (sync, returns `{ runId, conversationId }`) and `runCopilotTurnInBackground` (async, runs graph + persists + emits). Add `cancelCopilotRun(runId, userId)`. Module-level `activeRuns: Map<string, ActiveRun>`. |
| `back-end/src/modules/copilot/copilot.routes.ts` | New route `DELETE /copilot/runs/:runId`. Modify `POST /copilot/messages` to use `startCopilotTurn`. |
| `back-end/src/modules/copilot/copilot.controller.ts` | Update handlers for new response shapes (POST returns `{ runId, conversationId }`; DELETE returns `{ cancelled }`). |
| `back-end/src/modules/copilot/copilot.controller.test.ts` | Mock `startCopilotTurn` returning `{ runId, conversationId }`. Add tests for DELETE: 200 with cancelled=true when active, 404 when not found, 403 when runId belongs to another user. |
| `back-end/src/modules/copilot/copilot.service.test.ts` | Update existing tests for async split. Add tests for `cancelCopilotRun`. Add test for abort-persists-nothing behavior (assert that no `appendCopilotMessage` for ASSISTANT happens after abort). |

### `activeRuns` map (in-memory)

```ts
type ActiveRun = {
  abortController: AbortController;
  conversationId: number;
  userId: number;
};
const activeRuns = new Map<string, ActiveRun>();
```

In-memory only. Lost on server restart (acceptable — a restarted server has no in-flight runs to cancel). Multi-instance deployment is a known limitation (cancel works only for runs on the same instance). Documented in the spec's "Known limitations" section.

### `startCopilotTurn(params)` — sync, returns `{ runId, conversationId }`

1. Get/create conversation
2. Assert quota
3. Save USER message
4. Generate `runId = crypto.randomUUID()`
5. Create `AbortController`, register in `activeRuns.set(runId, { abortController, conversationId, userId })`
6. Fire-and-forget: `void runCopilotTurnInBackground(runId, params, conv, abortController.signal)`
7. Return `{ runId, conversationId: conv.id }`

### `runCopilotTurnInBackground(runId, params, conv, signal)` — async, no return

1. Call `runCopilotGraph({ ...params, signal })`
2. **On success:** record usage, persist assistant message, emit `copilot:message` with `runId`
3. **On AbortError:** emit `copilot:cancelled` with `runId`. **Do NOT persist anything.**
4. **On other error:** log, emit `copilot:error` with `runId` and message
5. `finally`: `activeRuns.delete(runId)`

### `cancelCopilotRun(runId, userId)` — async, returns `{ cancelled: boolean }`

1. Lookup `activeRuns.get(runId)`
2. **Not found:** return `{ cancelled: false }` (route returns 404)
3. **Found but `userId` mismatch:** return `{ cancelled: false }` (route returns 403 — don't let user A cancel user B's run)
4. **Found and matching:** call `abortController.abort()`, `activeRuns.delete(runId)`, return `{ cancelled: true }` (route returns 200)

### Socket events

| Event | Payload | When emitted |
|---|---|---|
| `copilot:message` | `{ runId, conversationId, envelopes, truncated, expectedTotal }` | Existing event, now includes `runId` |
| `copilot:cancelled` | `{ runId, conversationId }` | **New.** Emitted when a run was cancelled (either via DELETE or auto-timeout). |
| `copilot:error` | `{ runId, conversationId, message }` | **New.** Emitted on unexpected graph errors (replaces the sync `{ ok: false }` return path that no caller can receive). |
| `copilot:delta` | `{ conversationId, delta }` | Existing, unchanged |
| `copilot:progress` | `{ conversationId, message }` | Existing, unchanged |

### Route shape

```
POST   /copilot/messages              → 200 { runId, conversationId }
DELETE /copilot/runs/:runId          → 200 { cancelled: true }  (active run cancelled)
                                       404 { cancelled: false, message: "no active run" }
                                       403 { cancelled: false, message: "forbidden" }
GET    /copilot/messages?limit=N     → 200 { data: CopilotMessage[] }  (existing, unchanged)
GET    /copilot/conversation          → 200 { data: CopilotConversation } (existing, unchanged)
```

### LangGraph signal support

`graph.invoke(input, { signal })` is supported in `langgraph@0.2+`. Our installed version is verified during implementation. If unsupported, fallback is `Promise.race(graphPromise, abortPromise)` — uglier but works.

### Error handling

- **AbortError** (caught explicitly): cancel path, emit `copilot:cancelled`, no persist.
- **Other errors**: log, emit `copilot:error` with message. The frontend surfaces via toast.
- **Persist failure** (DB write fails after graph succeeds): log error, still emit `copilot:message` so user sees the result. Operator investigates via logs.

---

## Frontend changes

### Files touched

| File | Change |
|---|---|
| `app/src/lib/copilot-api.ts` | `postMessage` returns `Promise<{ runId; conversationId }>` (drops envelopes/truncated/expectedTotal from sync return). New `cancelRun(runId): Promise<{ cancelled: boolean }>`. |
| `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` | Add `currentRunId` state. `onNew` stores `currentRunId` and clears optimistic on POST response. `store.onCancel` fires DELETE in background then clears local state. New socket handlers for `copilot:cancelled` and `copilot:error`. |
| `app/src/hooks/copilot/useCopilotSocket.ts` | Extend callback shape with `onCancelled` and `onError`. |
| `app/src/types/openapi.generated.ts` | Regenerate after backend changes (if generated types are wired). |

### Optimistic message lifecycle (revised)

| Trigger | Action |
|---|---|
| `onNew` invoked (user hits Send) | Set `optimisticUserMessage` (temp negative ID). Call `copilotService.postMessage(text)`. On response, store `currentRunId` and **clear optimistic** (real user message is already saved on the server; socket `copilot:message` refetches it). |
| Socket `copilot:message` arrives with matching `runId` | React Query refetches; real messages appear. `isRunning` flips to false. `currentRunId` cleared. |
| Socket `copilot:cancelled` arrives with matching `runId` | Clear optimistic (if still present), clear streamingText, clear `currentRunId`. No assistant message. |
| Socket `copilot:error` arrives with matching `runId` | Clear optimistic + streamingText, clear `currentRunId`, show error toast via `sonner`. |

The optimistic message is cleared on POST response (not on socket `copilot:message`) because the server has already persisted the user message by then. There's a brief window where the optimistic is gone but the refetch hasn't completed — the streaming ghost (if any) covers that visually.

### `store.onCancel`

```ts
onCancel: () => {
  // Local-first: clear immediately so the UI is responsive.
  setStreamingText("");
  setOptimisticUserMessage(null);
  // Fire-and-forget: tell the server to abort. Don't await — the UI
  // shouldn't block on the DELETE. If it fails, the server aborts naturally
  // at MAX_TOOL_ROUNDS time and the resulting copilot:message is ignored
  // since streamingText is already empty.
  if (currentRunId) {
    void copilotService.cancelRun(currentRunId).catch((err) => {
      console.warn("[copilot] cancelRun failed", err);
    });
    setCurrentRunId(null);
  }
},
```

### `useCopilotSocket` callback extension

```ts
useCopilotSocket({
  conversationId: ...,
  onDelta: (d) => setStreamingText((p) => p + d),
  onStreamEnd: () => setStreamingText(""),
  onMessage: (p: { runId: string; conversationId: number; envelopes: CopilotEnvelope[]; truncated: boolean; expectedTotal: number | null }) => {
    queryClient.invalidateQueries(...);
    if (p.runId === currentRunId) {
      setOptimisticUserMessage(null);
      setCurrentRunId(null);
    }
  },
  onCancelled: (p: { runId: string; conversationId: number }) => {
    if (p.runId === currentRunId) {
      setOptimisticUserMessage(null);
      setStreamingText("");
      setCurrentRunId(null);
    }
  },
  onError: (p: { runId: string; conversationId: number; message: string }) => {
    if (p.runId === currentRunId) {
      setOptimisticUserMessage(null);
      setStreamingText("");
      setCurrentRunId(null);
      toast.error(p.message);
    }
  },
});
```

**Edge case — cancel before POST response:** if the user clicks Stop within the millisecond window before `currentRunId` is set (POST response hasn't returned yet), `currentRunId` is `null` and the DELETE is not fired. The backend graph still runs to `MAX_TOOL_ROUNDS`. In practice this window is sub-100ms so users won't hit it, but document for the test plan: clicking Stop before the POST response completes is not aborting the backend.

### Stop button

No UI change. The existing `StopButton` in `CopilotPanelSurface.tsx` already calls `useCopilotCancel()`. Behavior change is internal: it now also fires the DELETE in the background.

### `cancelRun` API

```ts
// app/src/lib/copilot-api.ts
async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  const res = await fetchWithAuth<{ cancelled: boolean }>(
    `${COPILOT_API.MESSAGES}/runs/${runId}`,
    { method: "DELETE" },
  );
  return res.data;
}
```

(Exact `COPILOT_API.MESSAGES` constant path verified during implementation.)

### Test plan

The frontend has no test runner for these components. Manual smoke test will verify:

1. Click Stop during streaming → local state clears immediately; assistant message does not appear; no orphan message on reload
2. Normal send → POST returns `{ runId, conversationId }`; socket `copilot:message` carries `runId`; real messages appear; user message persists
3. Cancel an in-flight run via `curl -X DELETE` → 200; graph aborts
4. Cancel a non-existent `runId` via `curl` → 404
5. Cancel another user's `runId` → 403

---

## Data flow examples

### Happy path (no cancel)

```
Frontend                                    Backend
─────────                                    ───────
[User clicks Send]
  └→ setOptimisticUserMessage(text)
  └→ POST /copilot/messages
                                              save USER msg
                                              runId = uuid()
                                              register AbortController
                                              kick off graph (background)
  ←─ 200 { runId, conversationId }
  └→ setCurrentRunId(runId)
  └→ clearOptimisticUserMessage()
                                              graph streams deltas ──→ copilot:delta (no runId needed)
                                              graph completes
                                              save ASSISTANT msg
                                              emitToCopilot("copilot:message", { runId, ... })
  ←─ copilot:message
  └→ invalidate queries → refetch
  └→ real messages appear
```

### Cancel mid-stream

```
Frontend                                    Backend
─────────                                    ───────
(Streaming in progress, deltas arriving)
[User clicks Stop]
  └→ setStreamingText("")
  └→ setOptimisticUserMessage(null)        [local state cleared — UI updates immediately]
  └→ DELETE /copilot/runs/:runId ─────────→ lookup activeRuns[runId]
                                              abortController.abort()
                                              activeRuns.delete(runId)
  ←─ 200 { cancelled: true }                 (graph still aborting in background)
  └→ setCurrentRunId(null)
                                              graph.invoke rejects with AbortError
                                              catch AbortError → emitToCopilot("copilot:cancelled", { runId })
  ←─ copilot:cancelled                       [frontend socket listener: no-op since state already cleared]
  [UI stays clean]
```

### Error mid-graph (non-cancel)

```
Frontend                                    Backend
─────────                                    ───────
(graph running, throws unexpectedly)
                                              catch error → emitToCopilot("copilot:error", { runId, message })
  ←─ copilot:error
  └→ toast.error(message)
  └→ clear local state
  [User sees toast; can retry]
```

---

## Migration & sequencing

**Single PR, sequenced:**

1. **Backend:**
   - `copilot.service.ts` — split into sync/async, add cancel
   - `copilot.routes.ts` + `copilot.controller.ts` — add DELETE route
   - Tests updated + new

2. **Frontend:**
   - `copilot-api.ts` — new return shape, `cancelRun` method
   - `CopilotRuntime.tsx` — `currentRunId`, socket handlers, `onCancel` fire-and-forget
   - `useCopilotSocket.ts` — new callback shape

3. **Validation:** full backend test suite, manual smoke test (cancel + happy path)

**No DB migration.** In-memory state only.

---

## Testing strategy

### Backend

- `copilot.service.test.ts`:
  - Update existing tests: `runCopilotTurn` is split; mock the new structure
  - Add: `startCopilotTurn` returns `{ runId, conversationId }` synchronously
  - Add: `cancelCopilotRun(runId)` returns `{ cancelled: true }` for active runs
  - Add: `cancelCopilotRun(runId)` returns `{ cancelled: false }` for unknown runIds
  - Add: `cancelCopilotRun(runId, userIdA)` returns `{ cancelled: false }` when runId belongs to userIdB
  - Add: abort path — after abort, no `appendCopilotMessage` for ASSISTANT is called
- `copilot.controller.test.ts`:
  - Mock `startCopilotTurn` returning `{ runId: 'abc', conversationId: 7 }`
  - POST returns 200 with `{ runId, conversationId }`
  - DELETE returns 200 with `{ cancelled: true }` when active
  - DELETE returns 404 when not found
  - DELETE returns 403 when user mismatch

### Frontend

No test runner. Manual smoke test per the data flow examples above.

---

## Files touched

**Backend (new + modified):**
- `back-end/src/modules/copilot/copilot.service.ts` (modified)
- `back-end/src/modules/copilot/copilot.routes.ts` (modified — add DELETE)
- `back-end/src/modules/copilot/copilot.controller.ts` (modified)
- `back-end/src/modules/copilot/copilot.controller.test.ts` (modified)
- `back-end/src/modules/copilot/copilot.service.test.ts` (modified)

**Frontend (modified):**
- `app/src/lib/copilot-api.ts`
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx`
- `app/src/hooks/copilot/useCopilotSocket.ts`
- `app/src/types/openapi.generated.ts` (regenerated)

**New (none — both endpoints and socket events fit existing files):**
- (none)

---

## Known limitations

1. **Multi-instance cancel:** The `activeRuns` map is per-instance. A cancel request that lands on instance B for a run on instance A returns 404 (no-op). For multi-instance, we'd need Redis or DB-backed run tracking. **Deferred.**

2. **Auto-cancel on MAX_TOOL_ROUNDS:** The cap-hit path (`finalize` node) currently appends a fallback text envelope and emits the assistant message normally. It does NOT emit `copilot:cancelled`. The cap-hit is a normal completion, not a user-initiated cancel. Frontend shows the fallback text + a "Got N of M" footer (existing behavior).

3. **Cancel race with persist:** If cancel arrives DURING the assistant message persist, the persist may still complete (DB write is atomic per-row but not under transaction with abort). Worst case: cancel succeeds but a half-written assistant message appears on reload. Acceptable since reload is the recovery path.

4. **No timeout-based cancel:** If the user clicks Stop but the DELETE fails (network), the server continues until `MAX_TOOL_ROUNDS` (10). The frontend already cleared local state, so the user sees nothing — but the server is still working. **Add a timeout-based cancel** as a future enhancement (e.g., 30s).

---

## Out of scope (deferred)

- True regenerate (separate follow-up)
- Feedback submission (separate follow-up)
- GFM markdown (separate follow-up)
- Multi-instance cancel via Redis/DB
- Cancel timeout enforcement
