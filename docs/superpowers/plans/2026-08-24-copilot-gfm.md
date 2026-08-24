# Copilot GFM Markdown + Quality Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make assistant messages render with GitHub-Flavored Markdown (tables, strikethrough, task lists, autolinks) and styled inline code — ChatGPT/Claude quality.

**Architecture:** Add `remark-gfm` plugin to the existing `@assistant-ui/react-markdown` MarkdownTextPrimitive, override `table`/`thead`/`th`/`td`/`code` components for tight ChatGPT-quality styling. Single-file change in the frontend.

**Tech Stack:** Next.js 15, React 19, `@assistant-ui/react@0.15.16`, `@assistant-ui/react-markdown@0.14.12`, `remark-gfm@4.x`, `pnpm`, TypeScript, ESLint, Next.js build.

## Global Constraints

- One new dependency: `remark-gfm`.
- No DB migration.
- No backend changes.
- No state changes — purely a render-time change in the frontend.
- The change is in the `app/` nested repo on `main` branch.
- The override for the `code` component discriminates inline (no `language-*` class → pill style) from block (with `language-*` class → left untouched for the default code-block renderer to wrap).
- Frontend has no test runner — manual smoke test only.

---

## File Structure

**Frontend (modified):**
- `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` — update `WkTextPart` to use `remarkGfm` + component overrides
- `app/package.json` — add `remark-gfm` to dependencies
- `app/pnpm-lock.yaml` — lockfile update

---

## Task 1: Install `remark-gfm` and update `WkTextPart`

**Files:**
- Modify: `app/package.json`
- Modify: `app/pnpm-lock.yaml`
- Modify: `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx`

**Interfaces:**
- Consumes: existing `MarkdownTextPrimitive` import from `@assistant-ui/react-markdown`
- Produces: `WkTextPart` renders GFM with tight ChatGPT-quality styling

- [ ] **Step 1: Install `remark-gfm`**

Run: `cd app && pnpm add remark-gfm`
Expected: `remark-gfm` added to `dependencies` in `package.json` and to `pnpm-lock.yaml`.

- [ ] **Step 2: Read the current `WkTextPart`**

Read `D:\zTechy Org\pagespilot.com\wkil-fullstack\app\src\components\user\copilot\overlay\CopilotPanelSurface.tsx` and locate the `WkTextPart` function. Note the existing import of `MarkdownTextPrimitive`.

- [ ] **Step 3: Update the imports**

Replace the `MarkdownTextPrimitive` import line (and add `remarkGfm` import above it). The existing import line is:

```ts
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
```

Replace it with:

```ts
import remarkGfm from "remark-gfm";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
```

- [ ] **Step 4: Replace `WkTextPart`**

Find the existing `WkTextPart` function (it renders `<MarkdownTextPrimitive>` inside a styled div) and replace the body of the function with:

```tsx
function WkTextPart() {
  return (
    <div
      className="max-w-full rounded-lg border px-3 py-2 text-sm prose prose-sm max-w-none dark:prose-invert"
      style={{
        borderColor: "var(--wk-divider, #e5e7eb)",
        background: "var(--wk-bg-elevated, #fff)",
      }}
    >
      <MarkdownTextPrimitive
        remarkPlugins={[remarkGfm]}
        components={{
          // Wrap tables in a horizontally-scrollable container (mobile-friendly).
          table: ({ children, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table {...props} className="min-w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          // Subtle header row background — matches ChatGPT/Claude.
          thead: ({ children, ...props }) => (
            <thead {...props} className="border-b bg-gray-50">
              {children}
            </thead>
          ),
          th: ({ children, ...props }) => (
            <th {...props} className="px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="border-t px-2 py-1">
              {children}
            </td>
          ),
          // Inline code (no `language-*` class) gets a rounded gray background;
          // block code (with `language-*` class) is rendered by the default
          // code-block component from `@assistant-ui/react-markdown`.
          code: ({ children, className, ...props }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-gray-100 px-1 py-0.5 text-xs font-mono"
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run `npx tsc --noEmit`**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Run `npx eslint --quiet`**

Run: `cd app && npx eslint --quiet`
Expected: clean.

- [ ] **Step 7: Run `npx next build --turbopack --no-lint`**

Run: `cd app && npx next build --turbopack --no-lint`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
cd app && git add package.json pnpm-lock.yaml src/components/user/copilot/overlay/CopilotPanelSurface.tsx && git commit -m "feat(copilot): GFM markdown + ChatGPT-quality polish

- Adds remark-gfm to @assistant-ui/react-markdown so tables,
  strikethrough, task lists, and autolinks render natively (no more
  raw pipe tables in the UI)
- Component overrides on WkTextPart: tables scroll horizontally on
  narrow screens, header row gets a subtle bg-gray-50, cells get tight
  padding + top border, inline code gets a rounded gray pill (like
  ChatGPT/Claude); block code is left untouched so the default
  code-block renderer can wrap it in <pre>
- Single file changed (CopilotPanelSurface.tsx), one new dep
  (remark-gfm) — no backend changes"
```

- [ ] **Step 9: Verify with `git log --oneline -1`**

Expected: your commit landed on top of the current `app/main` HEAD (which is `13539310` — the latest commit from the regenerate plan).

---

## Task 2: Frontend validation gate

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

With the app dev server running, open the copilot overlay and verify:
1. Tables render with proper borders, header row, and cell padding.
2. Strikethrough (`~~text~~`) renders as struck-through text.
3. Task lists (`- [ ] item`) render with checkboxes.
4. Inline code (`\`x\``) renders as a rounded gray pill.
5. Autolinks (`https://example.com`) render as clickable links.
6. No console errors, no hydration warnings.

- [ ] **Step 5: Fix any issues surfaced**

If validation surfaces bugs, fix them in commits. Each commit's message should reference the bug.

---

## Self-review checklist (run before handoff)

1. **Spec coverage:** each requirement in `docs/superpowers/specs/2026-08-24-copilot-gfm-design.md` maps to at least one task. Walk through:
   - Tables, strikethrough, task lists, autolinks render natively → Task 1 (via remarkGfm)
   - Inline code pill style → Task 1 (code override)
   - Table wrapper for horizontal scroll → Task 1 (table override)
   - Header row background → Task 1 (thead override)
   - One new dependency (remark-gfm) → Task 1 (pnpm add)
   - Single file change → Task 1 (CopilotPanelSurface.tsx only)
   - Manual smoke test → Task 2
2. **Placeholder scan:** no "TBD", "TODO", "implement later" in the plan steps.
3. **Type consistency:** `MarkdownTextPrimitive`, `remarkGfm`, `WkTextPart` — same names everywhere.
4. **Commit boundaries:** each task produces a single, reviewable commit.
