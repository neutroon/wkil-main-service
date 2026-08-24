# Copilot True Regenerate — Design

**Date:** 2026-08-24
**Status:** Approved (brainstorming)
**Scope:** Backend + Frontend
**Author:** Brainstorming session

## Problem

The `Reload` button in the copilot overlay currently calls `copilotService.postMessage(text)` which creates a new turn — the original assistant response stays in the thread and a duplicate user message + new assistant response appear. Users expect "Regenerate" to replace the original response, not append a duplicate.

## Goals

- Clicking `Reload` truly regenerates: deletes the original assistant response (and any later exchanges from that point), re-runs the graph, replaces with the new assistant response.
- The user message itself stays put (same ID, same `createdAt`).
- Stop button works mid-regenerate (uses the same `currentRunId` + cancel flow as normal sends).
- No new dependencies, no DB migration (the delete uses the existing `copilot_messages` table).

## Non-Goals

- Regenerate with editing the user message. The user can edit+resend manually; regenerate preserves the original message verbatim.
- Branching / alternative responses alongside the original. The thread shows only the latest response per turn.
- Per-conversation "regenerate count" or rate-limiting. Out of scope.
- Versioned history. Old responses are gone after regenerate (replaced).

---

## Architecture

```
┌─ Frontend (app/) ─────────────────┐  ┌─ Backend (back-end/) ──────────────┐
│                                  │  │                                    │
│ ActionBarPrimitive.Reload        │  │ POST /v1/copilot/messages/        │
│   → store.onReload(parentId)      │──→│          :userMsgId/regenerate      │
│                                  │  │   ├ verify parent msg exists + is    │
│ onReload:                        │  │   │  the user's + has assistant child │
│   1. POST /messages/.../regen    │  │   ├ delete messages after parent     │
│      → { runId, conversationId } │  │   ├ generate new runId (UUID)        │
│   2. Store currentRunId          │  │   ├ register AbortController        │
│   3. Clear optimistic            │  │   ├ kick off background runner      │
│                                  │  │   └ return { runId, conversationId }│
│ socket: copilot:message {runId} │←─│                                    │
│   → invalidate + show new AI      │  │ Background:                        │
│ socket: copilot:cancelled        │←─│   runs graph, persists ASSISTANT     │
│   → clear local state            │  │   emits copilot:message / cancelled  │
└──────────────────────────────────┘  └────────────────────────────────────┘
```

---

## Backend changes

### Files touched

| File | Change |
|---|---|
| `back-end/src/modules/copilot/copilot.service.ts` | Add `startCopilotRegenerate(params)` and `runCopilotRegenerateBackground(...)` (parallel to `startCopilotTurn` + `runCopilotTurnInBackground`). |
| `back-end/src/modules/copilot/copilot.store.ts` | Add `deleteCopilotMessagesAfter(conversationId, userMsgId, userId)` and `getCopilotMessageById(messageId, userId)` (returns one message or `null` for the existence + ownership check). |
| `back-end/src/modules/copilot/copilot.controller.ts` | New `regenerateCopilotMessageController` handler. |
| `back-end/src/modules/copilot/copilot.routes.ts` | New route `POST /v1/copilot/messages/:userMsgId/regenerate`. |
| `back-end/src/modules/copilot/copilot.service.test.ts` | Tests for `startCopilotRegenerate`. |
| `back-end/src/modules/copilot/copilot.controller.test.ts` | Tests for the controller (200, 404, 422). |

### `startCopilotRegenerate(params)` flow

```ts
type RegenerateParams = {
  userId: number;
  userMsgId: number;        // parent user message
  locale: "ar" | "en";
};

async function startCopilotRegenerate(
  params: RegenerateParams,
): Promise<{ runId: string; conversationId: number }> {
  // 1. Verify the parent message: exists, belongs to user, role is USER.
  const parent = await getCopilotMessageById(params.userMsgId, params.userId);
  if (!parent) throw new AppError("parent message not found", 404, false);
  if (parent.role !== "USER") {
    throw new AppError("parent must be a user message", 422, false);
  }

  // 2. Verify there's an assistant response after the parent to regenerate.
  const children = await listCopilotMessages(parent.conversationId, 50);
  const hasAssistant = children.some(
    (m) =>
      m.role === "ASSISTANT" &&
      new Date(m.createdAt) >= new Date(parent.createdAt),
  );
  if (!hasAssistant) {
    throw new AppError("no assistant response to regenerate", 422, false);
  }

  // 3. Delete messages after the parent (including original assistant + later turns).
  await deleteCopilotMessagesAfter(parent.conversationId, params.userMsgId, params.userId);

  // 4. Register the new runId + kick off background runner.
  const runId = randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, {
    abortController,
    conversationId: parent.conversationId,
    userId: params.userId,
  });

  // Fire-and-forget; the background runner persists ASSISTANT and emits copilot:message.
  void runCopilotRegenerateBackground(runId, params, parent, abortController.signal);

  return { runId, conversationId: parent.conversationId };
}
```

### `runCopilotRegenerateBackground(runId, params, parent, signal)` flow

```ts
async function runCopilotRegenerateBackground(
  runId: string,
  params: RegenerateParams,
  parent: CopilotMessage,
  signal: AbortSignal,
): Promise<void> {
  try {
    const parentText = (parent.envelope as { type: "text"; text: string }).text;

    const out = await runCopilotGraph({
      conversationId: parent.conversationId,
      userId: params.userId,
      locale: params.locale,
      text: parentText,
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

### `deleteCopilotMessagesAfter(conversationId, userMsgId, userId)` SQL

```sql
DELETE FROM copilot_messages
WHERE conversation_id = $1
  AND user_id = $2
  AND created_at > (
    SELECT created_at FROM copilot_messages WHERE id = $3 AND user_id = $2
  )
```

Scoped to `user_id` for defense-in-depth (even though the controller already validates the parent is the user's). Uses `created_at >` (strict) so the parent itself is preserved.

### Route shape

```
POST /v1/copilot/messages/:userMsgId/regenerate  → 200 { data: { runId, conversationId } }
                                              → 404 { error: { message: "parent message not found" } }
                                              → 422 { error: { message: "no assistant response to regenerate" } }
```

### Security

- `userId` is derived from `req.user.id` (authenticated user), not request body.
- The `userMsgId` param is validated via `getCopilotMessageById(messageId, userId)` — if the message doesn't exist OR belongs to another user, returns `null` and the controller throws 404. No information leak about other users' messages.
- `deleteCopilotMessagesAfter` is scoped to `user_id` in the WHERE clause.

---

## Frontend changes

### Files touched

| File | Change |
|---|---|
| `app/src/lib/copilot-api.ts` | Add `regenerateMessage(userMsgId): Promise<{ runId; conversationId }>` method. |
| `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` | Update `store.onReload(parentId)` to call `regenerateMessage(parent.id)` instead of `copilotService.postMessage(env.text)`. |

### `regenerateMessage` API

```ts
// app/src/lib/copilot-api.ts
async regenerateMessage(userMsgId: number): Promise<{
  runId: string;
  conversationId: number;
}> {
  const res = await fetchWithAuth<{ data: { runId: string; conversationId: number } }>(
    `${COPILOT_API.MESSAGES}/${userMsgId}/regenerate`,
    { method: "POST" },
  );
  return res.data;
}
```

### `store.onReload` update

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
    throw error;
  }
},
```

---

## Edge cases

1. **Cancel during regenerate**: user clicks Stop mid-regenerate. Stop button calls `store.onCancel` (from cancel feature), which fires `cancelRun(currentRunId)` against the new runId. Backend aborts the background runner → emits `copilot:cancelled` → frontend clears local state. The previously-deleted messages are NOT restored — the user has to send a new message to continue. Acceptable for v1.

2. **Click Reload twice on the same parent**: First call sets `currentRunId` to runId A. Second call gets runId B and overwrites. Old run A continues in the background. When A's `copilot:message` fires, `currentRunIdRef.current` is B, so the optimistic clear is skipped — no harm. The A message just appends to the thread. Acceptable but wasteful. Future enhancement: cancel A before starting B.

3. **Reload on a message whose parent isn't a user message**: shouldn't happen — `onReload` is only called from `ActionBarPrimitive.Reload` on assistant messages. The runtime passes the preceding user message's ID. If the runtime ever passes an invalid ID, the lookup silently no-ops.

4. **404 from server (parent deleted between renders)**: try/catch logs and re-throws. The assistant-ui composer surfaces the error. Thread shows the old assistant message until the user takes another action. Acceptable.

---

## Data flow example

```
Frontend                                      Backend
────────                                      ───────
User clicks "Regenerate" on assistant msg #42
(parent #41 is the user message)
  └→ store.onReload("41")
  └→ setStreamingText("")
  └→ setOptimisticUserMessage(null)
  └→ POST /v1/copilot/messages/41/regenerate
                                              SELECT * FROM copilot_messages WHERE id=41 AND user_id=5
                                                → found, role=USER
                                              SELECT * FROM copilot_messages WHERE conversation_id=...
                                                → assistant message #42 found after #41
                                              DELETE FROM copilot_messages
                                                WHERE conversation_id=... AND user_id=5
                                                AND created_at > #41.created_at
                                                → deletes #42 (and any later turns)
                                              runId = uuid()
                                              activeRuns.set(runId, { abortController, ... })
                                              kick off background runner
  ←─ 200 { data: { runId, conversationId } }
  └→ setCurrentRunId(runId)
                                              graph streams deltas ──→ copilot:delta
                                              graph completes
                                              persist ASSISTANT #42 (new)
                                              emitToCopilot("copilot:message", { runId, ... })
  ←─ copilot:message
  └→ invalidate queries → refetch
  └→ messages shown: [#41 (user, original), #42 (assistant, NEW)]

[If user clicks Stop mid-regenerate]
  └→ store.onCancel()
  └→ DELETE /v1/copilot/runs/<runId> ─────────→ abortController.abort()
                                              activeRuns.delete(runId)
  ←─ 200 { data: { cancelled: true } }              graph.invoke rejects with AbortError
                                              catch → emitToCopilot("copilot:cancelled", { runId })
  ←─ copilot:cancelled                       [frontend: no-op, already cleared]
                                              activeRuns.delete(runId)
  [Thread still shows: #41 (user), #42 (was deleted). User sends a new message to continue.]
```

---

## Migration & sequencing

**Single PR:**
- Backend: `copilot.store.ts` (new helpers), `copilot.service.ts` (new functions), `copilot.routes.ts` + `copilot.controller.ts` (new endpoint), tests.
- Frontend: `copilot-api.ts` (new method), `CopilotRuntime.tsx` (`onReload` rewires).

**No DB migration** — uses existing `copilot_messages` table.

---

## Testing strategy

### Backend

- `copilot.service.test.ts`:
  - `startCopilotRegenerate` returns `{ runId, conversationId }` for valid parent
  - Throws `AppError(404)` when parent not found
  - Throws `AppError(422)` when parent exists but is not a USER message
  - Throws `AppError(422)` when parent exists but no ASSISTANT child
  - Abort during regenerate emits `copilot:cancelled` (no persist) — reuses pattern from cancel
- `copilot.controller.test.ts`:
  - POST returns 200 with `{ data: { runId, conversationId } }` for valid request
  - Returns 404 when parent not found
  - Returns 422 when no assistant child

### Frontend

No test runner. Manual smoke test:
1. Click Regenerate → original AI response replaced with new one; user message unchanged
2. Click Regenerate mid-stream → Stop button cancels the regenerate
3. Click Regenerate twice on the same parent → both runs complete; thread shows the latest one
4. Trigger server error → toast appears; thread state consistent

---

## Files touched

**Backend (new + modified):**
- `back-end/src/modules/copilot/copilot.service.ts` (modified — add `startCopilotRegenerate` + `runCopilotRegenerateBackground`)
- `back-end/src/modules/copilot/copilot.store.ts` (modified — add `getCopilotMessageById` + `deleteCopilotMessagesAfter`)
- `back-end/src/modules/copilot/copilot.controller.ts` (modified — add `regenerateCopilotMessageController`)
- `back-end/src/modules/copilot/copilot.routes.ts` (modified — add `POST /v1/copilot/messages/:userMsgId/regenerate`)
- `back-end/src/modules/copilot/copilot.service.test.ts` (modified — add tests)
- `back-end/src/modules/copilot/copilot.controller.test.ts` (modified — add tests)

**Frontend (modified):**
- `app/src/lib/copilot-api.ts` (modified — add `regenerateMessage` method)
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` (modified — `onReload` uses `regenerateMessage`)

**New (none — both functions and routes fit existing files):**
- (none)

---

## Known limitations

1. **Multi-turn conversations**: regenerating deletes ALL messages after the parent, including any later exchanges. To preserve conversation history, regenerate only the immediate AI response — would require versioning the assistant message row instead of delete-and-replace. Deferred.

2. **Concurrent regenerate on same parent**: two parallel regenerates race. The first to delete wins; the second's parent lookup may find the deleted parent. Need a transaction or lock. Deferred.

3. **Quota exhaustion during regenerate**: similar to cancel — if quota is exhausted AFTER delete but BEFORE new persist, the user message stands alone with no assistant response. User has to send a new message. Acceptable for v1.

4. **Editing the user message before regenerate**: not supported. The user message text is read from the parent at the time of regenerate, so if the user wants different context, they should edit+resend manually. Future enhancement.

---

## Out of scope (deferred)

- Feedback submission (separate follow-up)
- GFM markdown (separate follow-up)
- Multi-turn regenerate preservation
- Branching / alternative responses
