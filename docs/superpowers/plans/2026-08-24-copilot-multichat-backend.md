# Copilot Multi-Chat Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend support for ChatGPT-style multi-chat — list/create/rename/delete conversations, schema migration for title, auto-title on first response.

**Architecture:** 4 new REST endpoints (`GET`/`POST`/`PATCH`/`DELETE` `/v1/copilot/conversations`) plus a Prisma schema migration to add a nullable `title` column to `CopilotConversation`. Auto-title hook fires after the first assistant response in a conversation.

**Tech Stack:** Node.js, TypeScript, Express, Prisma, vitest.

## Global Constraints

- No new dependencies.
- Backend test framework: vitest.
- Single-conversation users (existing) must keep working — the existing `POST /copilot/messages` accepts an optional `conversationId` and the existing route returns 200 regardless. The new endpoints are purely additive.
- `userId` for ownership checks is derived from `req.user.id` (authenticated user), never from request body.
- DELETE cascades to `copilot_messages` for the conversation (via Prisma transaction).
- Title auto-set on FIRST assistant response per conversation (skip if title already set). Fire-and-forget — don't block the assistant response.
- Title capped at 200 chars to prevent abuse.
- All new routes follow the codebase `{ data: ... }` / `{ error: ... }` envelope convention.

---

## File Structure

**Backend (modified):**
- `back-end/prisma/schema.prisma` — add `title String?` to `CopilotConversation`
- `back-end/src/modules/copilot/copilot.store.ts` — add `listConversationsForUser`, `createConversation`, `updateConversationTitle`, `deleteConversation`
- `back-end/src/modules/copilot/copilot.controller.ts` — add 4 new controllers
- `back-end/src/modules/copilot/copilot.routes.ts` — add 4 new routes
- `back-end/src/modules/copilot/copilot.controller.test.ts` — add tests
- `back-end/src/modules/copilot/copilot.service.ts` — add auto-title hook in `runCopilotTurnInBackground` and `runCopilotRegenerateBackground`
- `back-end/src/modules/copilot/copilot.service.test.ts` — add auto-title tests

---

## Task 1: Schema migration — add `title` to `CopilotConversation`

**Files:**
- Modify: `back-end/prisma/schema.prisma`

**Interfaces:**
- Consumes: existing `CopilotConversation` model
- Produces: `CopilotConversation.title String?` (nullable)

- [ ] **Step 1: Read current `CopilotConversation` model**

Read `back-end/prisma/schema.prisma` and locate the `model CopilotConversation { ... }` block. Note the existing fields.

- [ ] **Step 2: Add the `title` field**

Add this line inside the `model CopilotConversation { ... }` block (place it near the other nullable fields, e.g. after `onboardingStep String?`):

```prisma
  title          String?
```

- [ ] **Step 3: Run the migration**

Run: `cd back-end && npx prisma migrate dev --name add_conversation_title`
Expected: migration file created in `prisma/migrations/`; Prisma client regenerated.

- [ ] **Step 4: Verify Prisma client types**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean (the regenerated Prisma client includes the `title` field on `CopilotConversation`).

- [ ] **Step 5: Commit**

```bash
cd back-end && git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(copilot): add title column to CopilotConversation

Nullable string for user-given or auto-generated conversation titles.
Used by the upcoming multi-chat feature to show 'New chat' or a
short summary of the first user message in the thread list."
```

---

## Task 2: Add store helpers for conversations

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.store.ts`
- Test: existing test patterns (covered in Task 4 via controller tests)

**Interfaces:**
- Consumes: existing Prisma client + existing `getCopilotConversationForUser` pattern
- Produces: 4 new exported helpers for list/create/rename/delete

- [ ] **Step 1: Read the existing store**

Read `back-end/src/modules/copilot/copilot.store.ts`. Note the existing `getCopilotConversationForUser`, `getOrCreateCopilotConversation`, and other helpers — follow the same patterns (Prisma + ownership scoping).

- [ ] **Step 2: Add `listConversationsForUser`**

Add to `copilot.store.ts`:

```ts
export async function listConversationsForUser(userId: number): Promise<CopilotConversation[]> {
  return prisma.copilotConversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
  });
}
```

- [ ] **Step 3: Add `createConversation`**

```ts
export async function createConversation(userId: number, locale: string): Promise<CopilotConversation> {
  return prisma.copilotConversation.create({
    data: { userId, locale, kind: "GENERAL" },  // title defaults to null → "New chat" in UI
  });
}
```

- [ ] **Step 4: Add `updateConversationTitle`**

```ts
export async function updateConversationTitle(
  conversationId: number,
  userId: number,
  title: string,
): Promise<void> {
  // Verify ownership first (defense in depth — controller also checks)
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
```

- [ ] **Step 5: Add `deleteConversation`**

```ts
export async function deleteConversation(conversationId: number, userId: number): Promise<void> {
  // Transaction: verify ownership + cascade delete messages + delete conversation
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

- [ ] **Step 6: Verify imports**

Verify `AppError` is already imported in `copilot.store.ts`. If not, add:

```ts
import { AppError } from "@middlewares/errorHandler.middleware";
```

- [ ] **Step 7: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd back-end && git add src/modules/copilot/copilot.store.ts
git commit -m "feat(copilot): add conversation list/create/rename/delete helpers

- listConversationsForUser: returns user's conversations sorted
  by lastMessageAt DESC (most recent first)
- createConversation: minimal — userId + locale + kind=GENERAL;
  title defaults to null
- updateConversationTitle: ownership-checked, title capped at 200 chars
- deleteConversation: ownership-checked + transactional cascade
  delete of messages + conversation"
```

---

## Task 3: Add controllers + routes

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.controller.ts`
- Modify: `back-end/src/modules/copilot/copilot.routes.ts`
- Modify: `back-end/src/modules/copilot/copilot.controller.test.ts`

**Interfaces:**
- Consumes: 4 new store helpers from Task 2
- Produces: 4 new exported controllers + 4 new routes

- [ ] **Step 1: Read existing controllers + routes**

Read `copilot.controller.ts` (note `getCopilotConversationController`, `listCopilotMessagesController`, `postCopilotMessageController` patterns) and `copilot.routes.ts` (note how routes are registered — likely via a router object).

- [ ] **Step 2: Update the existing test mock factory**

In `copilot.controller.test.ts`, extend the `vi.mock("./copilot.service", ...)` factory. (NOTE: per the existing pattern, store helpers are likely mocked via `./copilot.store`. Check what's already mocked and add the 4 new helpers.)

- [ ] **Step 3: Write the 4 controller tests**

Add to `copilot.controller.test.ts`:

```ts
describe("listConversationsController", () => {
  it("returns 200 with the user's conversations", async () => {
    const { listConversationsForUser } = await import("./copilot.store");
    (listConversationsForUser as any).mockResolvedValueOnce([
      { id: 1, userId: 5, kind: "GENERAL", locale: "ar", title: "Chat 1", lastMessageAt: new Date() },
      { id: 2, userId: 5, kind: "GENERAL", locale: "ar", title: null, lastMessageAt: new Date() },
    ]);
    const req: any = { user: { id: 5 }, headers: {} };
    const response = makeRes();
    await listConversationsController(req, response);
    expect(listConversationsForUser).toHaveBeenCalledWith(5);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 1, title: "Chat 1" }),
        expect.objectContaining({ id: 2, title: null }),
      ]),
    });
  });
});

describe("createConversationController", () => {
  it("returns 200 with { id, conversationId } on success", async () => {
    const { createConversation } = await import("./copilot.store");
    (createConversation as any).mockResolvedValueOnce({
      id: 42, userId: 5, kind: "GENERAL", locale: "en", title: null, lastMessageAt: new Date(),
    });
    const req: any = { user: { id: 5 }, headers: {} };
    const response = makeRes();
    await createConversationController(req, response);
    expect(createConversation).toHaveBeenCalledWith(5, "en");
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ data: { id: 42, conversationId: 42 } });
  });
});

describe("updateConversationTitleController", () => {
  it("returns 200 on successful rename", async () => {
    const { updateConversationTitle } = await import("./copilot.store");
    (updateConversationTitle as any).mockResolvedValueOnce(undefined);
    const req: any = { user: { id: 5 }, params: { id: "42" }, body: { title: "New name" }, headers: {} };
    const response = makeRes();
    await updateConversationTitleController(req, response);
    expect(updateConversationTitle).toHaveBeenCalledWith(42, 5, "New name");
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it("returns 404 when conversation not found", async () => {
    const { updateConversationTitle } = await import("./copilot.store");
    (updateConversationTitle as any).mockRejectedValueOnce(new AppError("conversation not found", 404, false));
    const req: any = { user: { id: 5 }, params: { id: "99" }, body: { title: "x" }, headers: {} };
    const response = makeRes();
    await updateConversationTitleController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
  });
});

describe("deleteConversationController", () => {
  it("returns 204 on successful delete", async () => {
    const { deleteConversation } = await import("./copilot.store");
    (deleteConversation as any).mockResolvedValueOnce(undefined);
    const req: any = { user: { id: 5 }, params: { id: "42" }, headers: {} };
    const response = makeRes();
    await deleteConversationController(req, response);
    expect(deleteConversation).toHaveBeenCalledWith(42, 5);
    expect(response.status).toHaveBeenCalledWith(204);
  });

  it("returns 404 when conversation not found", async () => {
    const { deleteConversation } = await import("./copilot.store");
    (deleteConversation as any).mockRejectedValueOnce(new AppError("conversation not found", 404, false));
    const req: any = { user: { id: 5 }, params: { id: "99" }, headers: {} };
    const response = makeRes();
    await deleteConversationController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd back-end && npx vitest run copilot.controller.test.ts -t "listConversationsController"`
Expected: FAIL with "listConversationsController is not exported".

- [ ] **Step 5: Add the 4 controllers to `copilot.controller.ts`**

```ts
import {
  // ... existing imports ...
  listConversationsForUser,
  createConversation,
  updateConversationTitle,
  deleteConversation,
} from "./copilot.store";

export const listConversationsController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const conversations = await listConversationsForUser(userId);
  res.status(200).json({ data: conversations });
};

export const createConversationController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const locale = detectLocale(req);
  const conv = await createConversation(userId, locale);
  res.status(200).json({ data: { id: conv.id, conversationId: conv.id } });
};

export const updateConversationTitleController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const id = Number((req as any).params.id);
  const title = String((req as any).body?.title ?? "");
  try {
    await updateConversationTitle(id, userId, title);
    res.status(200).json({ data: { id } });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    const message = err?.message ?? "Conversation not found";
    res.status(status).json({ error: { message } });
  }
};

export const deleteConversationController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const id = Number((req as any).params.id);
  try {
    await deleteConversation(id, userId);
    res.status(204).end();
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    const message = err?.message ?? "Conversation not found";
    res.status(status).json({ error: { message } });
  }
};
```

- [ ] **Step 6: Wire the 4 routes in `copilot.routes.ts`**

Add (place near the existing message routes):

```ts
router.get("/conversations", listConversationsController);
router.post("/conversations", createConversationController);
router.patch("/conversations/:id", updateConversationTitleController);
router.delete("/conversations/:id", deleteConversationController);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd back-end && npx vitest run copilot.controller.test.ts`
Expected: all tests pass.

- [ ] **Step 8: Run `npx tsc --noEmit`**

Run: `cd back-end && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
cd back-end && git add src/modules/copilot/copilot.controller.ts src/modules/copilot/copilot.routes.ts src/modules/copilot/copilot.controller.test.ts
git commit -m "feat(copilot): add conversation list/create/rename/delete endpoints

Routes:
- GET    /v1/copilot/conversations        -> 200 with user's conversations
- POST   /v1/copilot/conversations        -> 200 { data: { id, conversationId } }
- PATCH  /v1/copilot/conversations/:id    -> 200 (404 if not user's)
- DELETE /v1/copilot/conversations/:id    -> 204 (404 if not user's, cascade
                                              deletes messages via transaction)

All controllers derive userId from req.user.id (never request body)
and ownership-check via the store helpers. Resets userId is always
from req.user.id even for create (where user provides their own
locale)."
```

---

## Task 4: Add auto-title hook in service

**Files:**
- Modify: `back-end/src/modules/copilot/copilot.service.ts`
- Modify: `back-end/src/modules/copilot/copilot.service.test.ts`

**Interfaces:**
- Consumes: `updateConversationTitle` (from Task 2), existing background runners
- Produces: auto-title behavior on first assistant response

- [ ] **Step 1: Read existing service tests**

Read `back-end/src/modules/copilot/copilot.service.test.ts`. Note the existing mock factory and the test pattern for `runCopilotTurnInBackground`.

- [ ] **Step 2: Update the mock factory**

Add `updateConversationTitle` to the existing `vi.mock("./copilot.store", ...)` factory in `copilot.service.test.ts`.

- [ ] **Step 3: Write failing tests**

Add to the `describe("runCopilotTurnInBackground", ...)` block (or appropriate sibling block):

```ts
it("auto-titles the conversation after the first assistant response when title is null", async () => {
  // ... setup the run, assert updateConversationTitle is called with the first user message's first 50 chars
});

it("does not auto-title when the conversation already has a title", async () => {
  // ... setup the run with a parent.title already set, assert updateConversationTitle is NOT called
});
```

(Adjust the test setup to match the existing patterns in `copilot.service.test.ts`.)

- [ ] **Step 4: Run tests to verify they fail**

Expected: FAIL with the new assertions not met (because the auto-title hook doesn't exist yet).

- [ ] **Step 5: Implement auto-title in `runCopilotTurnInBackground` and `runCopilotRegenerateBackground`**

In `copilot.service.ts`, add the import:

```ts
import { ..., updateConversationTitle, listCopilotMessages, ... } from "./copilot.store";
```

Then, in both `runCopilotTurnInBackground` and `runCopilotRegenerateBackground`, AFTER `appendCopilotMessage` (the persist-assistant call), add:

```ts
// Auto-title: set a short summary from the first user message on first assistant response.
// Fire-and-forget — don't block the response.
if (!parent.title) {
  void (async () => {
    try {
      const recent = await listCopilotMessages(parent.conversationId, 50);
      const firstUser = recent.find((m) => m.role === "USER");
      if (firstUser && (firstUser.envelope as any)?.type === "text") {
        const fullText = (firstUser.envelope as any).text as string;
        const truncated = fullText.length > 50 ? `${fullText.slice(0, 50)}…` : fullText;
        await updateConversationTitle(parent.conversationId, params.userId, truncated);
      }
    } catch {
      // ignore — auto-title is best-effort
    }
  })();
}
```

Note: the `parent` parameter for `runCopilotTurnInBackground` is constructed inside the service (not passed as a parameter — let me check the actual signature). If the existing code constructs `parent` from the first user message in `listCopilotMessages`, use that. If not, look up the first user message similarly.

- [ ] **Step 6: Run the tests to verify they pass**

Expected: 2/2 new tests pass.

- [ ] **Step 7: Run full test suite**

Run: `cd back-end && npx vitest run`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
cd back-end && git add src/modules/copilot/copilot.service.ts src/modules/copilot/copilot.service.test.ts
git commit -m "feat(copilot): auto-title conversation on first assistant response

After the first ASSISTANT message in a conversation with no existing
title, fire-and-forget a title update with the first user message's
first 50 chars (with ellipsis if truncated). Best-effort — failures
don't block the response."
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

- [ ] **Step 4: Manual smoke test**

With the backend running (`npm run dev`), use `curl` or a REST client to verify:

```bash
# List conversations
curl http://localhost:PORT/v1/copilot/conversations -H "Authorization: Bearer $TOKEN"
# Expected: {"data":[{"id":1,"title":null,...}, ...]}

# Create a new conversation
curl -X POST http://localhost:PORT/v1/copilot/conversations -H "Authorization: Bearer $TOKEN"
# Expected: {"data":{"id":42,"conversationId":42}}

# Rename
curl -X PATCH http://localhost:PORT/v1/copilot/conversations/42 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"title":"My chat"}'
# Expected: {"data":{"id":42}}

# Delete
curl -X DELETE http://localhost:PORT/v1/copilot/conversations/42 -H "Authorization: Bearer $TOKEN"
# Expected: 204 No Content

# Send a message in the first conversation — verify auto-title kicks in
curl -X POST http://localhost:PORT/v1/copilot/messages -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"text":"Hello, what is the weather?"}'
# Then list conversations — verify title was auto-set
```

(Without a valid token, the request will 401 before reaching the controllers. Skip manual tests if you don't have a live token.)

- [ ] **Step 5: Fix any issues surfaced**

If validation surfaces bugs, fix them in commits.

---

## Self-review checklist

1. **Spec coverage:**
   - Schema (title column) → Task 1
   - Store helpers → Task 2
   - Controllers + routes → Task 3
   - Auto-title → Task 4
   - Validation → Task 5
2. **Placeholder scan:** no "TBD"/"TODO" in plan steps.
3. **Type consistency:** `CopilotConversation.title String?`, `listConversationsForUser`, `createConversation`, `updateConversationTitle`, `deleteConversation` — same names everywhere.
4. **Commit boundaries:** each task produces a single, reviewable commit.

After backend plan completes, proceed to the **Frontend Multi-Chat Plan** (`docs/superpowers/plans/2026-08-24-copilot-multichat-frontend.md`) to implement the UI side.
