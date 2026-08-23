# Copilot Phase 1 — Manual QA Script

Run with dev servers up: backend on `:8080`, frontend on `:3000`. Test in both `/ar` and `/en`.

| # | Scenario | Expected |
|---|---|---|
| 1 | Log in as an owner | Lands on `/{locale}/user/copilot`, sidebar shows "وكيلك"/"Copilot" as the FIRST entry |
| 2 | Send "Show me my numbers" | Thinking indicator → streamed text → stat-grid card |
| 3 | Ask "مين محتاج رد مني؟" in `/ar` | Arabic reply + conversation-list card; layout fully RTL |
| 4 | Sign up a brand-new account, first open | Onboarding interview starts (business_info step) |
| 5 | Give website URL during onboarding | progress envelope, then extracted identity summary |
| 6 | Complete onboarding (`finish_onboarding`) | Thread continues as general copilot (kind flips to GENERAL) |
| 7 | Disconnect network mid-reply, reconnect | Final envelopes appear after refetch (REST history) |
| 8 | Exhaust quota (or mock 402) | Clear quota error envelope, no crash; UI shows error card |
| 9 | Spam 61+ messages/hour | `429` from `copilotLimiter` |
| 10 | `/user/dashboard` directly | Old dashboard still renders and works |
| 11 | Already-authenticated owner visits `/auth/login` | Redirects to `/user/copilot`, not `/user/dashboard` |
| 12 | New browser tab while chat is streaming | On reconnect, messages refetch via React Query invalidation |
