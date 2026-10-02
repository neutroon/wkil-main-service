# Generic Store Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method remains the user's choice; do not dispatch agents merely because this header lists the available methods.

**Goal:** Standardize WKIL's generic integration and the reference store, with discoverable requirements, message-free validation, full-address variables, actionable errors, and durable delivery.

**Architecture:** Extend WKIL's existing signed API, event inbox, and BullMQ pipeline. Use one template-field registry and validation service for setup and sending. Add a transactional PostgreSQL outbox in the reference store and reuse both existing admin interfaces.

**Tech Stack:** Node/TypeScript, Express, Prisma 6, PostgreSQL, Redis/BullMQ, OpenAPI 3.1, Next.js 16, React, next-intl, Vitest, node:test/tsx, and existing browser-test tooling. No new service, broker, or SDK package.

**Spec:** `D:/wkil/back-end/docs/superpowers/specs/2026-10-02-generic-store-integration-design.md` (approved 2026-10-02).

**Completion update (2026-10-02):** The user subsequently authorized finishing
the local branches, including local commits and integration into main. This
supersedes the initial diff-only checkpoint restriction below. Implementation,
senior review and isolated PostgreSQL checks are complete; see
`docs/integrations/generic-store-verification.md` for evidence and environment
limits. Production deployment, live messaging and historical repair remain
separate unauthorized operations.

## Global Constraints

- Preserve schema version `1`, signed ingestion headers, decimal strings, E.164 phones, and `202 { accepted, duplicate, eventId }`.
- Keep all optional order properties optional globally; mapped template fields impose their own requirements.
- Preserve existing country values, legacy currency-to-quantity mappings, account-level template policy, and tenant boundaries.
- Add `shippingFullAddress`; never automatically replace saved `shippingCountry` mappings.
- Validation must never persist orders, enqueue messages, call Meta, create action tokens, or invoke callbacks.
- Freeze outgoing payload bytes when the first transport attempt starts; keep stable event IDs and refresh timestamps/signatures per attempt.
- Store dispatcher: startup and 10-second polling; maximum five claims per poll; two concurrent requests; two-minute leases; eight-second HTTP timeout.
- Store retries: ten attempts; initial five-second delay; maximum fifteen-minute backoff; jitter; bounded Retry-After; terminal retention thirty days.
- Stop permanent missing-data retries and preserve ambiguous Meta delivery protection.
- Preserve English/Arabic parity, responsive/RTL behavior, and readable field errors without sensitive values.
- Use npm in WKIL backend/store backend/store admin and pnpm in WKIL app; preserve all owned lockfiles.
- The initial execution used diff-only checkpoints. The later completion authorization permits local commits and main integration; pushes, deployment, publishing, credential rotation, production repair and database resets remain outside scope.
- Preserve the store's existing changes in `wkilWebhook.ts`, `wkilWebhook.test.ts`, `wkil.ts`, `wkil.test.ts`, and its two payload-audit documents.
- Editing `D:/zTechy Org/ecommerce-store` requires narrowly scoped filesystem escalation. Use a reviewed patch and preserve its original changes; stop only if approval review rejects it.
- Inspect existing worktrees and repository state before execution; use the worktree skill for isolation decisions. Existing store changes must be carried forward deliberately, never discarded or silently excluded.

## Review Focus

These five conditions need explicit tests in the owning tasks, beyond the straightforward success paths:

1. A template or locale changes after the developer tests it: live sending revalidates current policy (Tasks 2 and 4).
2. A timed-out store request was accepted remotely: replay identical event bytes; do not rebuild from an edited order (Tasks 8 and 10).
3. A secret rotates or a connection is disabled/retargeted while work is pending: read fresh credentials, pause disabled delivery, and block target mismatch (Tasks 3 and 10).
4. A worker finishes after its lease was reclaimed: stale completion cannot overwrite the new claimant (Task 8).
5. An order is deleted before an unsent event dispatches: retain safe audit state and block delivery rather than dereference a missing order (Tasks 9 and 10).

## Repository ownership and implementation map

Run every command from the repository identified in its task. Paths under a task are relative to that repository.

| Repository | Root | Responsibility |
| --- | --- | --- |
| WKIL backend | `D:/wkil/back-end` | Registry, signed setup API, diagnostics, contract assets |
| WKIL web | `D:/wkil/app` | Mapping, validation results, downloads, order errors |
| Store backend | `D:/zTechy Org/ecommerce-store/backend` | Canonical builder, outbox, dispatcher, admin API |
| Store admin | `D:/zTechy Org/ecommerce-store/admin` | Synthetic test results and delivery controls |

New WKIL files are divided into pure field/mapping logic, template validation,
signed setup transport, and generated integration assets. New store files divide
transport, persistence, and dispatcher lifecycle. Keep the existing large order
service intact except for a transaction-owned enqueue call and deletion handling.

Two connected workstreams are sequenced in one plan because the store consumes
the exact WKIL API/type decisions. WKIL can ship first without the new store
worker; the store must never silently revert to a live ingestion test.

## Interface definitions used by subsequent tasks

Define shared WKIL types in `orderConfirmation.integration.types.ts`:

```ts
type TemplateOrderInput = CanonicalOrder | Record<string, unknown>;
type TemplateVariableIssue = {
  component: "body"; placeholder: string; field: OrderTemplateField;
  paths: string[]; reason: "missing" | "blank" | "invalid";
};
type TemplateFieldDescriptor = {
  id: OrderTemplateField; labels: { en: string; ar: string };
  paths: string[]; requiredPaths: string[];
  rule: "nonblank" | "any-item-name" | "any-item-quantity" | "money" | "street-address";
};
type TemplateVariablePresence = Omit<TemplateVariableIssue, "reason"> & { present: boolean };
type TemplateInspection = {
  body: string[]; previewText: string;
  variables: TemplateVariablePresence[]; errors: TemplateVariableIssue[];
};
type OrderTemplateContext = {
  integrationId: number; businessProfileId: number;
  whatsappAccountId: number | null; defaultLocale: "ar" | "en";
};
type IntegrationFailure = {
  code: string; message: string; retryable: boolean;
  errors: Array<TemplateVariableIssue | { paths: string[]; reason: string }>;
};
type TemplateRequirements = {
  schemaVersion: "1"; supportedFields: TemplateFieldDescriptor[];
  template: { id: number; name: string; languageCode: string; locale: "ar" | "en";
    variableMapping: OrderTemplateMapping; variables: Omit<TemplateVariableIssue, "reason">[] };
};
type TemplateValidationData = {
  schemaVersion: "1"; schemaValid: true; templateReady: true;
  templateConfigId: number; templateName: string; languageCode: string;
  locale: "ar" | "en"; body: string[]; previewText: string;
  variables: TemplateVariablePresence[];
  buttons?: { confirm: string; cancel: string };
};
type TemplateValidationResult =
  | { status: 200; body: { data: TemplateValidationData } }
  | { status: 400 | 409 | 422; body: IntegrationFailure };
```

Requirements `variables` represent configured source requirements, not live-order
presence; omit `present` until an order has actually been inspected.
Validation supplies the actual presence result. Existing preview response properties remain available.

Store types live in `src/services/wkilIntegration.types.ts`. `WkilDeliveryState`
is `PENDING | SENDING | ACCEPTED | BLOCKED | EXHAUSTED`. `WkilSafeFailure` contains
`code`, `message`, `retryable`, and field errors, never an arbitrary provider body.
`WkilDeliverySummary` contains record/event/order IDs, state, attempts, scheduling
timestamps, failure information, and acceptance time; it excludes payloads,
customer details, target URL, and secrets. `WkilTestResult` contains
`remoteStatus`, `schemaValid`, `templateReady`, `message`, `requirements`, optional
`validation`, and optional `failure`.

---

### Task 1: Typed field registry and full address

**Repository:** WKIL backend.

**Files:** Create `src/modules/order-confirmation/orderConfirmation.fields.ts`,
`orderConfirmation.fields.test.ts`, `orderConfirmation.template-mapping.ts`, and
`orderConfirmation.integration.types.ts`. Modify `orderConfirmation.types.ts`,
`orderConfirmation.template.service.ts`, `orderConfirmation.template.service.test.ts`.

**Interfaces:**
- Produce `listOrderTemplateFields(): TemplateFieldDescriptor[]` and
  `renderOrderTemplateField(order: TemplateOrderInput, field: OrderTemplateField, locale: string): { text: string; reason?: TemplateVariableIssue["reason"] }`.
- Produce mapping exports `OrderTemplateMapping`,
  `getBodyMappingEntries(mapping): Array<{ placeholder: string; field: OrderTemplateField }>`,
  `validateOrderTemplateMapping(mapping: unknown, requireButtons?: boolean): OrderTemplateMapping`,
  and `orderTemplateUsesActions(mapping: unknown): boolean`.
- Re-export existing mapping symbols from template service for current callers.

- [ ] **Write regressions:** use direct canonical/snapshot fixtures; assert new address rendering and all old fields.
  ```ts
  expect(renderOrderTemplateField({ shippingAddress: { addressLine1: "Street 1\nApt 2", city: "Cairo", country: "Egypt" } }, "shippingFullAddress", "en").text).toBe("Street 1 Apt 2, Cairo, Egypt");
  expect(renderOrderTemplateField({ shippingAddress: { city: "Cairo" } }, "shippingFullAddress", "ar").reason).toBe("missing");
  ```
  Also pin Arabic separators, identical component suppression, no substring city extraction, zero totals, exact fractional quantity summation, unknown fields, old flat/array/body mappings, and legacy `currency` normalization.
- [ ] **Confirm failure:** `npm test -- src/modules/order-confirmation/orderConfirmation.fields.test.ts src/modules/order-confirmation/orderConfirmation.template.service.test.ts` must fail for absent new exports/field before implementation.
- [ ] **Implement:** move existing value readers/formatters into the pure registry, preserving behavior for present old fields; add field-specific availability rules. Keep mapping normalization independent of Prisma. Render the existing body through the registry rather than maintaining a second reader.
- [ ] **Verify and inspect:** rerun the focused command; require zero failures and inspect the diff for unrelated rendering changes.

### Task 2: Shared template resolution and readiness validation

**Repository:** WKIL backend. Depends on Task 1.

**Files:** Create `orderConfirmation.template-validation.service.ts` and `.test.ts`;
modify `orderConfirmation.template.service.ts`, `orderConfirmation.repository.ts`,
and `orderConfirmation.controller.ts`/`orderConfirmation.management.test.ts` for the existing test-event endpoint.

**Interfaces:**
- Produce `inspectOrderTemplateVariables(order, mapping, locale): TemplateInspection`.
- Produce `resolveOrderTemplateForIntegration(context: OrderTemplateContext, options?: { locale?: "ar" | "en"; templateConfigId?: number }): Promise<OrderTemplateConfig>`.
- Produce `getOrderTemplateRequirements(context, locale?): Promise<TemplateRequirements>` and
  `validateOrderEventForTemplate(event: unknown, context, options?: { locale?: "ar" | "en"; templateConfigId?: number; canonicalOnly?: boolean }): Promise<TemplateValidationResult>`.
- `canonicalOnly` defaults true for external validation. The existing authenticated test route passes false to preserve its documented raw-normalization preview behavior. It uses static preview button values, never generated action tokens.

- [ ] **Write regressions:** omitted country yields `422`, `TEMPLATE_DATA_INCOMPLETE`, placeholder `"5"`, path `order.shippingAddress.country`; city-only cannot satisfy full address. Empty mapping remains valid. Reject supplied blank strings through schema errors. Verify a changed template is re-resolved, locale fallback reports its actual locale, and template IDs from other accounts/profiles are inaccessible.
  ```ts
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ code: "TEMPLATE_DATA_INCOMPLETE", retryable: false, errors: [{ placeholder: "5", field: "shippingCountry", paths: ["order.shippingAddress.country"] }] });
  ```
- [ ] **Confirm failure:** `npm test -- src/modules/order-confirmation/orderConfirmation.template-validation.service.test.ts`.
- [ ] **Implement:** use one inspection path for requirements, previews, and live validation; resolve configured approved templates locally with the same account/profile/event/locale policy. Return `409` codes `WHATSAPP_ACCOUNT_NOT_CONFIGURED` or `TEMPLATE_NOT_CONFIGURED`; use `INVALID_ORDER_EVENT` for safe schema errors. Requirements must not claim to have inspected a live order.
- [ ] **Verify:** run the new tests plus `orderConfirmation.management.test.ts` and existing rendering/normalizer tests. Assert persistence writes, Meta, queue, callback, and action-token functions remain uncalled.

### Task 3: Signed developer setup endpoints

**Repository:** WKIL backend. Depends on Task 2.

**Files:** Create `orderConfirmation.setup.controller.ts`, `.test.ts`,
`orderConfirmation.setup-auth.ts`, `.test.ts`, and `orderConfirmation.setup-rateLimit.ts`, `.test.ts`.
Modify `orderConfirmation.public.routes.ts`, `orderConfirmation.repository.ts`, and `src/app.routes.test.ts`.

**Interfaces:**
- Produce `findOrderIntegrationForSetup(publicKey: string)` returning template context plus current/previous signing secrets and isActive; do not change the active-only ingestion lookup.
- Produce `authenticateOrderSetupRequest(req: Request): Promise<OrderTemplateContext>` and typed `OrderSetupHttpError(status, failure)`.
- Produce `acquireOrderSetupPermit(integrationId: number): Promise<number | null>` and controllers `getSignedOrderRequirements(req,res)`, `validateSignedOrderEvent(req,res)`.
- Expose POST `/:integrationKey/requirements` and `/:integrationKey/validate` under the existing raw-JSON public mount. Existing `/events` behavior remains intact.

- [ ] **Write transport/security tests:** same synthetic raw bytes signed with current and previous secrets; configured inactive setup succeeds but inactive ingestion remains unavailable. Unknown key `404`, invalid/expired signature `401`, malformed JSON `400`, mismatched validation idempotency header `400`, missing template `409`, missing mapped value `422`. Assert no side effects, no secrets, and no production record lookup in setup responses.
- [ ] **Confirm failure:** `npm test -- src/modules/order-confirmation/orderConfirmation.setup.controller.test.ts src/modules/order-confirmation/orderConfirmation.setup-auth.test.ts`.
- [ ] **Implement:** authenticate before template reads; enforce raw-body size using existing middleware and a setup-specific maximum of 256 KiB. Apply a Redis sliding-window limit of 30 authenticated setup requests per integration per minute; on Redis failure fail closed with retryable `503`, on limit return `429`/Retry-After. Return safe stable error envelopes and avoid logging body contents.
- [ ] **Verify:** new setup/auth/rate-limit tests, existing public ingestion tests, and app route mount tests; ensure raw parsers precede JSON parsing and existing duplicate `202` responses are unchanged.

### Task 4: Persistent live field errors and permanent failure handling

**Repository:** WKIL backend. Depends on Tasks 1–2.

**Files:** Modify `prisma/schema.prisma`; create
`prisma/migrations/20261002000000_order_notification_diagnostics/migration.sql`.
Modify `orderConfirmation.whatsapp.adapter.ts`/`.test.ts`, `orderConfirmation.service.ts`/`.test.ts`,
`orderConfirmation.repository.ts`/`.test.ts`, `orderConfirmation.controller.ts`,
and `orderConfirmation.management.test.ts`.

**Interfaces:**
- Add nullable `OrderNotification.failureCode String?` and `failureDetails Json?`.
- Produce `OrderTemplateDataIncompleteError extends Error` with code `TEMPLATE_DATA_INCOMPLETE` and safe `issues: TemplateVariableIssue[]`.
- Extend `markNotificationFailed(id: number, message: string, diagnostic?: { code: string; details: TemplateVariableIssue[] }): Promise<void>`.
- Managed notifications expose nullable `failureCode`/`failureDetails`, keeping `lastError` readable and existing properties stable.

- [ ] **Write regressions:** missing field produces FAILED + structured paths, zero Meta requests, zero provider-attempt increments, and no queued automatic retry. Snapshot the template/order again during manual retry; a fixed stored value clears diagnostics and sends once. Changing mapping to a newly missing field stops the next send. Preserve suppression, kill-switch, rate-limit and ambiguous-delivery cases.
- [ ] **Confirm failure:** focused adapter/service/repository/management tests must fail on absent diagnostics before code changes.
- [ ] **Implement:** run readiness validation before token preparation, rate permits, and provider attempts. Persist diagnostics and terminate the missing-data branch without rethrowing a retryable failure. Clear diagnostic fields when an attempt is requeued and when sent/delivered. Keep final failure details if revalidation still fails. Review additive SQL; run Prisma validation/generation with test placeholders, without applying a database migration.
- [ ] **Verify:** `npm test -- src/modules/order-confirmation/orderConfirmation.whatsapp.adapter.test.ts src/modules/order-confirmation/orderConfirmation.service.test.ts src/modules/order-confirmation/orderConfirmation.repository.test.ts src/modules/order-confirmation/orderConfirmation.management.test.ts`.

### Task 5: Classify definite Meta rejections without duplicate sends

**Repository:** WKIL backend. Depends on Task 4.

**Files:** Create `src/modules/meta/whatsapp/whatsapp.delivery-errors.ts` and `.test.ts`;
modify `whatsapp.service.ts`, add `whatsapp.service.template.test.ts`, and modify
`orderConfirmation.service.ts`/`.test.ts` and the adapter tests.

**Interfaces:**
- Produce `WhatsAppTemplateRejectedError extends AppError` with safe `providerCode?: number`, `httpStatus: number`, and `retryable: boolean`.
- `sendWhatsAppTemplate` retains its existing arguments/result but throws this subclass only for a definite non-success response; network/parse ambiguity still enters the existing ambiguous-send branch.

- [ ] **Write regressions:** code `131008` is permanent; retryable provider code takes precedence over an HTTP `400`; ordinary permanent `4xx` stops retries; explicit temporary rejection retries; network timeout never automatically resends. Assert raw provider body/trace/customer values are not exposed in order errors.
- [ ] **Confirm failure:** `npm test -- src/modules/meta/whatsapp/whatsapp.delivery-errors.test.ts src/modules/meta/whatsapp/whatsapp.service.template.test.ts`.
- [ ] **Implement:** consult Meta's current error-code reference and the installed integration retry policy; pin exact transient-code decisions in tests. Classify only verified transient Meta codes or transient HTTP responses. Return stable `WHATSAPP_TEMPLATE_REJECTED` messages; preserve safe internal diagnostics. The order service persists permanent rejection and returns; definite temporary rejection rethrows for existing bounded BullMQ retries.
- [ ] **Verify:** new Meta tests and order service/adapter tests. Confirm rate limiting and global queue attempts are unaffected.

### Task 6: OpenAPI, generated developer assets, and typed clients

**Repository:** WKIL backend, generated output in WKIL app. Depends on Tasks 1–5.

**Files:** Modify `docs/openapi.yaml`, `package.json`, and `orderConfirmation.routes.ts`/controller;
create `docs/integrations/generic-store.md`, `docs/integrations/generic-store.example.json`,
`scripts/generate-order-integration-assets.js`, `scripts/generate-order-integration-assets.test.js`,
`orderConfirmation.integration-assets.generated.ts`, and `orderConfirmation.contract.test.ts`.
Regenerate `D:/wkil/app/src/types/openapi.generated.ts` using the owned command.

**Interfaces:**
- GET `/v1/order-confirmations/fields` returns `{data: TemplateFieldDescriptor[]}` through the authenticated mount.
- GET `/v1/order-confirmations/schema` returns the standalone event JSON Schema; GET `/v1/order-confirmations/integration-guide` returns the generic developer guide as a Markdown attachment. Neither contains credentials or tenant records.
- Generator exports `ORDER_EVENT_JSON_SCHEMA`, `ORDER_INTEGRATION_GUIDE`, and `ORDER_EVENT_TYPESCRIPT_EXAMPLE` from a generated TS module bundled by the normal build. The schema uses `$defs` for reachable canonical components; rewrite OpenAPI component references mechanically. Examples/types derive from OpenAPI, never a second handwritten canonical type.

- [ ] **Write conformance tests:** generated schema and runtime canonical parser agree on synthetic valid payloads, fractional money, phones, omitted country/items, supplied blanks, unknown properties, and wrong version. Compare registry IDs with the OpenAPI enum. Assert downloaded docs contain setup URLs/error examples and no live credentials; no generated stale assets survive a `--check` run.
- [ ] **Confirm failure:** `npm test -- src/modules/order-confirmation/orderConfirmation.contract.test.ts` and `node --test scripts/generate-order-integration-assets.test.js`.
- [ ] **Implement:** document both signed endpoints, response schemas, field descriptors, diagnostics, and managed catalog/download routes. Add `integration:assets` and `integration:assets:check` scripts; generate before TypeScript build and verify determinism. Use existing YAML/Ajv tooling and installed openapi-typescript for generated type examples; consult its exact API if used programmatically. Correct any demonstrated canonical pattern drift instead of copying it into downloads.
- [ ] **Verify/regenerate:** `npm run integration:assets`, `npm run integration:assets:check`, `npm run docs:check`, `npm run types:api`; inspect generated client diff and run conformance/management route tests. Do not hand-edit generated modules.

### Task 7: WKIL mapping, setup results, and order diagnostics

**Repository:** WKIL app. Depends on Task 6.

**Files:** Modify `src/lib/order-confirmation-api.ts`/`.test.ts`,
`src/hooks/integrations/useOrderConfirmations.ts`, `integrations.keys.ts`, and `index.ts`;
modify `OrderConfirmationTemplateForm.tsx`/`.test.ts`,
`OrderConfirmationIntegrationForm.tsx`, `OrderDetailView.tsx`/`.test.ts`,
`messages/ar/integrations.json`, and `messages/en/integrations.json`.
Create `OrderConfirmationIntegrationForm.test.tsx` and `OrderTemplateValidationResult.tsx`/`.test.ts` under the existing order-confirmations component directory.

**Interfaces:**
- Derive `OrderTemplateField`, descriptor and diagnostic types from generated OpenAPI components; preserve existing exported names.
- Add `OrderConfirmationsService.listTemplateFields(signal?: AbortSignal)` and `downloadIntegrationAsset(kind: "schema" | "guide", signal?: AbortSignal): Promise<Blob>`.
- Add `useOrderTemplateFields(enabled?: boolean)` with a field-catalog query key and five-minute stale time.
- `OrderTemplateValidationResult({result, errors, locale})` accepts the generated preview/error types; renders field identities and missing values, not raw JSON-only feedback.

- [ ] **Write UI/API tests:** catalog supplies full address; stored country selection is unchanged. A `422` preview shows `{{5}}`, Shipping Country/بلد الشحن and its path; a `200` response shows actual resolved locale. Missing catalog shows a retryable loading/error state. Downloads use authenticated client calls, never a copied signing secret. Order details show structured errors alongside legacy messages in both languages; late responses do not overwrite a newer template selection.
- [ ] **Confirm failure:** `pnpm test -- src/components/user/order-confirmations/OrderConfirmationTemplateForm.test.tsx src/components/user/order-confirmations/OrderDetailView.test.tsx src/lib/order-confirmation-api.test.ts`.
- [ ] **Implement:** consume backend field descriptions in selectors; retain local synthetic sample value rendering for preview without duplicate availability rules. Use server validation results for readiness and preserve abort/query-cache patterns. Show guide/schema downloads and explain account-level template scope in setup. Do not move existing client forms into new route handlers or ship secrets in the browser.
- [ ] **Verify:** focused tests plus `pnpm lint` and `pnpm exec tsc --noEmit`. During execution, discover Next DevTools runtime and inspect changed screens with synthetic fixture responses, including Arabic/RTL and loading/error states.

### Task 8: Store outbox persistence and safe claims

**Repository:** Store backend. Can begin after WKIL contract interfaces are fixed.

**Files:** Modify `prisma/schema.prisma`; create
`prisma/migrations/20261002000000_add_wkil_outbox/migration.sql`,
`src/services/wkilIntegration.types.ts`, `wkilOutbox.repository.ts`/`.test.ts`.

**Interfaces:**
- Add `WkilOutbox` mapped to `wkil_outbox`: id, unique eventId, nullable orderId relation with SetNull, rawBody nullable text, targetIdentity string, state enum, attemptCount default 0, nextAttemptAt, leaseToken/leaseExpiresAt, safe failure JSON/code, created/updated/accepted timestamps. Index `(state,nextAttemptAt)` and `(state,leaseExpiresAt)`.
- Produce `insertWkilOutbox(tx: Prisma.TransactionClient, input: NewWkilOutbox): Promise<void>`,
  `claimWkilOutbox(now: Date, limit: number, token: string, leaseMs: number): Promise<ClaimedWkilDelivery[]>`,
  `beginWkilAttempt(id: string, token: string): Promise<boolean>`,
  `finishWkilAttempt(id: string, token: string, outcome: WkilDeliveryOutcome): Promise<boolean>`.
- `ClaimedWkilDelivery` carries stored rawBody, targetIdentity, source order reference, attemptCount and lease token. `WkilDeliveryOutcome` discriminates ACCEPTED, BLOCKED, EXHAUSTED, or PENDING with safe failure/nextAttemptAt.

- [ ] **Write repository regressions:** a unique event can be inserted once, claims are atomic and skip locked rows, expired leases are reclaimed, attempt increment occurs immediately before transport, stale tokens cannot update a record, and rawBody cannot change after an attempt begins.
  ```ts
  assert.equal(await finishWkilAttempt(id, 'expired-token', accepted), false);
  assert.equal(current.state, 'SENDING');
  assert.equal(current.leaseToken, 'new-token');
  ```
- [ ] **Confirm failure:** `node --import tsx --test src/services/wkilOutbox.repository.test.ts` under test-only environment values.
- [ ] **Implement:** use parameterized Prisma 6 SQL for a bounded `FOR UPDATE SKIP LOCKED` claim/update, fixed table identifiers, and compare-and-set lease completion. Use the installed v6 transaction/raw-query API, not current Prisma 8 examples. Store frozen canonical JSON bytes, not secrets. Review additive SQL; generate the client without applying migrations.
- [ ] **Verify:** repository tests and TypeScript compile. Real PostgreSQL concurrency checks require an explicitly authorized isolated test target; otherwise report locking verification as unperformed rather than claiming mocks prove database behavior.

### Task 9: Enqueue atomically with store order creation

**Repository:** Store backend. Depends on Task 8.

**Files:** Modify `src/services/orderService.ts`/`.test.ts`,
`src/services/wkilWebhook.ts`/`.test.ts`, `src/routes/orders.ts`,
`src/routes/abandoned-carts.ts`, and `src/routes/wkil-hook.test.ts`.
Create `src/services/wkilOutbox.enqueue.ts`/`.test.ts`.

**Interfaces:**
- Export the existing builder input type as `WkilOrderInput`.
- Produce `enqueueWkilOrderCreated(tx: Prisma.TransactionClient, order: WkilOrderInput): Promise<void>`.
- Produce `connectionIdentity(url: string): string` as SHA-256 of a normalized configured ingestion URL, excluding secret; helper lives in `wkilWebhook.ts` and is shared with dispatcher checks.

- [ ] **Write transaction tests:** one new checkout/conversion creates one outbox record through the caller's tx; idempotent replay creates none; disabled integration creates none. Builder errors create a BLOCKED zero-attempt record and still allow order commit. A failed database outbox write aborts the transaction. Deleting an order blocks unsent work and invalidates its lease while retaining safe event metadata.
- [ ] **Confirm failure:** focused enqueue, orderService, and wkil-hook tests; missing outbox expectations must fail before replacing notification calls.
- [ ] **Implement:** read connection settings through the transaction client; build the existing complete payload and insert with stable `order-created:<orderId>`. Do not call fetch inside a transaction. Remove post-commit `void notifyOrderCreated` from checkout/conversion once both transaction paths enqueue. Preserve unrelated purchase notifications. In deleteOrder's transaction, mark active outbox rows BLOCKED/SOURCE_ORDER_DELETED and release claims before deleting; accepted audit rows use SetNull.
- [ ] **Verify:** `node --import tsx --test --test-concurrency=1 src/services/wkilOutbox.enqueue.test.ts src/services/orderService.test.ts src/routes/wkil-hook.test.ts src/services/wkilWebhook.test.ts`; confirm no direct ingestion request remains in checkout hooks.

### Task 10: Signed transport and durable store dispatcher

**Repository:** Store backend. Depends on Tasks 8–9.

**Files:** Create `src/services/wkilTransport.ts`/`.test.ts`,
`wkilOutbox.worker.ts`/`.test.ts`; modify `wkilWebhook.ts`, `src/server.ts`, and store `package.json` to include new focused tests.

**Interfaces:**
- Produce `postSignedWkilRequest(url: string, secret: string, rawBody: string, options?: { eventId?: string; fetchImpl?: typeof fetch; nowSeconds?: () => number; timeoutMs?: number }): Promise<WkilTransportResult>`.
- Result contains status, parsed safe response, and bounded retryAfterMs; unexpected bodies yield a stable error, never an unfiltered log. One call equals one attempt; the dispatcher owns retries.
- Produce `createWkilOutboxWorker(deps: { repository, getConfig, transport, clock, random, logger }): { start(): void; stop(): Promise<void>; runOnce(): Promise<void> }`.
- Produce `computeWkilBackoffMs(attempt: number, random: () => number, retryAfterMs?: number): number`.

- [ ] **Write transport/worker regressions:** sign exact frozen bytes with a fresh timestamp; honor eight-second abort. Replay a timed-out accepted request with identical event/body; later order edits cannot change it. Use a newly rotated secret next attempt. Disabled config pauses; changed identity blocks without fetch. Bound five claims/two requests, prevent overlapping polls, reclaim expired leases, and obey stale completion guards. Check source deletion before transport. Terminal cleanup excludes PENDING/SENDING and preserves safe status when payload bytes are cleared after thirty days.
- [ ] **Confirm failure:** `node --import tsx --test src/services/wkilTransport.test.ts src/services/wkilOutbox.worker.test.ts`.
- [ ] **Implement:** startup/10-second polling; claim two-minute leases; increment attempts by token CAS then call transport. Retry network,408,429,5xx with ten-attempt cap. Use ±20% jitter around exponential delay and clamp final delay/Retry-After to fifteen minutes; no zero-delay busy loops. Ordinary 4xx block; attempt ten temporary failure exhausts. Cleanup terminal payload bytes in bounded batches. Start worker only after DB connection and stop it before Prisma disconnect; tests instantiate worker with mocks instead of starting a real server.
- [ ] **Verify:** new tests, original sender tests updated to the single-attempt contract, and `npm run build`. Remove the obsolete in-memory retry loop so only one layer controls outgoing retries.

### Task 11: Store synthetic setup test and safe delivery admin API

**Repository:** Store backend. Depends on Tasks 3,6,10.

**Files:** Modify `src/routes/wkil.ts`/`.test.ts`;
create `src/services/wkilConnectionTest.ts`/`.test.ts`;
extend `wkilOutbox.repository.ts`/`.test.ts`, store test scripts, and `docs/wkil-order-payload.md`.

**Interfaces:**
- Produce `testWkilConnection(config: WkilConfig, options?: {fetchImpl?: typeof fetch}): Promise<WkilTestResult>`.
- POST existing `/v1/settings/wkil/test` calls signed requirements then validation with a complete synthetic payload from the real builder. Derive setup URLs only from a parsed canonical ingestion URL, not unchecked string replacement.
- GET `/v1/settings/wkil/deliveries?state=<state>&limit=<1..25>` returns `{counts,deliveries: WkilDeliverySummary[]}`.
- POST `/v1/settings/wkil/deliveries/:id/retry` returns `{id,state:"PENDING"}` or a safe `409`; preserve existing admin-only authorization.
- Produce repository `listWkilDeliveries(filters)` and `requeueWkilDelivery(id, expectedTargetIdentity, now): Promise<boolean>` guarded against accepted/currently leased work.

- [ ] **Write route tests:** no /events call in connection tests, `422` details survive safe parsing, `200` schema success but false readiness is not a successful test. Missing setup endpoints return WKIL_UPGRADE_REQUIRED without a live-send fallback. Non-admin cannot inspect/retry; responses contain no payload/customer/secret/URL. Accepted and active leases cannot be retried, changed target requires explicit recovery, and unsent blocked draft may rebuild from corrected source fields before validation.
- [ ] **Confirm failure:** focused route/connection/repository tests.
- [ ] **Implement:** validate retry payload through WKIL setup before releasing it; attempted rows reuse frozen rawBody. Unknown outcomes stay immutable. Connection configuration errors produce readable setup results, not false success. Keep historical accepted-event data repair out of retry. Update store-local documentation to explain acceptance vs WhatsApp delivery and how to recover BLOCKED/EXHAUSTED records.
- [ ] **Verify:** `node --import tsx --test --test-concurrency=1 src/routes/wkil.test.ts src/services/wkilConnectionTest.test.ts src/services/wkilOutbox.repository.test.ts`.

### Task 12: Reference-store admin diagnostics

**Repository:** Store admin. Depends on Task 11.

**Files:** Modify `src/lib/api.ts`, `app/dashboard/integrations/page.tsx`,
`src/i18n/ar.ts`, `src/i18n/en.ts`, and `package.json`;
create `src/components/integrations/WkilIntegrationCard.tsx`,
`WkilValidationResults.tsx`, `WkilDeliveryList.tsx`, and `scripts/wkil-integration.test.mjs`.

**Interfaces:**
- Extend `wkilApi.sendTest(): Promise<WkilTestResult>` and add
  `wkilApi.listDeliveries(filters): Promise<{counts;deliveries:WkilDeliverySummary[]}>`,
  `wkilApi.retryDelivery(id: string): Promise<{id:string;state:"PENDING"}>`.
- Extract the existing WkilCard into `WkilIntegrationCard`; preserve its settings/secret behavior and the page's unrelated integration sections.

- [ ] **Write browser regressions:** synthetic API interception on a local preview; false readiness never shows success; country/full-address field paths are visible; retry only available for safe eligible states; duplicate clicks produce one request; accepted vs delivered is clear; errors are announced accessibly; Arabic/RTL and mobile layout remain readable; credentials are not printed or included in diagnostic output.
- [ ] **Confirm failure:** start a fixture-backed local admin preview, then `node --test scripts/wkil-integration.test.mjs`; new assertions fail against the old remoteStatus-only card.
- [ ] **Implement:** typed validation results and safe delivery list/counts; explicit retry, loading/error/empty states, request cancellation on unmount, and refreshed statuses after retry. Add `test:wkil` script using installed Playwright. Use existing styling/i18n conventions.
- [ ] **Verify:** `npm run test:wkil`, `npx tsc --noEmit`, `npm run build`, and relevant UI tests. Run repository lint and disclose its existing `next lint`/Next16 incompatibility if still present; do not silently claim lint passed or upgrade the framework. Use Next DevTools/browser runtime evidence for changed screens.

### Task 13: Cross-repository proof, documentation, and release handoff

**Repositories:** All four. Depends on Tasks 1–12.

**Files:** Create store backend `src/services/wkilContract.integration.test.ts`;
modify backend `docs/integrations/generic-store.md`, reference store payload docs,
and each changed manifest's focused test commands as necessary. Update the approved
spec only to record implemented interfaces or a separately approved scope change.

**Interfaces:** Test actual store payload builder -> WKIL parser/registry/readiness;
use local dependency injection/mocks to avoid Meta, production databases, and live credentials. The external WKIL source path is explicit via a test-only
`WKIL_CONTRACT_PROJECT_PATH` defaulting to `D:/wkil/back-end`; it never affects production code or builds.

- [ ] **Write end-to-end assertions:** synthetic two-item Egypt order produces every supported variable in both locales; removing country passes base schema but fails mapped readiness at the right placeholder; street alone supports full address while city alone fails it. Repeat signed ingestion yields one accepted workflow; validation reserves no event ID and sends nothing. Fake a store crash after acceptance and prove its next delivery uses the same bytes/ID. Include real browser fixture results for both admin interfaces.
- [ ] **Run/complete conformance:** cross-repo test, generated asset `--check`, all focused regression suites; review fixture/module loading so it actually executes both repositories' implementations rather than reproducing them.
- [ ] **Run required broader checks once focused tests pass:**
  - WKIL backend: `npm test`, `npm run docs:check`, `npm run integration:assets:check`, `npm run build`.
  - WKIL app: `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`.
  - Store backend: `npm test`, `npm run build`.
  - Store admin: `npm run test:ui`, `npm run test:wkil`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.
  Inspect every exit code; record baseline failures separately. Do not rerun successful broad checks without new changes or a concrete unresolved issue.
- [ ] **Review migrations and final diffs:** additive WKIL columns/store outbox only; no secrets, production fixtures, generated drift, tenant leaks, double checkout sends, or deleted user changes. Obtain independent final code review through the execution workflow selected by the user. No git integration actions are authorized.
- [ ] **Prepare handoff:** document ordered deployment (WKIL migration/backend -> WKIL web -> store migration/backend worker -> store admin), generated-client compatibility, missing-endpoint behavior, leases/retries/retention, and rollback limitations. Leave deployment and production order2069 repair for separate explicit authorization.

## Scope and review checkpoint

This plan implements the approved generic/reference-store release. Shopify,
WooCommerce, public SDK publishing, per-store template overrides for a shared
WhatsApp account, and a generalized accepted-order reconciliation API remain
deferred. Local compatibility checks and synthetic delivery do not prove production deployment.

Planning self-review: every specification section maps to the tasks above;
shared types are defined before consumption; permanent vs ambiguous failures and
zero-attempt vs attempted payload edits have explicit boundaries. Model/version
decisions use installed Prisma6/Next16 documentation, not unrelated latest APIs.

Execution started with native implementation following the user’s approval and
instruction to continue. The required final independent review covers all four
repositories; no Git integration or deployment is authorized.
