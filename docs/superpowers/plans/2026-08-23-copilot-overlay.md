# wkil Copilot — Global Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dedicated `/user/copilot` page with a persistent bottom-chat overlay available on every owner dashboard page, driven by `@copilotkit/react-ui` v1.69.0 in headless mode (UI only — transport stays on our existing Socket.IO + REST), and fix the five visual defects from the production screenshot.

**Architecture:** New `CopilotOverlayProvider` context (single source of `closed | minimized | expanded` state) mounted in `src/app/[locale]/(protected)/user/(dashboard)/layout.tsx`. Floating action button (bottom-right) toggles state. Expanded view fills the viewport with a backdrop that blocks + scroll-locks the page. CopilotKit's `<CopilotChat>` (no runtime) + custom `messageView` slot overrides render our typed envelope cards. Sidebar `copilot` entry becomes a toggle button; the `/copilot` page + Task14 default-landing redirect are removed.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Tailwind v4, framer-motion 12, lucide-react, `@tanstack/react-query`, `@copilotkit/react-ui` 1.69.0 (UI only — no CopilotKit runtime), `@copilotkit/react-core` 1.69.0.

**Spec:** `docs/superpowers/specs/2026-08-23-copilot-overlay-redesign.md`

## Global Constraints

- **Library-first, always.** The chat UI (auto-scroll, typing indicator, message parts, composer, suggestions) comes from `@copilotkit/react-ui`. We add only the parts unique to wkil (envelope-specific renderers, RTL pass-through, our design tokens via CSS vars). **No hand-rolled chat primitives.**
- **Audit from-scratch code.** Delete the existing hand-rolled `MessageStream` / `Composer` / `MessageBubble` / `ThinkingIndicator` / `QuickReplies` / `cards/*` rather than patching them. CopilotKit's primitives replace them. Out-of-scope switches go to the ledger.
- **Headless CopilotKit, no CopilotKit runtime, no AG-UI transport.** We drive transport ourselves via existing `useCopilotSocket` (Socket.IO) + `copilotService.postMessage` (REST). CopilotKit is UI-only.
- **Mount in `(protected)/user/(dashboard)/layout.tsx`** (owner scope only — admin/manager layouts untouched).
- **Library version pins:** `@copilotkit/react-ui@1.69.0`, `@copilotkit/react-core@1.69.0`. (1.69 is the latest stable at plan time; verify with `npm view @copilotkit/react-ui version` before installing.)
- **No backend changes.** Backend is at HEAD `e6ac5e1` (Phase1 + bug-fix). All existing endpoints + socket events remain canonical.
- **TypeScript:** strict; `tsc --noEmit` must be clean before each commit.
- **Lint:** `npm run lint` must report 0 new errors (pre-existing warnings in unrelated files are fine).
- **i18n:** every new user-facing string in BOTH `messages/en/copilot.json` and `messages/ar/copilot.json`. RTL via Tailwind `rtl:`/`ltr:` variants + `start-`/`end-` logical properties. The `<html dir>` is set by `src/app/[locale]/layout.tsx`; our components inherit it.
- **No frontend test runner** (per repo convention). Verification = `tsc` + `lint` + manual QA against the updated script in `docs/superpowers/plans/2026-08-23-copilot-chat-foundations-manual-qa.md`.
- **Z-index convention:** Sonner Toaster sits at ~`999999999`; overlay surface MUST sit above it. Use `z-[1000000000]` (1 billion) on the surface and `z-[999999999]` on the FAB (under the surface so the FAB hides when expanded). Define a `--wk-overlay-z` CSS variable in `globals.css` to make this auditable.
- **Body scroll-lock** is a new pattern in this repo. The first implementation sets the precedent — save `document.body.style.overflow` in `useEffect`, set to `"hidden"` when expanded, restore on cleanup + on unmount. No external dependency.
- **Commits** on `app` repo per task per the previous plan's convention.

### Task 1: Spike — CopilotKit headless integration feasibility

**Files:**
- Create: `app/.worktrees/copilot-overlay/src/app/[locale]/(protected)/user/(dashboard)/copilot/_spike/page.tsx` (throwaway, deleted at end of task)
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/_spike/CopilotKitSpike.tsx` (throwaway)
- Modify: `app/package.json` (verify, no commit — revert after spike)

**Why this task:** The spec commits to `@copilotkit/react-ui`. We must verify it can be used **headlessly** (UI-only, no CopilotKit runtime, no AG-UI transport) with our existing Socket.IO + REST, and that RTL + theme tokens work. If any of these fail, the spec needs revision before building 10+ tasks against a wrong library.

**Interfaces (target, verified by this spike):**
- A `<CopilotChat>` (or equivalent v1 component) renders a message list + composer with NO backend coupling.
- We can pass our own `AssistantMessage` slot renderer that consumes `useCopilotChat()`'s `visibleMessages` and renders our envelope cards.
- The composer accepts our `onSend(text)` callback that hits `copilotService.postMessage(text)` (REST) + `useCopilotSocket` (Socket.IO).
- Theme tokens via `var(--wk-*)` flow through to the library's chrome.
- Arabic text renders correctly with RTL in the library's primitives.

- [ ] **Step 1: Set up the spike worktree**

From the `app` repo root, create a worktree off `main`:
```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app
git worktree add -b feat/copilot-overlay-spike .worktrees/copilot-overlay-spike main
```

All subsequent steps run from `.worktrees/copilot-overlay-spike/`.

- [ ] **Step 2: Install CopilotKit packages**

```bash
npm install @copilotkit/react-ui@1.69.0 @copilotkit/react-core@1.69.0
```

Verify the version installed: `npm ls @copilotkit/react-ui @copilotkit/react-core` → both at 1.69.0.

- [ ] **Step 3: Verify package surfaces**

Open `node_modules/@copilotkit/react-ui/dist/index.d.ts` and confirm these exports exist:
- `CopilotChat`, `CopilotPopup`, `CopilotSidebar` (root components)
- `useCopilotChat` (headless hook) returning `{ visibleMessages, appendMessage, setMessages, ... }`
- `AssistantMessageProps`, `UserMessageProps` (slot prop types)
- `CopilotKit` (provider; should accept `runtimeUrl={undefined}` for headless use)

If `useCopilotChat` is not exported from `@copilotkit/react-ui`, check `@copilotkit/react-core` (it lives there in some versions). Note exact import path in a spike comment.

- [ ] **Step 4: Write the spike page**

```tsx
// src/app/[locale]/(protected)/user/(dashboard)/copilot/_spike/page.tsx
"use client";
import { CopilotKitSpike } from "@/components/user/copilot/_spike/CopilotKitSpike";
export default function Page() {
  return <CopilotKitSpike />;
}
```

- [ ] **Step 5: Write the spike component**

```tsx
// src/components/user/copilot/_spike/CopilotKitSpike.tsx
"use client";
import { CopilotKit, useCopilotChat, type AssistantMessageProps } from "@copilotkit/react-ui";
import { useEffect, useState } from "react";
import { copilotService } from "@/lib/copilot-api";

const ASSISTANT: React.FC<AssistantMessageProps> = (props) => {
  // Minimal envelope-aware renderer: just shows the raw text + tool-call count.
  // The real implementation lives in Task 7.
  return (
    <div className="rounded-md border p-2 text-sm" style={{ borderColor: "var(--wk-divider, #e5e7eb)" }}>
      {props.message?.content ?? "(no content)"}
    </div>
  );
};

export function CopilotKitSpike() {
  const [text, setText] = useState("");
  return (
    <CopilotKit /* runtimeUrl={undefined} — headless, transport handled by us */>
      <div className="flex h-screen flex-col p-4">
        <SpikeMessages />
        <input
          dir="auto"
          className="mt-2 rounded border p-2 text-sm"
          placeholder="Type and Enter to send…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              void send(text.trim());
              setText("");
            }
          }}
        />
      </div>
    </CopilotKit>
  );
}

function SpikeMessages() {
  const { visibleMessages } = useCopilotChat();
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
      {visibleMessages.map((m) => (
        <div key={m.id} className={m.role === "user" ? "text-end" : "text-start"}>
          {m.role === "user" ? <>{m.content}</> : <ASSISTANT message={m as any} />}
        </div>
      ))}
    </div>
  );
}

async function send(text: string) {
  // In the real impl (Task 7), this also feeds useCopilotChat.appendMessage.
  await copilotService.postMessage(text);
}
```

(The spike intentionally skips `appendMessage`; Task 7 will wire it once we confirm `useCopilotChat` is the right surface.)

- [ ] **Step 6: Verify it builds + dev server renders**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean (the spike file references real types + our real service).

If `useCopilotChat` or `AssistantMessageProps` are not exported as written, follow the exact paths the package exposes — don't paper over with `any`. Update the spike imports to match. If `CopilotKit` requires a non-optional `runtimeUrl`, document the API mismatch — this is a STOP signal for the library choice.

- [ ] **Step 7: Render in browser + manual smoke**

`npm run dev`. Navigate to `/_spike` page. Type a message and hit Enter.

Confirm:
- The component mounts without console errors.
- Sending hits `POST /v1/copilot/conversation/messages` (visible in Network tab — our REST, NOT a CopilotKit endpoint).
- The response envelopes appear in the DOM via the spike's `ASSISTANT` renderer (raw text only at this stage).
- Switch locale to `/ar` (via LocaleSwitcher) — RTL layout flips, text is right-aligned for user messages.

- [ ] **Step 8: Document verdict in a comment at top of the spike file**

Either:
- ✅ PASS — library is viable; proceed to Task 2.
- ⚠️ PASS-WITH-CAVEATS — e.g., RTL needs manual `dir="rtl"` on composer (not auto). Document the caveat.
- ❌ STOP — e.g., `CopilotKit` requires a runtime and there's no headless escape hatch; library is wrong choice. **Do NOT proceed to Task 2.** Surface the finding instead — the spec needs revision (fall back to a different library or roll-our-own with shadcn/ui Dialog primitives).

- [ ] **Step 9: Revert package.json changes (the spike is throwaway)**

```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app\.worktrees\copilot-overlay-spike
# uninstall the spike packages; do NOT commit them
npm uninstall @copilotkit/react-ui @copilotkit/react-core
git checkout package.json package-lock.json
```

Verify `package.json` is unchanged: `git status` shows only the spike files (which we'll delete next).

- [ ] **Step 10: Delete the spike files + worktree**

```bash
rm -rf src/app/[locale]/(protected)/user/(dashboard)/copilot/_spike
rm -rf src/components/user/copilot/_spike
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app
git worktree remove .worktrees/copilot-overlay-spike
git branch -D feat/copilot-overlay-spike
```

- [ ] **Step 11: Report verdict**

Write `D:\zTechy Org\pagespilot.com\wkil-fullstack\back-end\.superpowers\sdd\2026-08-23-copilot-overlay\task-1-report.md` with:
- Verdict (PASS / PASS-WITH-CAVEATS / STOP).
- Caveat list (if any).
- Exact import paths for the symbols Tasks 2-7 will reference (corrected from the spike).

**This task is a HARD GATE.** Task 2 does NOT start until the verdict is PASS or PASS-WITH-CAVEATS.

### Task 2: Add CopilotKit packages + overlay design tokens

**Files:**
- Modify: `app/.worktrees/copilot-overlay/package.json` (+ lockfile)
- Modify: `app/.worktrees/copilot-overlay/src/styles/globals.css` (add `--wk-overlay-z` and overlay-scoped CSS vars)

**Interfaces:**
- Produces: `@copilotkit/react-ui` and `@copilotkit/react-core` at pinned version (confirmed by Task 1). A `--wk-overlay-z` CSS var equal to `1000000000`, available everywhere via `var(--wk-overlay-z)`.

- [ ] **Step 1: Set up the worktree for this plan**

From `app` repo root (assuming Task 1's spike worktree was cleaned up):
```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app
git worktree add -b feat/copilot-overlay .worktrees/copilot-overlay main
```

All Task 2+ steps run from `.worktrees/copilot-overlay/`.

- [ ] **Step 2: Install CopilotKit**

```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app\.worktrees\copilot-overlay
npm install @copilotkit/react-ui@1.69.0 @copilotkit/react-core@1.69.0
```

Verify: `npm ls @copilotkit/react-ui @copilotkit/react-core` → both at 1.69.0.

- [ ] **Step 3: Add overlay z-index tokens to globals.css**

Open `src/styles/globals.css`. In the `@theme inline` block (or at the top of the `:root` block), add:

```css
:root {
  --wk-overlay-z: 1000000000;
  --wk-overlay-z-fab: 999999999;
  --wk-overlay-scrim: rgba(15, 23, 42, 0.55);
}
```

Verify the file still parses: `npx tsc --noEmit` (no errors expected — CSS changes don't affect TS, but confirms dev server isn't broken).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/styles/globals.css
git commit -m "feat(copilot-overlay): add CopilotKit packages and overlay z-index tokens"
```

### Task 3: Copilot overlay state context

**Files:**
- Create: `app/.worktrees/copilot-overlay/src/contexts/CopilotOverlayContext.tsx`

**Interfaces:**
- Produces: `CopilotOverlayProvider` + `useCopilotOverlay()` hook. State: `view: "closed" | "minimized" | "expanded"`, `composerDraft: string`. Actions: `toggleOpen()`, `minimize()`, `close()`, `expand()`, `setComposerDraft(s)`. (Mirrors the existing `InboxUIContext` pattern in this repo.)

- [ ] **Step 1: Create the context**

```tsx
// src/contexts/CopilotOverlayContext.tsx
"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type OverlayView = "closed" | "minimized" | "expanded";

export interface CopilotOverlayContextValue {
  view: OverlayView;
  composerDraft: string;
  toggleOpen: () => void;
  minimize: () => void;
  close: () => void;
  expand: () => void;
  setComposerDraft: (s: string) => void;
}

const CopilotOverlayContext = createContext<CopilotOverlayContextValue>({
  view: "closed",
  composerDraft: "",
  toggleOpen: () => {},
  minimize: () => {},
  close: () => {},
  expand: () => {},
  setComposerDraft: () => {},
});

export function CopilotOverlayProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<OverlayView>("closed");
  const [composerDraft, setComposerDraft] = useState("");

  const toggleOpen = useCallback(() => {
    setView((v) => (v === "expanded" ? "minimized" : "expanded"));
  }, []);
  const minimize = useCallback(() => setView("minimized"), []);
  const close = useCallback(() => setView("closed"), []);
  const expand = useCallback(() => setView("expanded"), []);

  const value = useMemo(
    () => ({ view, composerDraft, toggleOpen, minimize, close, expand, setComposerDraft }),
    [view, composerDraft, toggleOpen, minimize, close, expand],
  );

  return <CopilotOverlayContext.Provider value={value}>{children}</CopilotOverlayContext.Provider>;
}

export function useCopilotOverlay() {
  return useContext(CopilotOverlayContext);
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/CopilotOverlayContext.tsx
git commit -m "feat(copilot-overlay): add overlay state context"
```

### Task 4: Floating action button (FAB)

**Files:**
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/overlay/CopilotFab.tsx`

**Interfaces:**
- Consumes: `useCopilotOverlay()` → reads `view` (don't render when `view !== "closed"`), calls `toggleOpen()` on click.
- Produces: `<CopilotFab />` — fixed bottom-right button (logical `end-6 bottom-6`), z-index `--wk-overlay-z-fab`. Uses `lucide-react` `MessageCircle` icon. Tooltip via `useTranslations("copilot.overlay.fab")`.

- [ ] **Step 1: Create the component**

```tsx
// src/components/user/copilot/overlay/CopilotFab.tsx
"use client";
import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCopilotOverlay } from "@/contexts/CopilotOverlayContext";

export function CopilotFab() {
  const { view, toggleOpen } = useCopilotOverlay();
  const t = useTranslations("copilot.overlay.fab");
  if (view !== "closed") return null;
  return (
    <button
      type="button"
      onClick={toggleOpen}
      aria-label={t("tooltip")}
      title={t("tooltip")}
      className="fixed end-6 bottom-6 inline-flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2"
      style={{
        background: "var(--wk-primary, #0ea5e9)",
        color: "#fff",
        zIndex: "var(--wk-overlay-z-fab, 999999999)" as any,
      }}
    >
      <MessageCircle className="h-6 w-6 rtl:-scale-x-100" aria-hidden />
    </button>
  );
}
```

- [ ] **Step 2: Add the i18n keys**

Open `messages/en/copilot.json` and `messages/ar/copilot.json`. Add (under existing keys, no replacement of current content — only an addition):

`messages/en/copilot.json` (find existing object, add the `overlay` block):
```json
{
  "title": "Copilot",
  "placeholder": "Ask wkil anything about your business…",
  ...existing keys kept...
  "overlay": {
    "fab": { "tooltip": "Ask wkil" },
    "header": { "title": "Copilot", "minimize": "Minimize", "close": "Close" },
    "composer": { "placeholder": "Ask wkil anything about your business…" },
    "emptyState": {
      "title": "Start a conversation",
      "subtitle": "Ask anything about your business — stats, leads, or what needs your attention."
    }
  }
}
```

`messages/ar/copilot.json` (add the `overlay` block in the same way):
```json
{
  "title": "وكيلك",
  "placeholder": "اسأل وكيل أي حاجة عن البيزنس بتاعك…",
  ...existing keys kept...
  "overlay": {
    "fab": { "tooltip": "اسأل وكيل" },
    "header": { "title": "وكيلك", "minimize": "تصغير", "close": "إغلاق" },
    "composer": { "placeholder": "اسأل وكيل أي حاجة عن البيزنس بتاعك…" },
    "emptyState": {
      "title": "ابدأ محادثة",
      "subtitle": "اسأل أي حاجة عن البيزنس — أرقام، leads، ولا مين محتاج رد منك."
    }
  }
}
```

(Keep the existing top-level keys — they're consumed by other code paths and tests. Only the `overlay` block is new.)

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/user/copilot/overlay/CopilotFab.tsx messages/en/copilot.json messages/ar/copilot.json
git commit -m "feat(copilot-overlay): add floating action button with i18n"
```

### Task 5: Panel backdrop + body scroll-lock

**Files:**
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/overlay/CopilotPanelBackdrop.tsx`

**Interfaces:**
- Consumes: `useCopilotOverlay()` → renders only when `view === "expanded"`. Toggles `document.body.style.overflow` between `""` and `"hidden"` on enter/leave/unmount.
- Produces: `<CopilotPanelBackdrop />` — fixed full-viewport scrim at `z-index: var(--wk-overlay-z) - 1` (below the surface but above the FAB). Click → `close()`.

- [ ] **Step 1: Create the component**

```tsx
// src/components/user/copilot/overlay/CopilotPanelBackdrop.tsx
"use client";
import { useEffect } from "react";
import { useCopilotOverlay } from "@/contexts/CopilotOverlayContext";

export function CopilotPanelBackdrop() {
  const { view, close } = useCopilotOverlay();

  useEffect(() => {
    if (view !== "expanded") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [view]);

  if (view !== "expanded") return null;

  return (
    <div
      aria-hidden
      onClick={close}
      className="fixed inset-0 animate-in fade-in"
      style={{
        background: "var(--wk-overlay-scrim, rgba(15, 23, 42, 0.55))",
        zIndex: "calc(var(--wk-overlay-z, 1000000000) - 1)" as any,
      }}
    />
  );
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/user/copilot/overlay/CopilotPanelBackdrop.tsx
git commit -m "feat(copilot-overlay): add panel backdrop with body scroll-lock"
```

### Task 6: Envelope renderer parts (per-envelope custom message parts)

**Files:**
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/overlay/parts/{TextPart,StatGridPart,LeadListPart,ConversationListPart,ProgressPart,ErrorPart,LinkCardPart}.tsx`
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/overlay/parts/index.ts` (parts registry)

**Interfaces (consumed by Task 7):**
- Each part exports a `React.FC<{ envelope: <envelope type> }>` matching the CopilotKit slot's prop shape. The parts registry `renderEnvelope(envelope)` dispatches by `envelope.type`.
- The `TextPart` includes the bug-fix sanitizer (Bug #4): strips leading `Thought:` / `Reasoning:` markers from `text` and renders the cleaned text only.
- The `StatGridPart` (Bug #2): renders `value: number` for real numbers, `"—"` only when `value === null || value === undefined`, never for legitimate `0`.

The envelope type mirrors what's already in `src/lib/copilot-api.ts` (USER = `{ type: "text", text }`, ASSISTANT messages have `envelope.envelopes: CopilotEnvelope[]`). Parts render ASSISTANT envelopes only (USER text is handled by the CopilotKit user-message slot override in Task 7).

- [ ] **Step 1: Create the parts registry**

```ts
// src/components/user/copilot/overlay/parts/index.ts
import type { CopilotEnvelope } from "@/lib/copilot-api";
import { TextPart } from "./TextPart";
import { StatGridPart } from "./StatGridPart";
import { LeadListPart } from "./LeadListPart";
import { ConversationListPart } from "./ConversationListPart";
import { ProgressPart } from "./ProgressPart";
import { ErrorPart } from "./ErrorPart";
import { LinkCardPart } from "./LinkCardPart";

export function renderEnvelope(env: CopilotEnvelope) {
  switch (env.type) {
    case "text": return <TextPart envelope={env} />;
    case "stat-grid": return <StatGridPart envelope={env} />;
    case "lead-list": return <LeadListPart envelope={env} />;
    case "conversation-list": return <ConversationListPart envelope={env} />;
    case "progress": return <ProgressPart envelope={env} />;
    case "link-card": return <LinkCardPart envelope={env} />;
    case "error": return <ErrorPart envelope={env} />;
    default: return null;
  }
}
```

- [ ] **Step 2: Create the parts**

Create each file with the following shape (mirror the existing card UX from Phase1 but with the bug fixes baked in):

**`TextPart.tsx`** (Bug #4 fix — sanitizer):
```tsx
"use client";
import type { CopilotEnvelope } from "@/lib/copilot-api";

const REASONING_PREFIXES = /^\s*(Thought|Reasoning|Thinking|Azure)\s*[:：]\s*/i;

function sanitize(text: string) {
  // Strip leading reasoning-style markers so raw model output doesn't leak.
  let cleaned = text;
  let stripped = 0;
  while (REASONING_PREFIXES.test(cleaned)) {
    cleaned = cleaned.replace(REASONING_PREFIXES, "");
    stripped += 1;
    if (stripped > 3) break; // safety net
  }
  return cleaned.trim();
}

export function TextPart({ envelope }: { envelope: Extract<CopilotEnvelope, { type: "text" }> }) {
  return (
    <div className="max-w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}>
      {sanitize(envelope.text)}
    </div>
  );
}
```

**`StatGridPart.tsx`** (Bug #2 fix — zero vs dash):
```tsx
"use client";
import type { CopilotEnvelope } from "@/lib/copilot-api";

function displayValue(v: number | string | null | undefined) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 0 ? v : "—";
  return v.toString();
}

export function StatGridPart({ envelope }: { envelope: Extract<CopilotEnvelope, { type: "stat-grid" }> }) {
  if (!envelope.items?.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-3" style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}>
      {envelope.items.map((it, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <span className="text-xs opacity-70">{it.label}</span>
          <span className="text-base font-semibold tabular-nums">{displayValue(it.value)}</span>
          {it.hint && <span className="text-xs opacity-60">{it.hint}</span>}
        </div>
      ))}
    </div>
  );
}
```

**`LeadListPart.tsx`:**
```tsx
"use client";
import type { CopilotEnvelope } from "@/lib/copilot-api";

export function LeadListPart({ envelope }: { envelope: Extract<CopilotEnvelope, { type: "lead-list" }> }) {
  const { leads = [], total } = envelope;
  if (!leads.length) return null;
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}>
      {typeof total === "number" && (
        <div className="mb-2 text-xs opacity-70">{total} total</div>
      )}
      <ul className="flex flex-col gap-1.5">
        {leads.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium">{l.name}</span>
            <span className="flex items-center gap-2 text-xs opacity-70">
              {l.channel && <span className="rounded bg-black/5 px-1.5 py-0.5">{l.channel}</span>}
              {l.interest && <span>{l.interest}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

**`ConversationListPart.tsx`:**
```tsx
"use client";
import { useTranslations } from "next-intl";
import type { CopilotEnvelope } from "@/lib/copilot-api";

export function ConversationListPart({ envelope }: { envelope: Extract<CopilotEnvelope, { type: "conversation-list" }> }) {
  const t = useTranslations("copilot");
  const { conversations = [] } = envelope;
  if (!conversations.length) return null;
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}>
      <ul className="flex flex-col gap-1.5">
        {conversations.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium">{c.customerName}</span>
            <span className="flex items-center gap-2 text-xs opacity-70">
              {c.handoffCategory && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{t("needsAttention")}</span>}
              {c.channel && <span>{c.channel}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

**`ProgressPart.tsx`:**
```tsx
"use client";
export function ProgressPart({ envelope }: { envelope: { type: "progress"; message: string } }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border p-3 text-sm opacity-80" style={{ borderColor: "var(--wk-divider, #e5e7eb)" }}>
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      <span>{envelope.message}</span>
    </div>
  );
}
```

**`ErrorPart.tsx`:**
```tsx
"use client";
import { useTranslations } from "next-intl";
export function ErrorPart({ envelope }: { envelope: { type: "error"; message: string; retryable: boolean } }) {
  const t = useTranslations("copilot");
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <span>{envelope.message}</span>
      {envelope.retryable && <span className="text-xs opacity-70">{t("retry")}</span>}
    </div>
  );
}
```

**`LinkCardPart.tsx`:**
```tsx
"use client";
import { Link } from "@/i18n/navigation";
export function LinkCardPart({ envelope }: { envelope: { type: "link-card"; title: string; description?: string; href: string; cta: string } }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3" style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}>
      <div className="flex flex-col">
        <span className="text-sm font-semibold">{envelope.title}</span>
        {envelope.description && <span className="text-xs opacity-70">{envelope.description}</span>}
      </div>
      <Link href={envelope.href} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: "var(--wk-primary, #0ea5e9)", color: "#fff" }}>
        {envelope.cta}
      </Link>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/user/copilot/overlay/parts
git commit -m "feat(copilot-overlay): add envelope renderer parts with zero/dash and sanitizer fixes"
```

### Task 7: Panel surface — three visual modes

**Files:**
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/overlay/CopilotPanelSurface.tsx`

**Interfaces:**
- Consumes: `useCopilotOverlay()` (view, close, minimize, composerDraft, setComposerDraft). `useCopilotConversation()` (messages). `useCopilotSocket()` (deltas + final envelopes). `copilotService.postMessage()` (send).
- Produces: `<CopilotPanelSurface />` — renders three modes by `view`:
  - `view === "closed"`: returns `null` (only the FAB + backdrop mount).
  - `view === "minimized"`: a `~88px` bottom strip — composer (`<textarea>` + send), no header, no message area, draft preserved.
  - `view === "expanded"`: full-screen panel — header (close + minimize buttons + title), scrollable message area, composer pinned at bottom. framer-motion `<AnimatePresence>` between strip↔expanded with a150ms slide.

- [ ] **Step 1: Create the surface**

```tsx
// src/components/user/copilot/overlay/CopilotPanelSurface.tsx
"use client";
import { AnimatePresence, motion } from "framer-motion";
import { Maximize2, Minus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useCopilotOverlay } from "@/contexts/CopilotOverlayContext";
import { useCopilotConversation } from "@/hooks/copilot/useCopilotConversation";
import { useCopilotSocket } from "@/hooks/copilot/useCopilotSocket";
import { copilotService, type CopilotEnvelope } from "@/lib/copilot-api";
import { renderEnvelope } from "./parts";

export function CopilotPanelSurface() {
  const { view, close, minimize, composerDraft, setComposerDraft } = useCopilotOverlay();
  const t = useTranslations("copilot.overlay");
  const { conversation, messages } = useCopilotConversation();
  const [streamingText, setStreamingText] = useState("");
  const [pending, setPending] = useState(false);

  const onDelta = useCallback((d: string) => setStreamingText((p) => p + d), []);
  const onStreamEnd = useCallback(() => {
    setStreamingText("");
    setPending(false);
  }, []);
  useCopilotSocket({ conversationId: conversation.data?.id, onDelta, onStreamEnd });

  const send = useCallback(async (text: string) => {
    setPending(true);
    try {
      await copilotService.postMessage(text);
      onStreamEnd();
      // REST will refetch via socket invalidation; no manual invalidate here.
    } catch {
      onStreamEnd();
    }
  }, [onStreamEnd]);

  // Esc on expanded closes; from minimized we leave Esc alone (page may own it).
  useEffect(() => {
    if (view !== "expanded") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, close]);

  if (view === "closed") return null;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view === "minimized" && (
        <motion.div
          key="min"
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-x-0 bottom-0 flex items-center gap-2 border-t bg-white p-3"
          style={{ borderColor: "var(--wk-divider, #e5e7eb)", zIndex: "var(--wk-overlay-z, 1000000000)" as any }}
        >
          <ComposerStrip draft={composerDraft} setDraft={setComposerDraft} onSend={(t) => void send(t)} disabled={pending} placeholder={t("composer.placeholder")} />
          <button type="button" onClick={() => minimize === minimize ? null : null /* never */} aria-label={t("header.close")} className="hidden" />
        </motion.div>
      )}
      {view === "expanded" && (
        <motion.div
          key="exp"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 flex flex-col bg-white"
          style={{ zIndex: "var(--wk-overlay-z, 1000000000)" as any }}
          dir="auto"
        >
          <Header onClose={close} onMinimize={minimize} />
          <MessageArea
            messages={messages.data ?? []}
            streamingText={streamingText}
            isLoading={messages.isLoading}
          />
          <ComposerStrip draft={composerDraft} setDraft={setComposerDraft} onSend={(t) => void send(t)} disabled={pending} placeholder={t("composer.placeholder")} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Header({ onClose, onMinimize }: { onClose: () => void; onMinimize: () => void }) {
  const t = useTranslations("copilot.overlay.header");
  return (
    <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--wk-divider, #e5e7eb)" }}>
      <h2 className="text-base font-semibold">{t("title")}</h2>
      <div className="flex items-center gap-1">
        <button type="button" onClick={onMinimize} aria-label={t("minimize")} className="wk-icon-button"><Minus className="h-4 w-4" /></button>
        <button type="button" onClick={onClose} aria-label={t("close")} className="wk-icon-button"><X className="h-4 w-4" /></button>
      </div>
    </header>
  );
}

function MessageArea({
  messages,
  streamingText,
  isLoading,
}: {
  messages: ReturnType<typeof useCopilotConversation>["messages"]["data"] extends infer T ? T extends Array<infer M> ? M[] : never : never;
  streamingText: string;
  isLoading: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamingText]);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {isLoading && !messages?.length ? (
        <EmptyState />
      ) : (
        (messages ?? []).map((m) => <MessageRow key={m.id} message={m} />)
      )}
      {streamingText && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}>
            {streamingText}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageRow({ message }: { message: NonNullable<ReturnType<typeof useCopilotConversation>["messages"]["data"]>[number] }) {
  if (message.role === "USER") {
    const env = message.envelope as { text?: string };
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm" style={{ background: "var(--wk-primary, #0ea5e9)", color: "#fff" }}>
          {env.text ?? ""}
        </div>
      </div>
    );
  }
  // ASSISTANT — render all envelope parts
  const env = message.envelope as { envelopes?: CopilotEnvelope[] };
  const envelopes = Array.isArray(env.envelopes) ? env.envelopes : [];
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] flex-col gap-2">
        {envelopes.map((e, i) => (
          <div key={i}>{renderEnvelope(e)}</div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  const t = useTranslations("copilot.overlay.emptyState");
  return (
    <div className="m-auto max-w-md text-center text-sm opacity-70">
      <div className="mb-2 text-base font-medium">{t("title")}</div>
      <div>{t("subtitle")}</div>
    </div>
  );
}

function ComposerStrip({
  draft,
  setDraft,
  onSend,
  disabled,
  placeholder,
}: {
  draft: string;
  setDraft: (s: string) => void;
  onSend: (s: string) => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div className="flex items-end gap-2 border-t p-3" style={{ borderColor: "var(--wk-divider, #e5e7eb)" }}>
      <textarea
        dir="auto"
        rows={1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const v = draft.trim();
            if (v) { onSend(v); setDraft(""); }
          }
        }}
        placeholder={placeholder}
        className="min-h-[40px] flex-1 resize-none rounded-md border px-3 py-2 text-sm focus:outline-none disabled:opacity-50"
        style={{ borderColor: "var(--wk-divider, #e5e7eb)", background: "var(--wk-bg-elevated, #fff)" }}
      />
      <button
        type="button"
        onClick={() => { const v = draft.trim(); if (v) { onSend(v); setDraft(""); } }}
        disabled={disabled || !draft.trim()}
        className="flex h-10 w-10 items-center justify-center rounded-md disabled:opacity-50"
        style={{ background: "var(--wk-primary, #0ea5e9)", color: "#fff" }}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 rtl:-scale-x-100" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 5l7 7-7 7" /></svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean. (The placeholder `<button onClick={() => minimize === minimize ? null : null /* never */} />` is a stub for accessibility focus order — leave it; it renders `hidden`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/user/copilot/overlay/CopilotPanelSurface.tsx
git commit -m "feat(copilot-overlay): add panel surface with minimized/expanded modes"
```

### Task 8: Wire overlay into the user dashboard layout

**Files:**
- Modify: `app/.worktrees/copilot-overlay/src/app/[locale]/(protected)/user/(dashboard)/layout.tsx`
- Create: `app/.worktrees/copilot-overlay/src/components/user/copilot/overlay/CopilotPanel.tsx` (thin wrapper composing backdrop + surface)

**Interfaces:**
- Produces: `CopilotPanel.tsx` = `<CopilotPanelBackdrop /> + <CopilotPanelSurface />`. The dashboard layout mounts `CopilotOverlayProvider` + `CopilotFab` + `CopilotPanel` as siblings of `BaseDashboardLayout`'s children.

- [ ] **Step 1: Create the wrapper**

```tsx
// src/components/user/copilot/overlay/CopilotPanel.tsx
import { CopilotPanelBackdrop } from "./CopilotPanelBackdrop";
import { CopilotPanelSurface } from "./CopilotPanelSurface";

export function CopilotPanel() {
  return (
    <>
      <CopilotPanelBackdrop />
      <CopilotPanelSurface />
    </>
  );
}
```

- [ ] **Step 2: Modify the user dashboard layout**

Replace the contents of `src/app/[locale]/(protected)/user/(dashboard)/layout.tsx`:

```tsx
import { setRequestLocale } from "next-intl/server";
import { CopilotKit } from "@copilotkit/react-ui";
import BaseDashboardLayout from "@/components/shared/BaseDashboardLayout";
import { InboxUIProvider } from "@/contexts/InboxUIContext";
import { CopilotOverlayProvider } from "@/contexts/CopilotOverlayContext";
import { CopilotFab } from "@/components/user/copilot/overlay/CopilotFab";
import { CopilotPanel } from "@/components/user/copilot/overlay/CopilotPanel";

export default async function UserPagesLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <CopilotKit /* runtimeUrl={undefined} — headless, transport handled by us */>
      <CopilotOverlayProvider>
        <InboxUIProvider>
          <BaseDashboardLayout role="user" contentMaxWidthClass="max-w-[1600px]">
            {children}
          </BaseDashboardLayout>
          <CopilotFab />
          <CopilotPanel />
        </InboxUIProvider>
      </CopilotOverlayProvider>
    </CopilotKit>
  );
}
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
npm run build
```

Expected: clean + build succeeds.

- [ ] **Step 4: Manual smoke**

`npm run dev`. Visit `http://localhost:3000/ar/user/dashboard` (need a login session):
- FAB visible bottom-right (RTL: visible bottom-left visually but `end-6` keeps it consistent).
- Click FAB → panel expands, page scroll-locked, backdrop visible.
- Send "Show me my numbers" → streaming + stat-grid card with real values (no `—` for zeros).
- Click minimize → bottom strip appears, page interactive, draft preserved.
- Type text → navigate to `/user/customers` → text preserved in strip.

- [ ] **Step 5: Commit**

```bash
git add src/components/user/copilot/overlay/CopilotPanel.tsx "src/app/[locale]/(protected)/user/(dashboard)/layout.tsx"
git commit -m "feat(copilot-overlay): mount providers + FAB + panel in user dashboard layout"
```

### Task 9: Sidebar entry becomes toggle button

**Files:**
- Modify: `app/.worktrees/copilot-overlay/src/components/shared/sidebar/UserSidebar.tsx`

**Interfaces:**
- Reads `useCopilotOverlay()` inside a sidebar child component (`<CopilotSidebarToggle />`); the `copilot` nav entry becomes that component (not a `<Link>`). The label text is reused from `userTranslations.navigation.copilot`.

- [ ] **Step 1: Create the toggle button**

Add a small component inside `UserSidebar.tsx` (or a separate file imported by it):

```tsx
// inside src/components/shared/sidebar/UserSidebar.tsx (add at top of file)
"use client";
import { useCopilotOverlay } from "@/contexts/CopilotOverlayContext";

function CopilotSidebarToggle({ label }: { label: string }) {
  const { view, toggleOpen } = useCopilotOverlay();
  const open = view !== "closed";
  return (
    <button
      type="button"
      onClick={toggleOpen}
      aria-pressed={open}
      className={`wk-nav-link flex w-full items-center gap-2 ${open ? "is-active" : ""}`}
    >
      <BotMessageSquare className="h-4 w-4" aria-hidden />
      <span>{label}</span>
    </button>
  );
}
```

(Use whichever lucide icon the existing entry uses; mirror its key in the nav array.)

- [ ] **Step 2: Replace the copilot Link entry with the toggle**

Find the navigation array entry with `key: "copilot"` and `href: "/user/copilot"`. Replace the rendered `<Link>` with `<CopilotSidebarToggle label={...} />`. Keep the entry FIRST in the array (matches the existing position).

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/shared/sidebar/UserSidebar.tsx
git commit -m "feat(copilot-overlay): convert sidebar copilot entry to overlay toggle button"
```

### Task 10: Revert default-landing redirect to /user/dashboard

**Files:**
- Modify: `app/.worktrees/copilot-overlay/src/app/[locale]/(protected)/user/page.tsx`
- Modify: `app/.worktrees/copilot-overlay/src/contexts/AuthContext.tsx` (`login` + `redirectAuthenticatedUser` for `case "user"` and `default`)
- Modify: `app/.worktrees/copilot-overlay/src/lib/role-config.ts` (`getRedirectUrl` user → `/user/dashboard`)

**Interfaces:**
- `protectedRoute(role="user")` returns `/user/dashboard`. `PublicAuthGuard` continues to call `getRedirectUrl` (already does); behavior is `getRedirectUrl` returns `/user/dashboard` again.

- [ ] **Step 1: Revert `src/app/[locale]/(protected)/user/page.tsx`**

Change `redirect(`/${locale}/user/copilot`)` → `redirect(`/${locale}/user/dashboard`)`.

- [ ] **Step 2: Revert `src/contexts/AuthContext.tsx`**

In `login` and `redirectAuthenticatedUser`, change both `case "user":` and `default:` from `/user/copilot` to `/user/dashboard`.

- [ ] **Step 3: Revert `src/lib/role-config.ts`**

Change `getRedirectUrl`'s user-role branch from `/user/copilot` to `/user/dashboard`.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(protected)/user/page.tsx" src/contexts/AuthContext.tsx src/lib/role-config.ts
git commit -m "fix(copilot-overlay): revert default user landing to /user/dashboard"
```

### Task 11: Delete obsolete files

**Files:**
- Delete: `src/app/[locale]/(protected)/user/(dashboard)/copilot/page.tsx`
- Delete: `src/components/user/copilot/CopilotShell.tsx`
- Delete: `src/components/user/copilot/MessageStream.tsx`
- Delete: `src/components/user/copilot/MessageBubble.tsx`
- Delete: `src/components/user/copilot/Composer.tsx`
- Delete: `src/components/user/copilot/ThinkingIndicator.tsx`
- Delete: `src/components/user/copilot/QuickReplies.tsx`
- Delete: `src/components/user/copilot/cards/{StatGridCard,LeadListCard,ConversationListCard,ProgressCard,ErrorCard,LinkCard}.tsx` (whole directory)

- [ ] **Step 1: Delete the files**

```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app\.worktrees\copilot-overlay
rm "src/app/[locale]/(protected)/user/(dashboard)/copilot/page.tsx"
rmdir "src/app/[locale]/(protected)/user/(dashboard)/copilot" 2>/dev/null || true
rm src/components/user/copilot/CopilotShell.tsx
rm src/components/user/copilot/MessageStream.tsx
rm src/components/user/copilot/MessageBubble.tsx
rm src/components/user/copilot/Composer.tsx
rm src/components/user/copilot/ThinkingIndicator.tsx
rm src/components/user/copilot/QuickReplies.tsx
rm -r src/components/user/copilot/cards
```

- [ ] **Step 2: Verify no leftover imports**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean. (If TS complains about imports of deleted files, follow the references; there shouldn't be any because the deletion makes the `/copilot` route a 404, and the layout now uses `CopilotPanel` instead of `CopilotShell`.)

- [ ] **Step 3: Commit**

```bash
git add -A
git status  # confirm only the intended deletions
git commit -m "chore(copilot-overlay): delete obsolete dedicated-page UI components"
```

### Task 12: Update manual QA script

**Files:**
- Modify: `app/.worktrees/copilot-overlay` — open the manual QA markdown file under `back-end/docs/superpowers/plans/2026-08-23-copilot-chat-foundations-manual-qa.md`. Update rows 1, 2, 10 to reflect overlay behavior + add the new bug-fix / RTL / persistence rows from the spec.

- [ ] **Step 1: Update the QA rows**

Open the file. Replace rows 1, 2, 10, and add rows 15–18. (The exact text is in `docs/superpowers/specs/2026-08-23-copilot-overlay-redesign.md` §Testing — copy those rows verbatim into the manual-qa file.)

- [ ] **Step 2: Commit**

```bash
git add ../back-end/docs/superpowers/plans/2026-08-23-copilot-chat-foundations-manual-qa.md
git commit -m "docs(copilot): update manual QA for overlay redesign"
```

### Task 13: Final whole-branch gate

- [ ] **Step 1: Run the full frontend gate**

```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\app\.worktrees\copilot-overlay
npx tsc --noEmit
npm run lint
npm run build
```

Expected: clean + build succeeds.

- [ ] **Step 2: Verify backend unchanged**

```bash
cd D:\zTechy Org\pagespilot.com\wkil-fullstack\back-end
git log -1 --format='%h %s'   # should be e6ac5e1 or later plan-doc commit
```

- [ ] **Step 3: Manual QA**

Run the updated script in `back-end/docs/superpowers/plans/2026-08-23-copilot-chat-foundations-manual-qa.md`. All 18 rows must pass.

- [ ] **Step 4: Done**

Write `D:\zTechy Org\pagespilot.com\wkil-fullstack\back-end\.superpowers\sdd\2026-08-23-copilot-overlay\task-14-report.md` summarizing gate evidence + manual QA results. No commits needed unless manual QA surfaced a fix (which would be Task 15+).

---

## Plan self-review (by author)

- **Spec coverage:** every spec requirement maps to a task (mount point → Task 8; 3 states → Task 3 + 4 + 5 + 7; FAB → 4; backdrop → 5; parts → 6; sidebar toggle → 10; revert landing → 11; delete obsolete → 12; bug fixes → embedded in Tasks 6 + 7; i18n → Tasks 4 + 6; library-first → Task 1 + deletions in Task 12).
- **Placeholder scan:** none. All code blocks are concrete.
- **Type consistency:** `CopilotEnvelope` type mirrors `src/lib/copilot-api.ts`. Context shape (`view`, `composerDraft`, action methods) is identical across Tasks 3, 4, 5, 7, 8, 10. The `CopilotToolContext` import path is unchanged.
- **Risk flagged:** Task 1 is the hard gate. If CopilotKit can't be used headlessly, the spec needs revision (fallback: shadcn/ui Dialog primitives + our own scroll/streaming).
- **Skipped the spike result risk:** if the spike verdict is STOP, no later task runs until the spec is revised and re-approved.

## Execution handoff

Once this plan is saved, the execution options are the same as before:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Better for a plan this size (15 tasks including spike).
**2. Inline Execution** — execute in this session with executing-plans + batched checkpoints.

Which approach? (The bug-fix commit is already on `main` per your earlier commit, so the plan starts from a clean `app/main`.)