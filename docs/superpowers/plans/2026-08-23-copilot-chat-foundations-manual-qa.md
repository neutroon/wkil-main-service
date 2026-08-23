# Copilot Overlay — Manual QA Script

Run with dev servers up: backend on `:8080`, frontend on `:3000`. Test in both `/ar` and `/en`. Requires owner login session.

| # | Scenario | Expected |
|---|---|---|
| 1 | Land on `/user/dashboard` | FAB visible bottom-right, no overlay open |
| 2 | Click FAB | Overlay expands full-screen, backdrop blocks page, scroll-locked |
| 3 | Send "Show me my numbers" | Stat-grid card with real values (no `—` for actual zeros) |
| 4 | Ask "مين محتاج رد مني؟" in `/ar` | Conversation-list card; full RTL |
| 5 | Click minimize | Bottom strip remains, page interactive, scroll restored |
| 6 | Type in composer, navigate to `/user/customers` | Overlay stays minimized, draft preserved |
| 7 | Navigate back to dashboard | Expand via FAB → draft still there |
| 8 | Send the draft | Message appears + assistant streams |
| 9 | Click sidebar `Copilot` entry | Overlay toggles expand/minimize |
| 10 | Press `Esc` while expanded | Closes; `Esc` from `minimized` does nothing (the page underneath may handle its own Esc semantics) |
| 11 | Hit `/user/dashboard` directly | Loads at dashboard, not at a stale overlay state (overlay state resets on hard navigation / page reload) |
| 12 | Sign up a new owner | Onboarding interview runs inside the overlay (the onboarding-mode graph + tools are unchanged; the overlay renders the same envelopes) |
| 13 | Verify no `—` zeros, no raw tool-output cards, no overlapping header | (Bug #1, #2, #3, #4, #5 all visually clean) |
| 14 | Verify `/copilot` route | Returns 404 (deleted page) |
