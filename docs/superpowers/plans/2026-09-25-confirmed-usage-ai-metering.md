# Confirmed-usage AI metering implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the spec and each repository's `AGENTS.md` before editing.

**Goal:** Restore reliable chat after ambiguous model failures while charging monthly AI credits only for confirmed, idempotent model usage.

**Architecture:** The backend remains the authority for preflight quota and atomic usage recording. The Python agent calls quota once before model work, records provider-reported usage after a successful model response, and never creates a user-wide reservation. Existing LangGraph run persistence and provider fallback stay unchanged; clients display run errors with an obvious retry action.

**Tech Stack:** Express/TypeScript/Prisma/Vitest (`back-end`), LangChain/LangGraph/Python/pytest (`agent-svc`), Next.js/assistant-ui/Vitest (`app`), Expo/assistant-ui React Native/Vitest (`m`).

**Spec:** `../specs/2026-09-25-provider-agnostic-model-metering-recovery-design.md`

## Global Constraints

- No new database ledger or migration; preserve all historical `AgentModelReservation` rows and never use them for admission.
- Credits are a monthly allowance, not a mathematically strict prepaid spending cap; debit only evidenced usage, once per `AiCallLog.eventId`.
- Keep authenticated tenant scope on internal endpoints; never log prompts, replies, email, tokens, or credentials.
- Keep the existing 4,096 output-token cap, eight model turns per run, provider fallback, and SDK retry budget; do not stack model-call retries.
- Usage reporting failure must not turn a valid model reply into a failed chat. Quota-service outage must fail closed with a retryable error, distinct from confirmed quota exhaustion.
- Do not push, deploy, mutate production data, or remove old reservation rows without separate authorization. Commit only after an explicit user request. Preserve unrelated work.
- Use the existing repository lockfiles; no dependency upgrade is needed. If a public response contract changes, coordinate OpenAPI and generated clients.

## Review Focus

- Existing unresolved reservation for the same user: new quota and model call proceed when recorded credits remain below limit (Task 1 tests).
- Malformed or missing identity at quota gate: deny spending as an error, never treat it as quota exhaustion (Tasks 1 and 3 tests).
- Concurrent duplicate usage event: exactly one debit and aggregate update; conflicting payload is rejected, not silently accepted (Task 2 tests).
- Successful model reply with absent usage metadata or transient `/usage` outage: reply survives, no invented debit, and an alertable redacted error is emitted (Task 4 tests).
- Provider 503 followed by a new run: failed run is visible with retry and no stale reservation blocks the next run (Tasks 4 and 5 tests).

---

### Task 1: Make legacy reservation endpoints nonblocking and classify quota responses

**Files:**
- Modify: `back-end/src/modules/ai-agent/tools/agent.model-reservation.ts`
- Modify: `back-end/src/modules/ai-agent/tools/agent.tools.controller.ts`
- Create: `back-end/src/modules/ai-agent/tools/agent.model-reservation.test.ts`
- Modify: `back-end/src/modules/ai-agent/tools/agent.tools.controller.test.ts`

**Interfaces:**
- Preserve `POST /internal/agent/model-calls/reserve` and `/release` request shapes during rollout. A valid legacy reserve/release returns `{ ok: true }` without reading or writing `AgentModelReservation`; invalid payload remains 400. The reserve response may include `reservedCredits: 0` for old callers.
- `GET /internal/agent/quota`: 200 `{ ok: true }` if admitted; 200 `{ ok: false, reason: "quota_exceeded" }` only for `AppError.statusCode === 402`; 503 `{ error: "quota_unavailable" }` for unavailable storage/service; malformed identity is 400 and unknown user is 404. Preserve existing service-token boundary and authenticated agent scope.

- [x] **Step 1: Write failing route tests.** Assert a pre-existing unresolved row is never queried or changed by reserve/release; valid calls are nonblocking; malformed payload is 400; quota 402 maps to confirmed exhaustion while a Prisma rejection maps to 503, not `ok:false`; invalid user ID is 400 and unknown user is 404.
- [x] **Step 2: Run red tests.** From `back-end`: `npm test -- src/modules/ai-agent/tools/agent.model-reservation.test.ts src/modules/ai-agent/tools/agent.tools.controller.test.ts`. Expect the new assertions to fail against the current user-wide reservation and catch-all quota mapping.
- [x] **Step 3: Implement the minimal route changes.** Remove `calculateCustomerCost`, reservation CRUD and reconciliation checks from the compatibility router. Keep request validation and scope enforcement. In the quota route inspect the existing `AppError.statusCode` rather than converting every exception to `false`; use the exact wire responses above.
- [x] **Step 4: Run the same focused command green.** Confirm all route assertions pass; inspect `git diff` to ensure no Prisma schema or production-data changes.

### Task 2: Make confirmed usage atomic, cache-coherent, and strictly idempotent

**Files:**
- Modify: `back-end/src/modules/billing/billing.service.ts`
- Modify: `back-end/src/modules/billing/billing.service.test.ts`
- Modify: `back-end/src/modules/ai-agent/tools/agent.tools.controller.test.ts`

**Interfaces:**
- Keep `recordAiUsage(params): Promise<void>` and `clearQuotaCache(userId: number): void` public signatures. `eventId` remains the idempotency key, with the existing `AiCallLog.eventId` unique constraint.
- A retry must use the same user, business, model, operation, conversation, and token-count payload. Identical duplicates do not increment credits or aggregates; conflicts fail. Successful transaction invalidates the affected user's quota cache before nonessential realtime notification.
- The internal `/usage` route returns 409 `{ error: "usage_event_conflict" }` for a duplicate ID with different payload, 503 `{ error: "usage_not_recorded" }` for storage failure, and 200 `{ ok: true }` for an identical replay.

- [x] **Step 1: Write failing billing tests.** Test an admitted cached user whose confirmed usage reaches quota, then assert the next quota check rejects; repeated same event leaves counters unchanged; a changed operation/conversation/token field conflicts; two concurrent identical posts produce one log/debit; no event ID retains existing non-agent behavior. Add controller assertions for 409 conflict and 503 storage failure.
- [x] **Step 2: Run red tests.** From `back-end`: `npm test -- src/modules/billing/billing.service.test.ts src/modules/ai-agent/tools/agent.tools.controller.test.ts`.
- [x] **Step 3: Implement.** Tighten `existingEvent()` payload equality and preserve `P2002` race recovery within the existing transaction. Call `clearQuotaCache(userId)` immediately after a successful usage transaction; keep websocket notification best-effort so a committed debit is not misreported as a failed usage post. Do not create estimated charges, another ledger, or a migration.
- [x] **Step 4: Run the focused tests green.** Verify the committed-usage and duplicate paths independently.

### Task 3: Fail closed quickly when quota is unavailable, without calling it exhausted

**Files:**
- Modify: `agent-svc/src/agent_svc/tools/http_client.py`
- Modify: `agent-svc/src/agent_svc/nodes/check_quota.py`
- Modify: `agent-svc/tests/tools/test_http_client.py`
- Modify: `agent-svc/tests/nodes/test_check_quota.py`

**Interfaces:**
- Keep `check_quota(user_id: int | None, business_profile_id: int | None) -> bool`: return `False` only for the backend's confirmed `reason: "quota_exceeded"`; return `True` only for `ok: true`; raise a typed `QuotaUnavailableError` for timeout, 503, malformed response, or missing identity. Give this request an explicit 5-second timeout, independent of the pooled client's 30-second default.
- `check_quota_node` may produce the existing upgrade/quota message only on `False`; propagate `QuotaUnavailableError` so LangGraph reports a failed run the user can retry.

- [x] **Step 1: Write failing transport and node tests.** Cover admitted, confirmed exhausted, timeout, 503, invalid JSON, and absent identity; assert timeout is 5 seconds and outage never sets `quota_exceeded` or emits an upgrade message.
- [x] **Step 2: Run red tests.** From `agent-svc`: `uv run pytest tests/tools/test_http_client.py tests/nodes/test_check_quota.py -q`.
- [x] **Step 3: Add `QuotaUnavailableError` and narrow exception mapping.** Do not expose upstream response bodies in user-facing errors or logs. Leave the graph's quota branch and settings lookup otherwise unchanged.
- [x] **Step 4: Run the focused pytest command green.** Verify a later healthy check works after an earlier timeout.

### Task 4: Meter model responses without reservations or customer-facing billing failures

**Files:**
- Modify: `agent-svc/src/agent_svc/model_metering.py`
- Modify: `agent-svc/src/agent_svc/tools/http_client.py`
- Modify: `agent-svc/tests/test_model_metering.py`
- Modify: `agent-svc/tests/tools/test_http_client.py`

**Interfaces:**
- `ModelMetering.on_chat_model_start` retains run ID and authenticated scope in memory; it performs no HTTP request or token estimate. `on_llm_end` extracts provider `usage_metadata` and model name, then posts exactly that usage under `eventId = str(run_id)`.
- `report_usage(payload: dict) -> None` uses at most two attempts for transport/5xx errors, each with a 2-second request timeout; identical event ID/payload on both attempts. Do not retry 4xx/conflict responses. A final failure or missing usage produces one structured error log (`eventId`, model identifier, failure category) and does not raise from the callback. Provider errors still propagate through LangChain/LangGraph; no synthetic assistant answer.

- [x] **Step 1: Replace old reservation-based tests with failing cases.** Assert no reserve/release calls, exact actual token counts, stable event ID across a retry, no debit/report on provider 503, a fresh later run succeeds, missing metadata preserves the reply, and reporting failure logs only redacted fields without masking the reply. Assert call state is cleared on every terminal path.
- [x] **Step 2: Run red tests.** From `agent-svc`: `uv run pytest tests/test_model_metering.py tests/tools/test_http_client.py -q`.
- [x] **Step 3: Implement minimal callback and transport changes.** Remove unused `count_tokens_approximately` and reservation imports/helpers only after finding no other callers. Keep `raise_error=True` for model/authentication failures; catch only metering/reporting failures inside `on_llm_end`. Use standard logging with a stable alert key, never exception text or raw payload. Keep the existing provider fallback/retry and `ModelCallLimitMiddleware` unchanged.
- [x] **Step 4: Run focused tests green.** Inspect logging assertions and make sure no prompt/response text enters operational output.

### Task 5: Make failed-run retry obvious on web and mobile

**Files:**
- Modify: `app/src/components/thread.tsx`
- Create or modify: `app/src/components/thread.error.test.tsx`
- Modify: `m/components/assistant-ui/elements/message.tsx`
  - Create or modify: `m/components/assistant-ui/elements/message-error.test.tsx`
- Modify only if needed: existing English/Arabic chat translation files in each client.
- Verify: `back-end/src/modules/ai-agent/assistant.gateway.test.ts`

**Interfaces:**
  - Use assistant-ui's existing `MessagePrimitive.Error` on web and the native `ErrorPrimitive.Root` conditional primitive with `ActionBarPrimitive.Reload` on mobile; do not introduce a second client retry mechanism or duplicate server quota policy. The failed assistant message shows a visible inline error and labelled Retry action. A successful retry clears/replaces that error. Do not render private upstream details.

- [x] **Step 1: Write failing UI tests.** Simulate a streamed provider 503 and quota-service-unavailable run error; assert a visible error and Retry on web/mobile, retry invokes the runtime action once, and a subsequent completed message has no error. Add/extend gateway test only if its existing passthrough tests do not cover SSE error forwarding.
- [x] **Step 2: Run red tests.** From `app`: `pnpm test -- src/components/thread.error.test.tsx`; from `m`: `pnpm test -- components/assistant-ui/elements/message-error.test.tsx`; from `back-end` if changed: `npm test -- src/modules/ai-agent/assistant.gateway.test.ts`.
- [x] **Step 3: Wire the error-state action using existing primitives.** Put Retry inside the visible error surface on both clients; use the native package's conditional `ErrorPrimitive.Root` to show it only for failed messages. Reuse existing localization keys or add minimal EN/AR keys, following each repo's translation pattern.
- [x] **Step 4: Run focused tests green.** Check keyboard/screen-reader label on web and accessible name/tap target on mobile; keep normal completed-message actions intact.

### Task 6: Document rollout and verify the vertical failure flow

**Files:**
- Modify: `back-end/docs/superpowers/cutover-ai-agent.md` (or the existing operational runbook section that owns deployment order)
- Review: `back-end/docs/openapi.yaml` and generated clients only if Task 1 changes a public response; internal-only routes require no public OpenAPI change.

**Interfaces:** Document backend compatibility routes first, then agent deployment, then client updates; rollback order; alert key and investigation steps; no automatic waiver or customer hold; old-row retention requires a separate approval.

- [x] **Step 1: Add the rollout/runbook section.** Include safe staging tests for an unresolved historical row, provider 503 then successful new chat, quota outage versus exhausted quota, duplicate usage post, and post-deploy monitoring of failed usage reports and per-user overage. Do not include customer identifiers or secrets.
- [x] **Step 2: Run repository checks from each owner.** Full repository tests, client typechecks/lint, agent Ruff checks, backend TypeScript compile, Prisma client generation, temporary OpenAPI bundle, and Android Expo export were run. The npm/uv/pnpm shims and pre-existing backend `dist` permissions required direct project binaries; Expo simulator/device inspection was unavailable.
- [x] **Step 3: Inspect all four diffs and status.** Confirm no schema migration, credentials, unrelated edits, deployment, or production mutation. Summarize observed test results and remaining rollout steps to the user.
