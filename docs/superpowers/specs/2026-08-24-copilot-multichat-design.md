# Copilot Multi-Chat (ChatGPT-Style) — Design

**Date:** 2026-08-24
**Status:** Approved (auto-approved per human partner instruction)
**Scope:** Backend + Frontend
**Author:** Brainstorming session

## Problem

The copilot overlay currently shows ONE conversation — auto-created on first use, never switchable. Users who ask multiple unrelated questions pile everything into a single thread, which makes the AI lose context, makes scroll-back painful, and prevents the kind of branching exploration ChatGPT/Claude users expect. They want a sidebar of conversations ("new chat" button + list + switch + delete + rename) just like ChatGPT.

## Goals

- Collapsible left sidebar with conversation list + "+ New chat" button + thread title + rename + delete
- Right pane shows the active thread (its messages + composer)
- Switching threads is instant; new messages go to the active thread
- Default conversation titles ("New chat"); auto-title from first message after first assistant response
- Library-first: use `assistant-ui@0.15.16`'s native `RemoteThreadList` runtime + `ExternalStoreThreadListAdapter` + `ThreadListPrimitive` family — no manual thread state management
- ChatGPT-quality UX: clean sidebar, smooth collapse animation, mobile-friendly

## Non-Goals

- Branching / alternate responses within a thread. That's a different feature.
- Sharing conversations publicly. Future enhancement.
- Conversation search. Future enhancement.
- Per-message file uploads, image generation, voice. Future enhancements.
- Dark mode.

---

## Architecture

```
┌─ Frontend (app/) ─────────────────┐  ┌─ Backend (back-end/) ──────────────┐
│                                  │  │                                    │
│ ┌──────────┐  ┌─────────────────┐ │  │ GET    /copilot/conversations      │
│ │  Sidebar │  │   Header         │ │  │   list conversations for user     │
│ │  [Logo]  │  ├─────────────────┤ │  │                                    │
│ │ [+ New ] │  │   Thread        │ │  │ POST   /copilot/conversations      │
│ │ ┌──────┐ │  │   Messages       │ │  │   create new conversation          │
│ │ │ Chat │ │  │                  │ │  │                                    │
│ │ │ Chat2│ │  │   [user]: hi   │ │  │ PATCH  /copilot/conversations/:id  │
│ │ │ ...  │ │  │   [ai]: hello  │ │  │   rename                            │
│ │ └──────┘ │  │                  │ │  │                                    │
│ │ [👤]    │  ├─────────────────┤ │  │ DELETE /copilot/conversations/:id  │
│ └──────────┘  │   Composer       │ │  │   delete + cascade messages         │
│               └─────────────────┘ │  │                                    │
│                                  │  │ Existing:                           │
│ useRemoteThreadListRuntime +     │  │   POST   /copilot/messages           │
│ ExternalStoreThreadListAdapter    │  │     (now accepts optional           │
│ (from @assistant-ui/react)       │──→│      conversationId)                │
│                                  │  │   GET    /copilot/conversation       │
│ ThreadListPrimitive.New           │  │   GET    /copilot/messages?limit=N   │
│ ThreadListPrimitive.Items         │  │                                    │
│ ThreadListItemPrimitive           │  │                                    │
└──────────────────────────────────┘  └────────────────────────────────────┘
```

---

## Backend changes

### Files touched

| File | Change |
|---|---|
| `back-end/prisma/schema.prisma` | Add `title String?` to `CopilotConversation` model |
| `back-end/src/modules/copilot/copilot.store.ts` | Add `listConversationsForUser`, `createConversation`, `updateConversationTitle`, `deleteConversation` (cascade messages) |
| `back-end/src/modules/copilot/copilot.controller.ts` | Add `listConversations`, `createConversation`, `updateConversationTitle`, `deleteConversation` controllers |
| `back-end/src/modules/copilot/copilot.routes.ts` | Add 4 new routes |
| `back-end/src/modules/copilot/copilot.controller.test.ts` | Test all 4 endpoints |

### Schema change (Prisma migration)

```prisma
model CopilotConversation {
  id             Int                 @id @default(autoincrement())
  userId         Int
  user           User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind           ConversationKind    @default(GENERAL)
  onboardingStep String?
  locale         String              @default("en")
  title          String?             // NEW — null = "New chat", set on first assistant response
  lastMessageAt  DateTime            @default(now())
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt
  messages       CopilotMessage[]

  @@index([userId])
}
```

Migration: `prisma migrate dev --name add_conversation_title`

### Routes

```
GET    /v1/copilot/conversations                  → 200 { data: CopilotConversation[] } (sorted by lastMessageAt DESC)
POST   /v1/copilot/conversations                  → 200 { data: { id, conversationId } }
                                                 → 200 { data: { id, conversationId } }
PATCH  /v1/copilot/conversations/:id              → 200 { data: { id } } (404 if not user's)
DELETE /v1/copilot/conversations/:id              → 204 No Content (cascade deletes messages)
```

### Service layer

```ts
// copilot.store.ts
export async function listConversationsForUser(userId: number): Promise<CopilotConversation[]> {
  return prisma.copilotConversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
  });
}

export async function createConversation(userId: number, locale: string): Promise<CopilotConversation> {
  return prisma.copilotConversation.create({
    data: { userId, locale, kind: "GENERAL" },  // title defaults to null
  });
}

export async function updateConversationTitle(
  conversationId: number, userId: number, title: string
): Promise<void> {
  // Verify ownership first (defense in depth)
  const conv = await prisma.copilotConversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!conv) throw new AppError("conversation not found", 404, false);
  await prisma.copilotConversation.update({
    where: { id: conversationId },
    data: { title: title.slice(0, 200) },  // cap to prevent abuse
  });
}

export async function deleteConversation(conversationId: number, userId: number): Promise<void> {
  // Transaction: verify ownership + delete messages + delete conversation
  await prisma.$transaction(async (tx) => {
    const conv = await tx.copilotConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!conv) throw new AppError("conversation not found", 404, false);
    await tx.copilotMessage.deleteMany({
      where: { conversationId },
    });
    await tx.copilotConversation.delete({
      where: { id: conversationId },
    });
  });
}
```

### Auto-title (post-first-response hook)

After the first assistant response in a conversation, fire-and-forget a title update:

```ts
// In runCopilotTurnInBackground, after persisting ASSISTANT message:
if (!parent.title) {
  const firstUserMsg = await listCopilotMessages(parent.conversationId, 50);
  const firstUser = firstUserMsg.find(m => m.role === "USER");
  if (firstUser?.envelope?.type === "text") {
    const text = firstUser.envelope.text.slice(0, 50);
    const title = text.length < firstUser.envelope.text.length ? `${text}...` : text;
    await updateConversationTitle(parent.conversationId, params.userId, title).catch(() => {});
  }
}
```

---

## Frontend changes

### Files touched

| File | Change |
|---|---|
| `app/src/lib/copilot-api.ts` | Add 4 methods: `listConversations()`, `createConversation()`, `renameConversation(id, title)`, `deleteConversation(id)`. Add optional `conversationId` to `postMessage` (already supported per cancel feature). |
| `app/src/hooks/copilot/useCopilotConversation.ts` | Restructure for multi-conversation via `useRemoteThreadListRuntime` |
| `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` | Use `useRemoteThreadListRuntime` + `ExternalStoreThreadListAdapter`. Adapt `onNew` to take optional `conversationId`. |
| `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` | Restructure layout: collapsible left sidebar (280px) + right thread area. Add `ThreadListPrimitive.New`, `ThreadListPrimitive.Items`, `ThreadListItemPrimitive`. Add sidebar collapse toggle. |

### External store adapter for thread list

```ts
// app/src/components/user/copilot/overlay/CopilotRuntime.tsx
import { useRemoteThreadListRuntime, type ExternalStoreThreadListAdapter } from "@assistant-ui/react";

const threadListAdapter: ExternalStoreThreadListAdapter<CopilotConversation> = {
  list: async () => {
    return copilotService.listConversations();
  },
  initialize: async () => {
    const initial = await copilotService.getCurrentConversation();
    return {
      remoteId: String(initial.id),
      externalId: undefined,
      title: initial.title ?? "New chat",
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
};

const threadListRuntime = useRemoteThreadListRuntime({
  adapter: threadListAdapter,
});
```

### Layout (ChatGPT-style)

```tsx
function CopilotPanelSurface() {
  const [sidebarOpen, setSidebarOpen] = useState(true);  // mobile + collapse

  return (
    <CopilotRuntimeProvider>
      <div className="flex h-full overflow-hidden">
        {/* Left sidebar */}
        <aside
          className={cn(
            "flex w-[280px] flex-shrink-0 flex-col border-r bg-white transition-transform duration-300 ease-in-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-full w-0 border-0"
          )}
        >
          {/* Logo header */}
          <div className="flex items-center justify-between border-b px-3 py-3">
            <div className="flex items-center gap-2">
              <Logo />
              <span className="font-semibold">Copilot</span>
            </div>
            <button onClick={() => setSidebarOpen(false)} className="rounded p-1 hover:bg-gray-100">
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          {/* New chat button */}
          <div className="border-b px-3 py-2">
            <ThreadListPrimitive.New>
              <button className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                <Plus className="h-4 w-4" /> New chat
              </button>
            </ThreadListPrimitive.New>
          </div>

          {/* Thread list */}
          <ThreadListPrimitive.Items components={{ ThreadListItem: CopilotThreadListItem }} className="flex-1 overflow-y-auto" />

          {/* User footer */}
          <UserFooter />
        </aside>

        {/* Right thread area */}
        <main className="flex flex-1 flex-col">
          {!sidebarOpen && (
            <button onClick={() => setSidebarOpen(true)} className="absolute left-2 top-2 z-10 rounded p-1 hover:bg-gray-100">
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          <ThreadHeader onClose={close} />
          <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
            <ThreadPrimitive.Viewport>...</ThreadPrimitive.Viewport>
            <Composer />
          </ThreadPrimitive.Root>
        </main>
      </div>
    </CopilotRuntimeProvider>
  );
}
```

### Custom ThreadListItem (ChatGPT-style)

```tsx
function CopilotThreadListItem() {
  const threadListItem = useThreadListItem();
  return (
    <div
      className={cn(
        "group mx-2 flex items-center gap-2 rounded-lg px-2 py-2 text-sm cursor-pointer hover:bg-gray-100",
        threadListItem.isSelected && "bg-gray-100"
      )}
      onClick={() => threadListItem.switchTo()}
    >
      <MessageSquare className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1 truncate">{threadListItem.title ?? "New chat"}</span>
      <div className="hidden gap-1 group-hover:flex">
        <button onClick={(e) => { e.stopPropagation(); threadListItem.rename("New title"); }}>
          <Pencil className="h-3 w-3" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); threadListItem.delete(); }}>
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
```

### Why these specific decisions

- **`ThreadListPrimitive.New`** — official `assistant-ui` primitive that calls our adapter's `create()` method. Replaces manual "+ New chat" button wiring.
- **`ThreadListPrimitive.Items`** with `components={{ ThreadListItem: CopilotThreadListItem }}` — we provide only the item UI, the library handles the list rendering.
- **`useThreadListItem()`** in the custom item gives us `switchTo()`, `rename()`, `delete()` — all wired to the adapter by the library. Zero manual thread state management.
- **`useRemoteThreadListRuntime`** wraps our adapter into the library's runtime. The library handles all subscription / optimistic update / cross-thread state coordination.
- **Auto-title on first response** is a backend hook (not a frontend concern) — the user sees the title update when the first assistant response arrives.

### Migration & sequencing

**Two separate PRs:**

1. **Backend PR** — schema + 4 endpoints + tests + auto-title hook
2. **Frontend PR** — API methods + CopilotRuntime rewrite + PanelSurface layout overhaul + ThreadListItem

Sequential (backend first). The existing single-conversation user keeps working because the existing routes still accept an optional `conversationId` (already do).

### Validation

**Backend:**
- tsc clean
- vitest covers all 4 new controllers + the auto-title hook
- prisma migrate runs

**Frontend:**
- tsc clean
- eslint clean
- next build succeeds
- Manual smoke test:
  - Create new thread via "+ New chat" → appears in sidebar
  - Click thread → messages load, composer active
  - Send message in thread A → only thread A updates
  - Create thread B → sidebar shows A + B
  - Delete thread B → sidebar updates
  - Rename thread A → title persists across reload
  - First message in thread A → title auto-updates
  - Refresh page → all threads persist, active thread restored

---

## Files touched

**Backend (new + modified):**
- `back-end/prisma/schema.prisma` (modified — add title)
- `back-end/src/modules/copilot/copilot.store.ts` (modified — 4 new helpers)
- `back-end/src/modules/copilot/copilot.controller.ts` (modified — 4 new controllers)
- `back-end/src/modules/copilot/copilot.routes.ts` (modified — 4 new routes)
- `back-end/src/modules/copilot/copilot.controller.test.ts` (modified — 4 new tests)

**Frontend (modified):**
- `app/src/lib/copilot-api.ts` (modified — 4 new methods)
- `app/src/hooks/copilot/useCopilotConversation.ts` (modified — multi-conversation support)
- `app/src/components/user/copilot/overlay/CopilotRuntime.tsx` (modified — useRemoteThreadListRuntime integration)
- `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` (modified — sidebar layout)

---

## Known limitations

1. **Conversation search** — not in scope. Future enhancement.
2. **Dark mode** — explicitly out of scope (matches existing limitation).
3. **Sharing conversations publicly** — not in scope.
4. **Per-thread custom instructions / system prompts** — all threads share the same copilot persona today. Future enhancement.
5. **Mobile UX** — sidebar slides in/out, but no special gestures yet.
6. **Conversation archive** (vs hard delete) — not in scope. Delete is permanent.
7. **Thread search + filters** — not in scope.

---

## Out of scope (deferred)

- Branching / alternate responses
- Code highlighting (Shiki/Prism)
- Voice input / speech output
- File uploads in chat composer (already a separate feature elsewhere in the app)
