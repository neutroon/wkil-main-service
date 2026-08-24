# Copilot Multi-Chat Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the single-conversation copilot overlay into a ChatGPT-style multi-chat interface — collapsible left sidebar with conversation list + "+ New chat" button, right pane shows the active thread.

**Architecture:** Use `assistant-ui@0.15.16`'s native `useRemoteThreadListRuntime` + `ExternalStoreThreadListAdapter` to manage the thread list. Replace the `useCopilotUiRuntime`'s single-thread store with a thread-aware store. Restructure `CopilotPanelSurface` into a two-column layout. Library-first — no manual thread state management.

**Tech Stack:** Next.js 15, React 19, `@assistant-ui/react@0.15.16`, `lucide-react` (already installed for icons), `framer-motion` (already installed for animations), `pnpm`, TypeScript, ESLint.

## Global Constraints

- Library-first approach — use `ThreadListPrimitive`, `useThreadListItem`, `useRemoteThreadListRuntime`, `ExternalStoreThreadListAdapter`, `useThreadListItemRuntime`. No manual thread management.
- No new dependencies. Use existing packages (`lucide-react`, `framer-motion`, `sonner`, `@assistant-ui/react`).
- Frontend has no test runner — manual smoke test only.
- Existing single-conversation user keeps working — the `useRemoteThreadListRuntime.initialize()` creates a default conversation on first load (uses the existing `getOrCreateCopilotConversation` pattern via the adapter).
- Sidebar collapse: framer-motion animated, 280px wide, mobile-friendly (slides in from left).
- The current `useCopilotUiRuntime` signature stays backward-compatible — the only change is the internal store now supports multiple threads via the runtime.
- Title display: show the conversation's `title` field if set, else "New chat". Default fallback for null/empty.
- The active thread is reflected in `runtime.thread` state (provided by `useRemoteThreadListRuntime`). Component reads via `useAuiState`.

---

## File Structure

**Frontend (modified):**
- `app/src/lib/copilot-api.ts` — add 4 new methods: `listConversations()`, `createConversation()`, `renameConversation(id, title)`, `deleteConversation(id)`. Add optional `conversationId` param to `postMessage`.
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` — restructure to use `useRemoteThreadListRuntime` + `ExternalStoreThreadListAdapter`; thread switching; adapt `onNew` for the active thread.
- `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` — restructure layout: collapsible left sidebar + right thread area; add `ThreadListPrimitive.New`, `ThreadListPrimitive.Items`, custom `ThreadListItemPrimitive`.

---

## Task 1: Add 4 new methods to the API client

**Files:**
- Modify: `app/src/lib/copilot-api.ts`

**Interfaces:**
- Consumes: existing `fetchWithAuth` pattern, `COPILOT_API` constants
- Produces: `listConversations()`, `createConversation()`, `renameConversation(id, title)`, `deleteConversation(id)` methods on `CopilotService`. Optional `conversationId` param on `postMessage`.

- [ ] **Step 1: Read the current API client**

Read `app/src/lib/copilot-api.ts`. Note the existing `postMessage`, `cancelRun`, `regenerateMessage` patterns and the `COPILOT_API.MESSAGES` / `COPILOT_API.RUN_BY_ID` constants.

- [ ] **Step 2: Check the `COPILOT_API` constants**

Read `app/src/lib/config.ts` and confirm there's a `COPILOT_API.CONVERSATIONS` constant. If not, add one (parallel to `COPILOT_API.MESSAGES`).

- [ ] **Step 3: Add the 4 new methods**

```ts
// Inside the CopilotService class
async listConversations(): Promise<CopilotConversation[]> {
  const res = await fetchWithAuth<{ data: CopilotConversation[] }>(COPILOT_API.CONVERSATIONS);
  return res.data;
}

async createConversation(): Promise<{ id: number; conversationId: number }> {
  const res = await fetchWithAuth<{ data: { id: number; conversationId: number } }>(
    COPILOT_API.CONVERSATIONS,
    { method: "POST" },
  );
  return res.data;
}

async renameConversation(id: number, title: string): Promise<void> {
  await fetchWithAuth<{ data: { id: number } }>(
    `${COPILOT_API.CONVERSATIONS}/${id}`,
    { method: "PATCH", body: JSON.stringify({ title }) },
  );
}

async deleteConversation(id: number): Promise<void> {
  await fetchWithAuth(
    `${COPILOT_API.CONVERSATIONS}/${id}`,
    { method: "DELETE" },
  );
}
```

- [ ] **Step 4: Add optional `conversationId` to `postMessage`**

Modify the existing `postMessage` signature to accept an optional `conversationId`:

```ts
async postMessage(text: string, conversationId?: number): Promise<{
  runId: string;
  conversationId: number;
}> {
  const res = await fetchWithAuth<{ data: { runId: string; conversationId: number } }>(
    COPILOT_API.MESSAGES,
    {
      method: "POST",
      body: JSON.stringify({ text, ...(conversationId !== undefined ? { conversationId } : {}) }),
    },
  );
  return res.data;
}
```

- [ ] **Step 5: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: errors in `CopilotRuntime.tsx` because the existing code ignores the return value. That's expected — Task 2 fixes it.

- [ ] **Step 6: Commit**

```bash
cd app && git add src/lib/copilot-api.ts
git commit -m "feat(copilot): add 4 conversation API methods + conversationId param

- listConversations: returns user's conversations
- createConversation: POST, returns { id, conversationId }
- renameConversation: PATCH, takes title
- deleteConversation: DELETE
- postMessage now accepts optional conversationId so messages can be
  posted to a specific thread (defaults to 'current' if omitted)"
```

---

## Task 2: Wire `useRemoteThreadListRuntime` in `CopilotRuntime`

**Files:**
- Modify: `app/src/components/user/copilot/overlay/CopilotRuntime.tsx`

**Interfaces:**
- Consumes: `useRemoteThreadListRuntime` from `@assistant-ui/react`, `ExternalStoreThreadListAdapter` type
- Produces: a `threadListRuntime` instance with `threadListAdapter` bound to `copilotService.listConversations/createConversation/renameConversation/deleteConversation`

- [ ] **Step 1: Read the current `CopilotRuntime.tsx`**

Note the existing `useCopilotSocket` setup and the `store` useMemo pattern.

- [ ] **Step 2: Look up the type signature for `ExternalStoreThreadListAdapter`**

In `node_modules/@assistant-ui/react/dist/index.d.ts`, find the `ExternalStoreThreadListAdapter` type. Note the required methods: `list`, `initialize`, `rename`, `delete`, `create` (and their signatures).

- [ ] **Step 3: Add the adapter**

Replace the function body of `useCopilotUiRuntime`:

```ts
import { useMemo, useState, useCallback } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import { useCopilotConversation } from "@/hooks/copilot/useCopilotConversation";
import { useCopilotSocket } from "@/hooks/copilot/useCopilotSocket";
import {
  copilotService,
  type CopilotConversation,
  type CopilotEnvelope,
  type CopilotMessage,
  type CopilotMessageEnvelope,
} from "@/lib/copilot-api";

// ... existing helpers (envelopeToPart, SpokeMessage type) ...

const threadListAdapter: ExternalStoreThreadListAdapter<CopilotConversation> = useMemo(() => ({
  list: async () => copilotService.listConversations(),
  initialize: async () => {
    // The existing useCopilotConversation hook already gets-or-creates
    // the primary conversation. Use that as the initial thread.
    const conv = await copilotService.getConversation();
    return {
      remoteId: String(conv.id),
      externalId: undefined,
      title: conv.title ?? "New chat",
    };
  },
  rename: async (threadId, title) => {
    await copilotService.renameConversation(Number(threadId), title);
  },
  delete: async (threadId) => {
    await copilotService.deleteConversation(Number(threadId));
  },
  create: async () => {
    const created = await copilotService.createConversation();
    return {
      remoteId: String(created.id),
      externalId: undefined,
      title: created.title ?? "New chat",
    };
  },
}), []);

const threadListRuntime = useRemoteThreadListRuntime({
  adapter: threadListAdapter,
});

export function useCopilotUiRuntime() {
  const { conversation, messages } = useCopilotConversation();
  const [streamingText, setStreamingText] = useState("");
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<SpokeMessage | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  useCopilotSocket({
    conversationId: conversation.data?.id,
    onDelta: (d) => setStreamingText((p) => p + d),
    onStreamEnd: () => setStreamingText(""),
  });

  const visibleMessages = useMemo(() => { /* ... unchanged ... */ }, [...]);

  const cancel = useCallback(/* ... unchanged ... */, []);

  const reload = useCallback(/* ... unchanged ... */, []);

  const store = useMemo(() => ({ /* ... unchanged ... */ }), [...]);

  const runtime = useExternalStoreRuntime(store);

  return (
    <ThreadListProvider runtime={threadListRuntime}>
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </ThreadListProvider>
  );
}
```

Where `ThreadListProvider` is the official provider (from `useRemoteThreadListRuntime`). The exact provider import name depends on the library version — verify in `node_modules/@assistant-ui/react/dist/legacy-runtime/runtime-cores/remote-thread-list/` or similar.

- [ ] **Step 4: Update `onNew` to post to the active conversation**

Read the current thread's conversation ID via `useAuiState` (or via the `threadListRuntime`) and pass it as `conversationId` to `postMessage`.

```ts
const activeThreadId = useAuiState((s) => s.threadList.remoteId);

onNew: async (message: AppendMessage) => {
  // ... extract text from message.content ...
  const conversationId = activeThreadId ? Number(activeThreadId) : undefined;
  // ... optimistic insert ...
  const result = await copilotService.postMessage(text.trim(), conversationId);
  // ... rest of existing logic ...
},
```

- [ ] **Step 5: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: errors related to the existing context-shape incompatibility — fix by:
- Wrapping the existing `useCopilotUiRuntime` consumer in the new provider
- Or returning the runtime from `useCopilotUiRuntime` and wrapping externally

Either approach is fine. The simplest: wrap inside `useCopilotUiRuntime` via a new exported `CopilotRuntimeProvider` component (like the cancel plan's approach).

- [ ] **Step 6: Run `npx eslint --quiet`**

Run: `cd app && npx eslint --quiet`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd app && git add src/components/user/copilot/overlay/CopilotRuntime.tsx
git commit -m "feat(copilot): wire useRemoteThreadListRuntime + adapter

Library-first: use assistant-ui's official thread-list runtime
instead of rolling our own. Adapter wraps copilotService's 4 new
methods (list/create/rename/delete). Wraps the existing message
runtime in <ThreadListProvider runtime={...}> so the whole
copilot overlay gets thread-list state for free.

onNew now reads activeThreadId from useAuiState and passes it as
conversationId to postMessage so new messages go to the active thread
(not always the primary)."
```

---

## Task 3: Add sidebar layout to `CopilotPanelSurface`

**Files:**
- Modify: `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx`

**Interfaces:**
- Consumes: existing `CopilotRuntimeProvider` (from Task 2), `ThreadListPrimitive.New`, `ThreadListPrimitive.Items`, `useThreadListItem`, `useAuiState` (for active thread title)
- Produces: ChatGPT-style two-column layout (sidebar + thread area) with sidebar collapse toggle, "+ New chat" button, thread list

- [ ] **Step 1: Read the current `CopilotPanelSurface.tsx`**

Note the existing expanded/minimized modes (`view === "minimized"` / `"expanded"`), the `ThreadPrimitive.Root`, `ThreadPrimitive.Viewport`, `ComposerPrimitive`, the `useCopilotCancel` hook, and the `useTranslations` hook.

- [ ] **Step 2: Add the sidebar state**

In `CopilotPanelSurface`:

```ts
import { useState } from "react";
import { ThreadListPrimitive, ThreadListItemPrimitive } from "@assistant-ui/react";
import { PanelLeftClose, PanelLeftOpen, Plus, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";

// Inside CopilotPanelSurface:
const [sidebarOpen, setSidebarOpen] = useState(true);  // mobile + collapse
const activeThreadTitle = useAuiState((s) => s.threadList.activeRemoteId);
```

(If `useAuiState` selector shape differs, verify the path against `node_modules/@assistant-ui/react/dist/`.)

- [ ] **Step 3: Add a custom `CopilotThreadListItem` component (above `CopilotPanelSurface`)**

```tsx
function CopilotThreadListItem() {
  const item = useThreadListItem();
  return (
    <div
      className={cn(
        "group mx-2 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-gray-100",
        item.isSelected && "bg-gray-100",
      )}
      onClick={() => item.switchTo()}
    >
      <MessageSquare className="h-4 w-4 flex-shrink-0 text-gray-500" />
      <span className="flex-1 truncate">{item.title ?? "New chat"}</span>
      {item.isSelected && (
        <div className="hidden gap-1 group-hover:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const next = window.prompt("Rename conversation", item.title ?? "New chat");
              if (next != null && next.trim()) item.rename(next.trim());
            }}
            className="rounded p-1 hover:bg-gray-200"
            aria-label="Rename"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm("Delete this conversation? This cannot be undone.")) {
                item.delete();
              }
            }}
            className="rounded p-1 hover:bg-red-100 hover:text-red-600"
            aria-label="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace the JSX inside `CopilotPanelSurface` with the new layout**

Keep the existing `view === "closed"` and `view === "minimized"` modes. Replace the `view === "expanded"` mode with the sidebar layout:

```tsx
return (
  <CopilotRuntimeProvider>
    <AnimatePresence mode="wait" initial={false}>
      {view === "minimized" && (
        <motion.div key="min" /* ... unchanged ... */>
          <MinimizedComposer />
        </motion.div>
      )}
      {view === "expanded" && (
        <motion.div
          key="exp"
          /* unchanged animation props */
          className="fixed inset-0 flex bg-white"
          dir="auto"
        >
          <aside
            className={cn(
              "flex w-[280px] flex-shrink-0 flex-col border-r bg-white transition-transform duration-300 ease-in-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full w-0 border-0 overflow-hidden",
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b px-3 py-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Copilot</span>
              </div>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="rounded p-1 hover:bg-gray-100"
                aria-label="Hide sidebar"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>

            {/* New chat button */}
            <div className="border-b px-3 py-2">
              <ThreadListPrimitive.New>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                >
                  <Plus className="h-4 w-4" /> New chat
                </button>
              </ThreadListPrimitive.New>
            </div>

            {/* Thread list */}
            <ThreadListPrimitive.Items
              components={{ ThreadListItem: CopilotThreadListItem }}
              className="flex-1 overflow-y-auto py-2"
            />
          </aside>

          {/* Right thread area */}
          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2">
                {!sidebarOpen && (
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="rounded p-1 hover:bg-gray-100"
                    aria-label="Show sidebar"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </button>
                )}
                <h2 className="text-base font-semibold">{activeThreadTitle ?? "New chat"}</h2>
              </div>
              <button type="button" onClick={close} aria-label={t("close")} className="wk-icon-button">
                <X className="h-4 w-4" />
              </button>
            </header>

            <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
              <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                {/* ... existing messages rendering ... */}
              </ThreadPrimitive.Viewport>
              <ExpandedComposer />
            </ThreadPrimitive.Root>
          </main>
        </motion.div>
      )}
    </AnimatePresence>
  </CopilotRuntimeProvider>
);
```

- [ ] **Step 5: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Run `npx eslint --quiet`**

Run: `cd app && npx eslint --quiet`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd app && git add src/components/user/copilot/overlay/CopilotPanelSurface.tsx
git commit -m "feat(copilot): ChatGPT-style sidebar layout with thread list

- Left sidebar (280px, framer-motion animated collapse) with:
  - Header (logo + hide-sidebar button)
  - '+ New chat' button via ThreadListPrimitive.New
  - ThreadListPrimitive.Items rendering custom CopilotThreadListItem
    that shows title + active highlight + hover-revealed rename/delete
- Right pane shows the active thread (header with title + close,
  ThreadPrimitive.Root with viewport + composer)
- Mobile-friendly: sidebar slides in/out, collapses to 0px
- Click outside or any thread action switches via useThreadListItem
- useAuiState reads activeThreadTitle for the header"
```

---

## Task 4: Frontend validation gate

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
1. Open copilot → sidebar shows with a "New chat" + the existing primary conversation
2. Click "+ New chat" → new conversation appears in sidebar, right pane clears, composer active
3. Send a message in the new chat → message appears, title auto-set to first 50 chars of user text
4. Click an older conversation in sidebar → messages load, title persists
5. Hover over a thread in sidebar → rename + delete buttons appear
6. Click rename → title updates in sidebar + header
7. Click delete → confirm prompt → thread disappears from sidebar
8. Reload page → all threads persist, active thread restored
9. Mobile (resize to narrow): sidebar starts collapsed, header button reveals it
10. Send message in wrong thread → no cross-contamination

- [ ] **Step 5: Fix any issues surfaced**

If validation surfaces bugs, fix them in commits.

---

## Self-review checklist

1. **Spec coverage:**
   - Schema (title) → Backend plan Task 1 (already in the other plan)
   - Store helpers → Backend plan Task 2
   - Controllers + routes → Backend plan Task 3
   - Auto-title → Backend plan Task 4
   - API client methods → Frontend Task 1
   - Runtime wiring → Frontend Task 2
   - Sidebar layout → Frontend Task 3
   - Validation → Frontend Task 4
2. **Placeholder scan:** no "TBD"/"TODO" in steps.
3. **Type consistency:** `useRemoteThreadListRuntime`, `ExternalStoreThreadListAdapter`, `ThreadListPrimitive.New`, `ThreadListPrimitive.Items`, `useThreadListItem`, `useAuiState` — same names throughout.
4. **Commit boundaries:** each task produces a single, reviewable commit.
