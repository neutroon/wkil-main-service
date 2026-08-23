# wkil Copilot — Global Overlay UI Redesign

Date: 2026-08-23
Status: Ready for user review

Supersedes: `docs/superpowers/specs/2026-08-23-copilot-chat-design.md` §"Frontend components" and §"Rollout Phases" Phase 1 UI shape (those decisions stand; this spec redefines the **surface** the Phase1 UI lives on). The backend, data model, REST contract, sockets, and graph remain unchanged.

## Context

Phase1 shipped a dedicated `/user/copilot` page with a hand-rolled chat UI. In production, the UI shows several visual defects (header bleeding under the global notification panel, empty stat-grid rows with `—` placeholders, missing lead-list card, raw model output leaking into a `text` envelope), and the dedicated page forces owners to leave whatever they're doing to chat with the copilot. The owner wants the chat to be a persistent global surface — a bottom chat available on every authenticated page — with the ability to minimize (bottom composer strip) or expand (full focus) without losing the underlying page context.

This spec replaces the dedicated page + the hand-rolled chat primitives with a global bottom chat overlay driven by **CopilotKit**, fixes the five visible bugs, and removes the `/copilot` page + default-landing redirect that were added in Phase1.

## Goals

- A persistent chat overlay available on every owner dashboard page.
- Three visible states, one source of state: **closed** (floating button only) → **minimized** (bottom composer strip, page interactive) → **expanded** (full-screen chat with backdrop, body scroll-locked).
- Persistent across in-app navigation (layout-level mount).
- Backdrop blocks page pointer events + scroll when expanded; composer's draft text preserved when minimized.
- All five visual defects from the production screenshot eliminated.
- RTL preserved end-to-end (Arabic / Egyptian dialect).
- Drop-in third-party chat library, not a hand-rolled replacement (library-first principle).

## Non-goals

- Re-running the chat on a different page route (`/copilot` page is removed; chat is the overlay only).
- Multi-conversation history UI inside the overlay — Phase1 has one thread per user.
- Voice input / output.
- Mobile-app native overlay (Flutter) — same library-first audit later.
- Re-doing the backend, graph, REST, sockets, or data model (those are unchanged).
- Admin / manager dashboards: the overlay is owner-only.

## Product Decisions

| Decision | Choice |
|---|---|
| Chat surface | Global bottom chat overlay; no dedicated page |
| Owner-only | Mount in `(protected)/user/(dashboard)/layout.tsx` (not the top `(protected)` layout) |
| States | `closed` (FAB) / `minimized` (bottom strip) / `expanded` (full-screen with backdrop) |
| Trigger | Floating action button bottom-right + sidebar entry (toggles overlay) + `Esc` to close |
| Navigation persistence | Overlay state persists across in-app navigation (lives at layout level) |
| Session persistence | State resets on session end (no localStorage) |
| Underlying page | Backdrop + scroll-lock on `expanded`; page fully interactive on `minimized` and `closed` |
| Composer draft | Preserved across `minimized` ↔ `expanded` and navigation; lost on session end |
| Chat UI library | `@copilotkit/react-ui` v1.x |
| RTL | Library supports RTL natively; verify Arabic shaping on first render |
| Theming | Wired via CSS variables (`var(--wk-*)`) so the existing design tokens flow through |
| `/copilot` page | DELETED |
| Default user landing | Reverts to `/user/dashboard` (undoes Phase1's Task 14 default-landing) |
| Sidebar `copilot` entry | Becomes a toggle button (not a navigation link); still first entry |

## Architecture

```
src/app/[locale]/(protected)/user/(dashboard)/layout.tsx
 └─ InboxUIProvider (existing)
   └─ BaseDashboardLayout (existing; renders sidebar + page content area)
   └─ CopilotProvider (NEW — CopilotKit runtime, single CopilotKit context per session)
        └─ CopilotOverlayProvider (NEW — view state: closed / minimized / expanded)
        ├─ CopilotFab (NEW — floating button, fixed bottom-right, z-40)
        │       └─ onClick → CopilotOverlayProvider.toggleOpen()
        ├─ CopilotPanelBackdrop (NEW — rendered when view === "expanded", z-[55])
        └─ CopilotPanelSurface (NEW — three visual modes by view state, z-[60])
                └─ Header (minimize + close + conversation title)
                └─ Message stream (CopilotKit <Thread> + custom message parts)
                └─ Composer (CopilotKit <InputBar> wrapped for RTL/dialects)
```

**Mount point correction:** The `(protected)/layout.tsx` wraps admin, manager, and user routes. The overlay is owner-specific, so it mounts in `(protected)/user/(dashboard)/layout.tsx` only.

**Layered providers:** `CopilotProvider` (the library) is mounted once. `CopilotOverlayProvider` (our state) sits inside it. Order matters: the library must wrap the state so its hooks are available everywhere the overlay renders.

### State

`CopilotOverlayProvider` exposes via `useCopilotOverlay()`:

```ts
type OverlayView = "closed" | "minimized" | "expanded";

interface CopilotOverlayState {
  view: OverlayView;
  toggleOpen(): void;        // closed → expanded; minimized → expanded; expanded → minimized
  minimize(): void;          // any → minimized
  close(): void;             // any → closed
  expand(): void;            // closed/minimized → expanded
  composerDraft: string;     // persisted across minimize/expand/navigation; lost on session
  setComposerDraft(s: string): void;
}
```

`composerDraft` lives in the provider (not in the surface) so navigation between pages within the dashboard layout doesn't drop it.

### Data flow (happy path)

1. Owner lands on any `/user/...` page. Overlay renders `closed`. `CopilotFab` visible bottom-right.
2. Owner clicks FAB → `toggleOpen()` → `view = "expanded"`. Backdrop mounts; body scroll-locks.
3. Inside the overlay: CopilotKit's `<Thread>` reads from existing `useCopilotConversation()` (messages) and existing `useCopilotSocket()` (streaming deltas + final `copilot:message`). Same data path as Phase1, just under a different surface.
4. Owner types → `setComposerDraft(value)` (preserved across state changes).
5. Owner sends → existing `copilotService.postMessage(text)` + existing socket handlers. Composer clears.
6. Owner clicks minimize → `view = "minimized"`. Backdrop unmounts; bottom strip remains. Body scroll restored.
7. Owner clicks anywhere on the page (e.g. opens inbox item) → overlay stays `minimized`, draft preserved.
8. Owner navigates to `/user/customers` → overlay stays in `minimized` (layout doesn't unmount).
9. Owner clicks FAB, sidebar copilot entry, or presses `Esc` → expands (or closes from `expanded`).

### Files to create / modify

**Create:**
- `src/contexts/CopilotOverlayContext.tsx` — provider + `useCopilotOverlay()` hook.
- `src/components/user/copilot/overlay/CopilotFab.tsx` — floating button.
- `src/components/user/copilot/overlay/CopilotPanel.tsx` — backdrop + surface wrapper.
- `src/components/user/copilot/overlay/CopilotPanelSurface.tsx` — header + message area + composer.
- `src/components/user/copilot/overlay/parts/TextPart.tsx` — text envelope renderer (CopilotKit message part).
- `src/components/user/copilot/overlay/parts/StatGridPart.tsx`.
- `src/components/user/copilot/overlay/parts/LeadListPart.tsx`.
- `src/components/user/copilot/overlay/parts/ConversationListPart.tsx`.
- `src/components/user/copilot/overlay/parts/ProgressPart.tsx`.
- `src/components/user/copilot/overlay/parts/ErrorPart.tsx`.
- `src/components/user/copilot/overlay/parts/LinkCardPart.tsx`.
- `src/components/user/copilot/overlay/parts/index.ts` — registry mapping envelope type → renderer.
- `src/hooks/copilot/useCopilotOverlayShortcuts.ts` — `Esc` / `Cmd+B` (optional, gated to non-form focus).
- `src/lib/copilot-theme.ts` — CopilotKit theme tokens mapped to `var(--wk-*)`.

**Modify:**
- `src/app/[locale]/(protected)/user/(dashboard)/layout.tsx` — add `CopilotProvider` + `CopilotOverlayProvider` + render `CopilotFab` + `CopilotPanel`. Update userTranslations.navigation to remove the `copilot` link key (sidebar becomes a toggle, not a link — but the label string is reused for the sidebar button's accessible name).
- `src/components/shared/sidebar/UserSidebar.tsx` — change the copilot entry from `<Link href="/user/copilot">` to a `<button onClick={...toggleOpen()}>` (or a context-aware component that knows the active conversation state).
- `src/components/providers/HighResilienceProvider.tsx` — drop `copilot: string` from the navigation type (or keep it as a label-only string for the sidebar button).
- `src/app/[locale]/(protected)/user/page.tsx` — revert redirect target to `/user/dashboard`.
- `src/contexts/AuthContext.tsx` — `login` (default + `case "user"`) + `redirectAuthenticatedUser` → `/user/dashboard`.
- `src/lib/role-config.ts` — `getRedirectUrl` user → `/user/dashboard`.
- `src/components/shared/PublicAuthGuard.tsx` — keeps `getRedirectUrl` call (now points to dashboard).
- `package.json` — add `@copilotkit/react-core` and `@copilotkit/react-ui` (verify exact package + version during planning spike; lock to whatever is current stable as of 2026-08).
- `tailwind.config.ts` — register CopilotKit's plugin so its CSS-var theming integrates.
- `src/lib/config.ts` — add a `COPILOTKIT_API_URL` (or similar) only if the library needs an explicit backend URL for its own transport. We already drive transport ourselves via `useCopilotSocket` + `copilotService`; CopilotKit is UI-only. **No backend coupling for CopilotKit.**

**Delete:**
- `src/app/[locale]/(protected)/user/(dashboard)/copilot/page.tsx`
- `src/components/user/copilot/CopilotShell.tsx`
- `src/components/user/copilot/MessageStream.tsx`
- `src/components/user/copilot/MessageBubble.tsx`
- `src/components/user/copilot/Composer.tsx`
- `src/components/user/copilot/ThinkingIndicator.tsx`
- `src/components/user/copilot/QuickReplies.tsx`
- `src/components/user/copilot/cards/{StatGridCard,LeadListCard,ConversationListCard,ProgressCard,ErrorCard,LinkCard}.tsx`

**Kept (unchanged):**
- `src/lib/copilot-api.ts`
- `src/hooks/copilot/useCopilotConversation.ts`
- `src/hooks/copilot/useCopilotSocket.ts`
- `src/hooks/copilot/copilot.keys.ts`
- All backend code (no changes).

### i18n

Add new keys to `messages/en/copilot.json` + `messages/ar/copilot.json`:
- `overlay.fab.tooltip`: "Ask wkil" / "اسأل وكيل"
- `overlay.header.title`: "Copilot" / "وكيلك"
- `overlay.actions.minimize`: "Minimize" / "تصغير"
- `overlay.actions.close`: "Close" / "إغلاق"
- `overlay.composer.placeholder`: "Ask wkil anything about your business…" / "اسأل وكيل أي حاجة عن البيزنس بتاعك…"
- `overlay.emptyState.title`: "Start a conversation" / "ابدأ محادثة"
- `overlay.emptyState.subtitle`: "Ask anything about your business — stats, leads, or what needs your attention." / "اسأل أي حاجة عن البيزنس — أرقام، leads، ولا مين محتاج رد منك."
- (Existing card labels kept; `quickReplies.*` removed since the library handles its own suggestion UI.)

## Visual bugs to fix (bundled)

| # | Bug | Cause | Fix |
|---|---|---|---|
| 1 | Header text bleeds under sidebar / global notification panel | No explicit z-index on the shell; global Toaster + notification panel stack above it | Overlay surface at `z-[60]`, FAB at `z-40`, backdrop at `z-[55]`; only the FAB stays mounted when closed |
| 2 | Stat-grid items show `—` placeholders for `0` values | `Number(undefined ?? 0)` returns `0`, but a separate code path emits `"—"` as a default. Mixed defaults + zeros confuses users | Stat-grid part renders `value: number \| string`; format zero as `"0"`; only render `—` when the source field is `null`/`undefined` and not coercible to 0 |
| 3 | Lead-list card missing from the screenshot | The card UI exists but the mapper may not have been called for that tool — or the tool's payload shape wasn't handled | Audit every `copilotTools` entry against `envelopesForToolResult`'s switch; add explicit cases for any missing tool; add a runtime assertion that every tool name has a case (logs a warning otherwise) |
| 4 | Raw tool output card leaking into a `text` envelope | The model sometimes emits reasoning or markdown the mapper doesn't sanitize | The text envelope renderer strips leading "Thought:" / "Reasoning:" markers (LangChain exposes reasoning via `additional_kwargs`; if present we render a collapsible "show reasoning" toggle, not raw text) |
| 5 | Empty rows in stat card with `—` dividers | Stale implementation had a 4th row I dropped; the renderer still emitted empty `<div>`s | Stat-grid part iterates only over `items` and skips falsy entries; `key` on iteration; min-height only when items exist |

## Error handling

- CopilotKit transport failure: library's default error UI inside the message stream (no custom handling needed at our level).
- Socket disconnect mid-stream: same as Phase1 — REST response covers it via `useCopilotSocket` + React Query invalidation on REST return.
- Provider failure (graph error): same as Phase1 — error envelope persisted + emitted; rendered as `ErrorPart` with retry hint.
- Body scroll-lock: a `useEffect` toggles `document.body.style.overflow = "hidden"` when `view === "expanded"`, restores on cleanup. Verified on route change (Next.js doesn't auto-restore body styles on navigation).
- RTL: CopilotKit's UI primitives set `dir` from the root `<html dir>` attribute; the theme imports point at our CSS variables which already respect the locale.

## Testing

- **Backend unchanged:** no new tests needed (Phase1's 510/510 remain the gate).
- **Frontend: no test runner in this repo** (per Phase1 plan §Global Constraints). Verification = `npx tsc --noEmit` + `npm run lint` + manual QA against the QA script.
- **Manual QA script** (updated to reflect the overlay surface; lives in `back-end/docs/superpowers/plans/2026-08-23-copilot-chat-foundations-manual-qa.md`):
  1. Land on `/user/dashboard` → FAB visible bottom-right, no overlay open.
  2. Click FAB → overlay expands full-screen, backdrop blocks page, scroll-locked.
  3. Send "Show me my numbers" → stat-grid card with real values (no `—` for actual zeros).
  4. Ask "مين محتاج رد مني؟" in `/ar` → conversation-list card; full RTL.
  5. Click minimize → bottom strip remains, page interactive, scroll restored.
  6. Type in composer, navigate to `/user/customers` → overlay stays minimized, draft preserved.
  7. Navigate back to dashboard → expand via FAB → draft still there.
  8. Send the draft → message appears + assistant streams.
  9. Click sidebar `Copilot` entry → overlay toggles expand/minimize.
  10. Press `Esc` while expanded → closes; `Esc` from `minimized` does nothing (the page underneath may handle its own Esc semantics).
  11. Hit `/user/dashboard` directly → loads at dashboard, not at a stale overlay state (overlay state resets on hard navigation / page reload).
  12. Sign up a new owner → onboarding interview runs inside the overlay (the onboarding-mode graph + tools are unchanged; the overlay renders the same envelopes).
  13. Verify no `—` zeros, no raw tool-output cards, no overlapping header.
  14. Verify `/copilot` route returns 404 (deleted page).

## Implementation Principles

- **Library-first, always.** The chat UI (auto-scroll, typing indicators, message parts, composer) comes from `@copilotkit/react-ui`. We add only the parts unique to wkil (envelope-specific renderers, RTL pass-through, our design tokens via CSS vars).
- **Audit from-scratch code.** The hand-rolled `MessageStream` / `Composer` / `MessageBubble` etc. are deleted (not patched) — CopilotKit's primitives replace them. The envelope-rendering *parts* are new code but small and library-shaped (one file per envelope type, ~30 lines each).
- **One file, one responsibility.** Each envelope renderer is its own file; the overlay surface, the panel, the FAB, the backdrop are separate components.
- **No new env-driven configuration** beyond the CopilotKit package addition.

## Rollout

- Single ship (not phased) — the dedicated page is gone the moment the overlay ships; cannot coexist.
- Backend is untouched → no migration or re-deploy coordination beyond restarting the frontend.
- Feature flag optional: ship behind `NEXT_PUBLIC_COPILOT_OVERLAY_ENABLED=true` (default true) so the owner can disable if a regression hits prod.

## Out-of-scope follow-ups

- Multi-conversation history UI (only one thread per user in Phase1).
- Drag-to-resize the overlay between strip and full-screen.
- Voice input / output.
- Mobile-app native overlay (Flutter).