# Copilot follow-ups (post PR-1/PR-2)

These are known limitations from the initial PR-1 + PR-2 work. Each needs a fresh design pass before implementation.

## 1. True backend cancel (currently local-only)

**Today:** `Stop` button in the copilot overlay calls `store.onCancel`, which clears the local streaming state. The backend LangGraph keeps running until completion. After `Stop`, the user sees no more updates, but the server still does work (and emits via socket, which we ignore).

**Why it matters:** Wasted compute on aborted runs, billing impact (if quota'd), and the in-flight graph occupies a thread slot.

**Rough shape:**
- New endpoint `POST /copilot/messages/:id/cancel` (or similar)
- Backend stores the active run ID per conversation; `cancel` looks it up and calls `graph.abort()` (or LangGraph's interrupt mechanism)
- Frontend `onCancel` calls the new endpoint THEN clears local state
- Server returns 200 if the cancel succeeded; the persisted assistant message is marked as truncated or not created at all
- Needs to handle: no active run (404), run already finished (200, no-op)

**Open question:** Should cancel remove the in-progress assistant message from the persistence layer, or keep it as a truncated artifact? I'd say **keep it truncated** — matches the existing `truncated: true` semantics.

## 2. True regenerate (currently appends a duplicate)

**Today:** `Reload` button in the action bar re-sends the parent user message via `copilotService.postMessage()`. This creates a new turn in the thread — the original assistant response stays.

**Why it matters:** Users expect "regenerate" to replace the original response, not add a duplicate.

**Rough shape:**
- New endpoint `POST /copilot/messages/:userMsgId/regenerate` (takes the parent user message ID, regenerates the assistant response)
- Backend deletes all messages after (and including) the original assistant response, then runs the graph
- Returns the new assistant message + `truncated` flag
- Frontend `onReload` calls the new endpoint; React Query invalidates → real messages appear

**Open question:** Should regenerate preserve tool calls / conversation context? I'd say **yes** — same parent, same context, just a fresh assistant response.

## 3. Feedback submission (currently no-op)

**Today:** 👍 / 👎 buttons in the action bar render but do nothing.

**Why it matters:** Without feedback, you can't measure response quality. Without storage, you can't tune the prompt.

**Rough shape:**
- New DB table `copilot_feedback` (id, message_id, user_id, type ('positive'|'negative'), created_at)
- New endpoint `POST /copilot/messages/:id/feedback` with body `{ type: 'positive' | 'negative' }`
- Frontend `ActionBarPrimitive.FeedbackPositive/Negative` already calls the runtime's feedback callback; we wire it up via a `FeedbackAdapter` (assistant-ui's pluggable interface)
- Add UI to view feedback stats in the dashboard later

## 4. GFM markdown (currently basic markdown only)

**Today:** `MarkdownTextPrimitive` renders basic markdown: bold, italic, lists, links, code. Tables / strikethrough / task lists aren't supported.

**Why it matters:** The LLM sometimes emits tables (e.g., for tool comparisons) and they render as raw pipes.

**Rough shape:**
- Add `remark-gfm` to `app/`
- Pass `remarkPlugins={[remarkGfm]}` to `MarkdownTextPrimitive` in `CopilotPanelSurface.tsx`
- Add CSS for `.table` inside `MarkdownTextPrimitive` (Tailwind Typography plugin would be the cleanest, but a few hand-rolled classes work too)

## Where to start

I'd recommend starting with **#1 (true backend cancel)** — it's the most user-visible (Stop button currently doesn't really stop), it's well-bounded (new endpoint + abort mechanism), and it's a prerequisite for thinking about timeouts (which we don't have).

**#2 (regenerate)** is a close second — same shape (new endpoint + service method), but touches the persistence layer more.

**#3 (feedback)** is infrastructure work — needs a DB migration and the `FeedbackAdapter` wiring. Lower priority unless you want to start measuring.

**#4 (GFM)** is a tiny frontend-only change. Could be a quick PR between the others.

## Spec / plan / reports

All the design and per-task reports from the original work are in:
- `docs/superpowers/specs/2026-08-23-copilot-recursion-levelup-design.md` (the spec)
- `docs/superpowers/plans/2026-08-23-copilot-recursion-levelup.md` (the plan)
- `.superpowers/sdd/2026-08-23-copilot-recursion-levelup/` (SDD ledger + 17 task reports — note: this workspace was deleted when the session was compacted)

If those workspaces are gone in your fresh session, the most important context is: PR-1 is on `back-end/main` (10 commits), PR-2 is on `app/main` (9 commits), both ready to deploy once the follow-ups land.
