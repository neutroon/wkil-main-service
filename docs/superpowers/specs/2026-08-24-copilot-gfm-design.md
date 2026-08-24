# Copilot GFM Markdown + Quality Polish — Design

**Date:** 2026-08-24
**Status:** Approved (auto-approved per human partner instruction)
**Scope:** Frontend only
**Author:** Brainstorming session

## Problem

The copilot overlay's message rendering uses `@assistant-ui/react-markdown`'s default components, which only handle CommonMark. When the LLM produces:

- Tables (pipe syntax)
- Strikethrough (`~~text~~`)
- Task lists (`- [ ] item`)
- Autolinks (`https://...`)
- Code blocks (no syntax highlighting)

…they come out as raw text. The user sees `| col | col |` instead of a real table. ChatGPT and Claude render these natively; our overlay doesn't.

## Goals

- Tables render as proper tables with borders, padding, and a header row.
- Strikethrough, task lists, and autolinks render natively (no extra wiring — `remark-gfm` handles them).
- Inline code has a distinct visual style (rounded gray background — matches ChatGPT/Claude).
- The change is one file, one commit, one new dependency (`remark-gfm`).

## Non-Goals

- Custom syntax highlighting (Shiki / Prism / Highlight.js). The default code block rendering from `@assistant-ui/react-markdown` is sufficient; adding `@assistant-ui/react-syntax-highlighter` is a future enhancement if needed.
- Theme switching (dark mode). The current copilot overlay is light-only.
- Table-of-contents generation, footnotes, definition lists. GFM supports them but we don't customize.

---

## Architecture

Single-file change in the frontend:

```
WkTextPart (currently: plain <MarkdownTextPrimitive />)
  └─ Updated to: <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={{...}} />

result: assistant messages render with tables, strikethrough, task lists, autolinks,
        and styled inline code — ChatGPT/Claude quality
```

No state changes. No socket event changes. No backend changes. No service layer changes.

---

## Frontend changes

### Files touched

| File | Change |
|---|---|
| `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` | Update `WkTextPart` to pass `remarkPlugins={[remarkGfm]}` and override `table`/`thead`/`th`/`td`/`code` components for ChatGPT-quality rendering. |
| `app/package.json` + `app/pnpm-lock.yaml` | Add `remark-gfm` dependency. |

### Component overrides

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

### Why these specific overrides

- **Table wrapper in `<div className="overflow-x-auto">`**: tables wider than the overlay pane scroll horizontally on mobile rather than overflowing the bubble.
- **`min-w-full border-collapse text-xs`**: tables fill their container, collapse borders (sharp 1px lines), and use the bubble's small-font scale so they don't dominate the message.
- **`thead` with `bg-gray-50`**: subtle header row distinguishes column labels from data. Matches ChatGPT.
- **`th` with `text-left font-medium px-2 py-1`**: column labels are slightly heavier and left-aligned with tight padding.
- **`td` with `border-t px-2 py-1`**: data rows have a top border (no double borders thanks to `border-collapse`) and tight padding.
- **`code` discrimination**: inline `<code>` (no `language-*` class) gets the rounded gray pill; block `<code>` (inside `<pre>`, has `language-*` class) is left untouched so the default code-block renderer (which produces the `<pre>` wrapper) can style it.

### Dependency note

Only one new dependency: `remark-gfm`. It's a pure ESM markdown plugin with no transitive deps of concern. `pnpm add remark-gfm` is sufficient.

---

## Migration & sequencing

**Single PR:**
- `app/package.json` + `pnpm-lock.yaml` — add `remark-gfm`
- `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` — update `WkTextPart`

**Validation:** tsc clean, eslint clean, next build succeeds. Manual smoke test in the overlay:
- Ask the copilot to produce a table (e.g., "compare MongoDB and PostgreSQL as a table") → renders as a proper bordered table with a header row
- Inline `\`code\`` → rounded gray background
- Strikethrough `~~text~~` → struck through
- Task list `- [ ] item` → checkbox rendered
- Autolink `https://example.com` → clickable link

---

## Files touched

**Frontend (modified):**
- `app/src/components/user/copilot/overlay/CopilotPanelSurface.tsx` (modified — `WkTextPart`)
- `app/package.json` (modified — add `remark-gfm`)
- `app/pnpm-lock.yaml` (modified — lockfile update)

**Backend (none):**
- (none)

---

## Known limitations

1. **No syntax highlighting.** The default code-block rendering from `@assistant-ui/react-markdown` is plain text with no Shiki/Prism/Highlight.js. Adding `@assistant-ui/react-syntax-highlighter` is a future enhancement if the user wants colored code blocks.

2. **Single language per code block.** When the LLM emits multiple code blocks in one response, each is rendered independently. No combined view.

3. **No dark mode.** The copilot overlay is light-only. Adding `dark:` variants to the table overrides would be a future enhancement.

---

## Out of scope (deferred)

- Feedback submission (explicitly skipped per user instruction)
- True regenerate (already shipped)
- True backend cancel (already shipped)
