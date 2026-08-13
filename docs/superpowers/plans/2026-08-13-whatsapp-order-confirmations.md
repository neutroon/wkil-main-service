# WhatsApp Order Confirmations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-neutral, duplicate-safe order-confirmation workflow that receives signed `order.created` events, sends configurable WhatsApp Confirm/Cancel templates, records the first customer response, and optionally synchronizes the source store.

**Architecture:** Add a modular `order-confirmation` domain to the existing Express/Prisma backend. Use a versioned canonical event contract, PostgreSQL inbox/order state, a dedicated BullMQ queue on the existing Redis deployment, the existing WhatsApp Cloud API account/message infrastructure, and a generic signed outbound status callback before adding native platform adapters.

**Tech Stack:** Node.js, TypeScript, Express 5, Prisma 6, PostgreSQL, Zod 4, BullMQ 5, Redis, Meta WhatsApp Cloud API, Next.js 15, React 19, TanStack Query, next-intl, Vitest, OpenAPI 3.1.

## Global Constraints

- The implementation is a modular monolith inside the existing backend.
- Initial trigger: every accepted `order.created` event.
- Unanswered orders remain `AWAITING_CONFIRMATION` indefinitely.
- The first valid Confirm or Cancel response wins.
- Store synchronization is optional per business and never rolls back the local customer response.
- Use existing approved WABA templates and map canonical order fields; do not send arbitrary unapproved per-order text.
- Select the customer locale first and the business default locale as fallback.
- Do not require a customer consent checkbox, consent link, or consent field in this release; still honor opt-outs and suppress future messages.
- Use HMAC-SHA256 over `${timestamp}.${rawRequestBody}` with constant-time comparison and replay protection.
- Persist a valid inbound event before returning `202`; never call Meta or a store API in the request path.
- Use the existing token encryption, authentication, business-profile authorization, Redis, BullMQ, Sentry, OpenAPI, and generated frontend-type workflows.
- Keep the backend and frontend Git repositories separate. Stage backend files only in `back-end` and frontend files only in `app`.

---

## File Map

### Backend Repository: `back-end`

Create:

- `src/modules/order-confirmation/orderConfirmation.types.ts` - canonical event, job, template, action, and API types.
- `src/modules/order-confirmation/orderConfirmation.validation.ts` - Zod schemas for canonical events, integration settings, template mappings, filters, and callbacks.
- `src/modules/order-confirmation/orderConfirmation.crypto.ts` - HMAC signatures, timestamp checks, action-token generation, and hashing.
- `src/modules/order-confirmation/orderConfirmation.normalizer.ts` - canonical event parsing, phone validation, money normalization, and locale normalization.
- `src/modules/order-confirmation/orderConfirmation.repository.ts` - Prisma reads, writes, idempotency, and conditional state transitions.
- `src/modules/order-confirmation/orderConfirmation.template.service.ts` - approved-template lookup, field mappings, validation, and variable rendering.
- `src/modules/order-confirmation/orderConfirmation.service.ts` - event processing, notification orchestration, action handling, acknowledgement scheduling, and suppression.
- `src/modules/order-confirmation/orderConfirmation.queue.ts` - dedicated queue, job types, deterministic job IDs, and enqueue helpers.
- `src/modules/order-confirmation/orderConfirmation.worker.ts` - queue worker dispatch and recovery scanning.
- `src/modules/order-confirmation/orderConfirmation.rateLimit.ts` - per-business Redis send permits.
- `src/modules/order-confirmation/orderConfirmation.store.adapter.ts` - generic signed status callback adapter.
- `src/modules/order-confirmation/orderConfirmation.whatsapp.adapter.ts` - WhatsApp template/text delivery adapter using existing Meta services.
- `src/modules/order-confirmation/orderConfirmation.whatsapp.parser.ts` - extraction of WhatsApp interactive replies and opt-out text.
- `src/modules/order-confirmation/orderConfirmation.public.controller.ts` - unauthenticated signed event intake.
- `src/modules/order-confirmation/orderConfirmation.public.routes.ts` - public event route.
- `src/modules/order-confirmation/orderConfirmation.controller.ts` - authenticated settings, templates, orders, test-event, and retry endpoints.
- `src/modules/order-confirmation/orderConfirmation.routes.ts` - authenticated management routes.
- `src/modules/order-confirmation/orderConfirmation.crypto.test.ts` - signature, replay, and action-token tests.
- `src/modules/order-confirmation/orderConfirmation.validation.test.ts` - request and canonical-schema validation tests.
- `src/modules/order-confirmation/orderConfirmation.normalizer.test.ts` - canonical payload and phone/money tests.
- `src/modules/order-confirmation/orderConfirmation.repository.test.ts` - idempotency and state-transition tests.
- `src/modules/order-confirmation/orderConfirmation.public.controller.test.ts` - signed webhook HTTP tests.
- `src/modules/order-confirmation/orderConfirmation.queue.test.ts` - job IDs and enqueue options.
- `src/modules/order-confirmation/orderConfirmation.rateLimit.test.ts` - tenant send-limit behavior.
- `src/modules/order-confirmation/orderConfirmation.service.test.ts` - event, notification, action, and suppression tests.
- `src/modules/order-confirmation/orderConfirmation.management.test.ts` - management authorization, settings, and retry tests.
- `src/modules/order-confirmation/orderConfirmation.store.adapter.test.ts` - callback success, retry, and SSRF tests.
- `src/modules/order-confirmation/orderConfirmation.whatsapp.parser.test.ts` - interactive reply and opt-out parsing tests.
- `src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts` - Meta webhook routing and opt-out integration tests.

Modify:

- `prisma/schema.prisma` - order-confirmation enums, models, and relations.
- `prisma/migrations/20260813000000_add_order_confirmations/migration.sql` - generated database migration.
- `src/app.ts` - raw-body public webhook middleware and public/protected route mounts.
- `src/server.ts` - order queue startup and graceful worker shutdown.
- `src/middlewares/rateLimit.middleware.ts` - public order-webhook limiter.
- `src/app.routes.test.ts` - route mount ordering and public/protected coverage assertions.
- `src/modules/meta/whatsapp/whatsapp.controller.ts` - route interactive button payloads into the order action queue.
- `src/modules/meta/core/metaProcessor.service.ts` - process order actions before AI and record opt-outs.
- `docs/openapi.yaml` - public and authenticated order-confirmation contracts.

Generated or synchronized:

- `dist/openapi.json` - generated by the backend docs bundle command if tracked by the repository.
- `../app/src/types/openapi.generated.ts` - generated by `npm run types:api` and committed in the frontend repository.

### Frontend Repository: `app`

Create:

- `src/lib/order-confirmation-api.ts` - typed API client and domain response types.
- `src/hooks/integrations/useOrderConfirmations.ts` - TanStack Query settings, templates, orders, and retry hooks.
- `src/app/[locale]/(protected)/user/(dashboard)/channels/order-confirmations/page.tsx` - protected route entry.
- `src/components/user/OrderConfirmationSettings.tsx` - settings, template mapping, test event, and status panels.
- `src/components/user/order-confirmations/OrderConfirmationIntegrationForm.tsx` - webhook and store-sync configuration.
- `src/components/user/order-confirmations/OrderConfirmationTemplateForm.tsx` - approved-template selection and variable mapping.
- `src/components/user/order-confirmations/OrderConfirmationOrders.tsx` - order status and retry operations.

Modify:

- `src/lib/config.ts` - order-confirmation API paths and URL builders.
- `src/hooks/integrations/integrations.keys.ts` - order-confirmation query keys.
- `src/hooks/integrations/index.ts` - export the new hooks.
- `src/app/[locale]/(protected)/user/(dashboard)/channels/layout.tsx` - add the Order Confirmations channel tab.
- `src/app/[locale]/(protected)/user/(dashboard)/channels/page.tsx` - add the Order Confirmations overview card.
- `messages/en/integrations.json` - English labels, help text, errors, statuses, and controls.
- `messages/ar/integrations.json` - Arabic translations for the same keys.

---

### Task 1: Define Canonical Contracts And Pure Security Helpers

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.types.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.validation.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.crypto.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.normalizer.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.crypto.test.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.normalizer.test.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.validation.test.ts`

**Interfaces:**
- Produces `CanonicalOrderEvent`, `CanonicalOrder`, `OrderAction`, `OrderConfirmationJob`, `OrderActionInput`, and `OrderTemplateField` for downstream tasks.
- Produces `parseCanonicalOrderEvent(input: unknown): CanonicalOrderEvent`.
- Produces `normalizeCanonicalOrderEvent(input: unknown): CanonicalOrderEvent`.
- Produces `normalizeE164Phone(phone: string): string` that validates but does not guess a missing country code.
- Produces `computeOrderWebhookSignature(timestamp: string, rawBody: Buffer, secret: string): string`.
- Produces `verifyOrderWebhookSignature(params: { rawBody: Buffer; timestamp: string | undefined; signature: string | undefined; secret: string; nowSeconds?: number; toleranceSeconds?: number }): boolean`.
- Produces `issueOrderActionToken(): { token: string; tokenHash: string }` and `hashOrderActionToken(token: string): string`.

- [ ] **Step 1: Write failing crypto tests.**

Add tests that assert a valid `v1=<hex>` signature is accepted, a tampered raw body is rejected, a wrong secret is rejected, malformed headers are rejected, a timestamp outside the five-minute default window is rejected, a future timestamp outside the window is rejected, action tokens are high-entropy, and only hashes are intended for persistence.

```ts
it("verifies the exact raw body and rejects replayed timestamps", () => {
  const rawBody = Buffer.from('{"eventId":"evt_1"}', "utf8");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeOrderWebhookSignature(timestamp, rawBody, "secret");

  expect(verifyOrderWebhookSignature({
    rawBody,
    timestamp,
    signature,
    secret: "secret",
  })).toBe(true);

  expect(verifyOrderWebhookSignature({
    rawBody: Buffer.from('{"eventId":"evt_2"}', "utf8"),
    timestamp,
    signature,
    secret: "secret",
  })).toBe(false);
});
```

- [ ] **Step 2: Run the focused crypto tests and confirm failure.**

Run from `back-end`:

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.crypto.test.ts
```

Expected: FAIL because the new module exports do not exist.

- [ ] **Step 3: Implement the crypto helpers.**

Use Node `crypto.createHmac`, `timingSafeEqual`, and `randomBytes`. Sign `${timestamp}.${rawBody.toString("utf8")}`. Require `X-Wkil-Signature` to match `v1=<hex>`, parse a numeric Unix timestamp, compare the absolute age to `toleranceSeconds`, and compare equal-length digests with `timingSafeEqual`. Hash action tokens with SHA-256. Do not log raw secrets or tokens.

- [ ] **Step 4: Write failing canonical-schema tests.**

Cover the minimum fields, `order.created` only, `eventId` and order IDs, ISO `occurredAt`, E.164 phone validation, ISO currency, decimal-safe totals, optional locale/items/address, rejection of missing phone, rejection of non-E.164 phone, and rejection of unsupported event types.

- [ ] **Step 5: Implement the Zod schemas and normalizer.**

Accept numeric or string input for `total` only at the boundary, convert it to a normalized decimal string, preserve line-item values as decimal strings, trim display strings, validate `locale` as `ar` or `en` when present, and return a strongly typed `CanonicalOrderEvent`. Reject arbitrary event types instead of silently ignoring them.

Use the following action and field types plus canonical job union so queue and worker code share one contract:

```ts
export type OrderAction = "CONFIRM" | "CANCEL";

export type OrderTemplateField =
  | "customerName"
  | "orderNumber"
  | "itemSummary"
  | "total"
  | "currency"
  | "shippingCity"
  | "shippingCountry";

export type OrderActionInput = {
  businessProfileId: number;
  phoneNumberId: string;
  customerPhone: string;
  actionToken: string;
  inboundMessageId?: string;
  buttonTitle?: string;
  correlationId: string;
};

export type OrderConfirmationJob =
  | { type: "PROCESS_EVENT"; eventId: number; correlationId: string }
  | { type: "SEND_NOTIFICATION"; notificationId: number; correlationId: string }
  | ({ type: "PROCESS_ACTION" } & OrderActionInput)
  | { type: "SYNC_STORE"; syncId: number; correlationId: string };
```

- [ ] **Step 6: Run all pure contract tests and commit.**

Run:

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.crypto.test.ts src/modules/order-confirmation/orderConfirmation.normalizer.test.ts src/modules/order-confirmation/orderConfirmation.validation.test.ts
```

Expected: PASS. Commit in `back-end`:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.types.ts src/modules/order-confirmation/orderConfirmation.validation.ts src/modules/order-confirmation/orderConfirmation.crypto.ts src/modules/order-confirmation/orderConfirmation.normalizer.ts src/modules/order-confirmation/*.test.ts
$ git commit -m "feat(order-confirmations): add canonical contracts and signing helpers"
```

---

### Task 2: Add Prisma Models, Relations, And Migration

**Files:**
- Modify: `back-end/prisma/schema.prisma`
- Create: `back-end/prisma/migrations/20260813000000_add_order_confirmations/migration.sql`

**Interfaces:**
- Produces Prisma models `OrderIntegration`, `OrderEvent`, `Order`, `OrderNotification`, `OrderActionToken`, `OrderStoreSync`, `OrderTemplateConfig`, and `WhatsAppSuppression`.
- Produces enums `OrderEventProcessingStatus`, `OrderStatus`, `OrderNotificationKind`, `OrderNotificationStatus`, `OrderStoreSyncStatus`, and `OrderAction`.
- Adds relation arrays to `BusinessProfile`, `WhatsAppAccount`, and `ConversationMessage` without changing existing message behavior.

- [ ] **Step 1: Add the enums and model relations to `schema.prisma`.**

Use Prisma enums for bounded internal states. Add `businessProfileId` to every tenant-owned record. Set `OrderIntegration.isActive` to `false` by default so activation is explicit. Store raw payloads as nullable `Json`, line items, address, metadata, and rendered variables as `Json`. Store money as `Decimal`. Add a `rawPayloadRetentionUntil` timestamp and purge raw payload bodies after 30 days while retaining normalized audit fields. Encrypt secrets before persistence. Add these constraints:

```prisma
@@unique([integrationId, externalEventId])
@@unique([integrationId, externalOrderId])
@@unique([orderId, kind])
@@unique([orderId, action])
@@unique([orderId, requestedStatus])
@@unique([businessProfileId, normalizedPhone])
```

Use `onDelete: Cascade` for business-owned records and `onDelete: SetNull` for optional conversation-message links. Add indexes on `(businessProfileId, status, updatedAt)`, `(integrationId, status, receivedAt)`, `(orderId, status)`, and `(whatsappAccountId, eventType, locale, isActive)`.

- [ ] **Step 2: Format and generate the Prisma client.**

Run from `back-end`:

```bash
npm run prisma:generate
npx prisma format
```

Expected: Prisma schema formatting succeeds and the generated client exposes every new model and enum.

- [ ] **Step 3: Create the migration and inspect the SQL.**

Run:

```bash
npx prisma migrate dev --name add_order_confirmations
```

Keep the generated SQL in `prisma/migrations/20260813000000_add_order_confirmations/migration.sql` and inspect that it creates the enums, tables, foreign keys, unique constraints, and indexes without modifying unrelated tables. Run:

```bash
npm run prisma:migrate:status
```

Expected: the new migration is applied or listed as the only pending migration in a clean development database.

- [ ] **Step 4: Commit the schema and migration.**

```bash
$ git add prisma/schema.prisma prisma/migrations/20260813000000_add_order_confirmations/migration.sql
$ git commit -m "feat(order-confirmations): add order persistence models"
```

---

### Task 3: Build The Dedicated BullMQ Queue

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.queue.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.queue.test.ts`

**Interfaces:**
- Consumes `OrderConfirmationJob` from Task 1 and `bullConnection`/`bullQueuePrefix` from `src/config/redis.ts`.
- Produces `orderConfirmationQueue`, `createOrderConfirmationJobId(job)`, `enqueueOrderEvent(eventId, correlationId)`, `enqueueNotification(notificationId, correlationId)`, `enqueueOrderAction(input)`, and `enqueueStoreSync(syncId, correlationId)`.

- [ ] **Step 1: Write queue tests before implementation.**

Assert deterministic job IDs for event, notification, action, and sync jobs; assert that job IDs include the logical resource ID; assert that enqueue helpers call BullMQ with `attempts: 5`, exponential backoff, `removeOnComplete.count >= 100`, and `removeOnFail.count >= 500`; assert that action tokens are not included in log metadata.

```ts
it("creates stable IDs for event retries", () => {
  expect(createOrderConfirmationJobId({
    type: "PROCESS_EVENT",
    eventId: 42,
    correlationId: "corr-1",
  })).toBe("order-process-event-42");
});
```

- [ ] **Step 2: Run the queue test and confirm failure.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.queue.test.ts
```

Expected: FAIL because the queue module does not exist.

- [ ] **Step 3: Implement the queue and enqueue helpers.**

Create a BullMQ queue named `order-confirmations` with the existing Redis connection and prefix. Use job names `process_event`, `send_notification`, `process_action`, and `sync_store`. Sanitize job IDs through the existing `safeBullMqJobId` helper or a local equivalent that preserves the resource identity while preventing unsafe characters.

- [ ] **Step 4: Run the queue test and commit.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.queue.test.ts
```

Expected: PASS. Commit:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.queue.ts src/modules/order-confirmation/orderConfirmation.queue.test.ts
$ git commit -m "feat(order-confirmations): add dedicated processing queue"
```

---

### Task 4: Implement Signed Public Event Intake

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.repository.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.public.controller.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.public.routes.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.public.controller.test.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.repository.test.ts`
- Modify: `back-end/src/app.ts`
- Modify: `back-end/src/middlewares/rateLimit.middleware.ts`
- Modify: `back-end/src/app.routes.test.ts`

**Interfaces:**
- Consumes `verifyOrderWebhookSignature`, `parseCanonicalOrderEvent`, and `enqueueOrderEvent`.
- Repository produces `findActiveIntegrationByPublicKey(publicKey)` and `insertOrderEventIfNew(params)`.
- Controller produces `receiveOrderEvent(req: Request, res: Response): Promise<void>`.
- Public route is `POST /v1/order-integrations/:integrationKey/events`.

- [ ] **Step 1: Write repository and HTTP tests using the repository's Node `http.createServer` test style.**

Mock Prisma and assert that the repository returns a duplicate result on the composite unique constraint and never leaks encrypted secrets. Create a local Express app with `express.raw({ type: "application/json" })`, mount the public router, and issue real HTTP requests. Cover valid signature returning `202`, invalid signature returning `401`, missing or mismatched `Idempotency-Key` returning `400`, inactive/unknown integration returning `404`, duplicate event returning `202` without a second enqueue, and a database failure returning `500`.

```ts
function makeApp(): express.Application {
  const app = express();
  app.use(express.raw({ type: "application/json", limit: "256kb" }));
  app.use(orderConfirmationPublicRoutes);
  return app;
}
```

- [ ] **Step 2: Run the public controller test and confirm failure.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.public.controller.test.ts
```

Expected: FAIL because the repository, controller, and route are not implemented.

- [ ] **Step 3: Implement the event repository methods.**

`findActiveIntegrationByPublicKey` must select only the integration, business-profile ID, encrypted signing secret, active flag, and event settings needed for verification. `insertOrderEventIfNew` must create the immutable event with `RECEIVED` status and catch Prisma unique conflicts as a duplicate result. Never return signing secrets to callers outside the controller/service boundary.

- [ ] **Step 4: Mount raw-body middleware and a dedicated webhook limiter.**

Add `orderWebhookLimiter` in `rateLimit.middleware.ts` with a higher webhook ceiling than the general limiter and IP-based keys. In `app.ts`, add the raw parser before `express.json()` for the exact event prefix:

```ts
app.use(
  "/v1/order-integrations/:integrationKey/events",
  orderWebhookLimiter,
  express.raw({ type: "application/json", limit: "256kb" }),
);
app.use("/v1/order-integrations", orderConfirmationPublicRoutes);
```

Mount protected order-management routes only after the global authentication and CSRF middleware in Task 8. Add route-order assertions to `app.routes.test.ts` so the public endpoint remains before the auth wall and JSON parsing does not replace the raw body.

- [ ] **Step 5: Implement the controller.**

Read `req.body` as a `Buffer`, read `Idempotency-Key`, `X-Wkil-Timestamp`, and `X-Wkil-Signature`, require the header value to equal the body `eventId`, verify the encrypted integration secret, parse the canonical event, persist it, enqueue `PROCESS_EVENT`, and return:

```json
{
  "accepted": true,
  "duplicate": false,
  "eventId": "evt_123"
}
```

Return `duplicate: true` for an existing event. If queue enqueue fails after persistence, keep the event `RECEIVED`, log the correlation ID, and still return `202` because the recovery scanner will re-enqueue it.

- [ ] **Step 6: Run HTTP and route tests and commit.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.repository.test.ts src/modules/order-confirmation/orderConfirmation.public.controller.test.ts src/app.routes.test.ts
```

Expected: PASS. Commit:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.repository.ts src/modules/order-confirmation/orderConfirmation.repository.test.ts src/modules/order-confirmation/orderConfirmation.public.controller.ts src/modules/order-confirmation/orderConfirmation.public.routes.ts src/modules/order-confirmation/orderConfirmation.public.controller.test.ts src/app.ts src/middlewares/rateLimit.middleware.ts src/app.routes.test.ts
$ git commit -m "feat(order-confirmations): accept signed order events"
```

---

### Task 5: Implement Order State, Template Mapping, And WhatsApp Delivery

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.template.service.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.whatsapp.adapter.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.service.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.worker.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.rateLimit.ts`
- Test: `back-end/src/modules/order-confirmation/orderConfirmation.rateLimit.test.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.service.test.ts`
- Modify: `back-end/src/modules/order-confirmation/orderConfirmation.repository.ts`
- Modify: `back-end/src/server.ts`

**Interfaces:**
- Consumes `OrderConfirmationJob`, repository methods, `sendWhatsAppTemplate`, `sendWhatsAppReply`, `getOrCreateConversation`, and `saveMessage`.
- Consumes `getSystemSetting` from `src/modules/settings/settings.service.ts` for the global kill switch.
- Produces `processOrderEvent(eventId: number): Promise<void>`.
- Produces `sendOrderNotification(notificationId: number): Promise<void>`.
- Produces `processOrderAction(input: OrderActionInput): Promise<{ orderId: number; action: OrderAction; applied: boolean; currentStatus: OrderStatus }>`.
- Produces `acquireBusinessSendPermit(businessProfileId: number): Promise<number | null>` where a non-null result is the retry delay in milliseconds.
- Produces `startOrderConfirmationQueue(): void` and `orderConfirmationWorker` for `server.ts`.

- [ ] **Step 1: Write failing service tests for the core workflow.**

Mock Prisma, the queue helpers, WhatsApp adapter, template resolver, logger, and conversation service. Cover:

- A valid event creates one order, one confirmation notification, and two action-token hashes.
- Reprocessing the same `OrderEvent` does not create a second notification.
- The customer response updates only `AWAITING_CONFIRMATION`.
- A second response returns `applied: false` and cannot reverse the first state.
- The notification is marked `SENDING` before the provider call and `SENT` with the provider message ID after success.
- A provider failure marks the notification `FAILED` without changing the order state.
- A suppression record prevents outbound sending and records a non-delivery reason.
- A global kill switch prevents the provider call and records a non-retryable `GLOBAL_KILL_SWITCH` failure reason.
- The per-business Redis send permit allows 60 sends in a one-minute window and returns a retry delay after the limit is reached.

```ts
it("lets only the first action transition the order", async () => {
  mockedRepository.claimOrderAction
    .mockResolvedValueOnce({ applied: true, orderId: 12, action: "CONFIRM", currentStatus: "CONFIRMED" })
    .mockResolvedValueOnce({ applied: false, orderId: 12, action: "CANCEL", currentStatus: "CONFIRMED" });

  await expect(processOrderAction(confirmInput)).resolves.toMatchObject({ applied: true });
  await expect(processOrderAction(cancelInput)).resolves.toMatchObject({ applied: false, currentStatus: "CONFIRMED" });
});
```

- [ ] **Step 2: Run the service tests and confirm failure.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.service.test.ts
```

Expected: FAIL because the workflow service and repository state methods do not exist.

- [ ] **Step 3: Implement template resolution and rendering.**

Add `resolveActiveTemplateConfig({ integrationId, whatsappAccountId, locale, eventType })` and `renderOrderTemplateVariables(order, mapping)`. Validate that every Meta body placeholder and button parameter is mapped to an allowlisted field. Reject unmapped or unknown fields before enqueueing a real send. Format money at this boundary using the order currency and locale. Do not use arbitrary JSON paths from merchant input.

- [ ] **Step 4: Implement the WhatsApp adapter.**

Create `sendConfirmationNotification(notificationId)` and `sendAcknowledgementNotification(notificationId)` around the existing `sendWhatsAppTemplate` and `sendWhatsAppReply` functions. Decrypt the account token with `decryptFacebookSecret`. For each successful send, return `{ providerMessageId, previewText }` and never return the access token. Use `getOrCreateConversation(phoneNumberId, customerPhone, businessProfileId, { channel: "whatsapp", customerPhone, customerName })` and `saveMessage(conversationId, "agent", previewText, { externalId: providerMessageId, origin: "order_confirmation" })` so the message appears in the existing inbox.

Before a provider send, check the global system setting `order_confirmations_global_enabled` with default `true`, then call `acquireBusinessSendPermit`. Use a Redis sliding-window counter with a default limit of 60 outbound messages per business per minute. When the permit is unavailable, return the delay to BullMQ instead of calling Meta.

- [ ] **Step 5: Implement event processing and first-response-wins state transitions.**

`processOrderEvent` must load the event, normalize it, run a Prisma transaction that creates or reuses the order and confirmation notification, issues two action-token hashes, and marks the event processed. Enqueue `SEND_NOTIFICATION` only when the confirmation workflow was newly created. `processOrderAction` must verify the hashed token, integration, business profile, customer phone, and pending order state before executing a conditional status update. Enqueue exactly one acknowledgement for an applied action. When synchronization is enabled, create one pending `OrderStoreSync` row; Task 7 attaches the adapter enqueue after the callback implementation exists. A disabled global switch marks a queued notification `FAILED` with a non-retryable `GLOBAL_KILL_SWITCH` reason without contacting Meta.

- [ ] **Step 6: Implement the worker and lifecycle hooks.**

The worker dispatches `PROCESS_EVENT` to `processOrderEvent`, `SEND_NOTIFICATION` to `sendOrderNotification`, and `PROCESS_ACTION` to `processOrderAction`. Attach queue `ready`, `active`, `completed`, `failed`, `stalled`, and `error` logs with correlation IDs and Sentry failure capture. Add `startOrderConfirmationQueue()` to `server.ts` after the existing queue startup and include `orderConfirmationWorker` in graceful shutdown. Schedule a one-minute recovery scan that re-enqueues stale `RECEIVED`/`PROCESSING` events and unattempted `QUEUED` notifications by deterministic job ID. Mark stale `SENDING` notifications `FAILED` with `AMBIGUOUS_PROVIDER_DELIVERY` for manual review rather than automatically resending a message that Meta may already have accepted. Clear raw payload JSON whose `rawPayloadRetentionUntil` has passed while retaining event metadata. Task 7 adds the `SYNC_STORE` dispatch when the adapter is available.

- [ ] **Step 7: Run service tests, generate Prisma client, and commit.**

```bash
npm run prisma:generate
npm test -- src/modules/order-confirmation/orderConfirmation.rateLimit.test.ts
npm test -- src/modules/order-confirmation/orderConfirmation.service.test.ts
npm run build
```

Expected: PASS and a TypeScript build with the worker and new Prisma models. Commit:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.template.service.ts src/modules/order-confirmation/orderConfirmation.whatsapp.adapter.ts src/modules/order-confirmation/orderConfirmation.service.ts src/modules/order-confirmation/orderConfirmation.worker.ts src/modules/order-confirmation/orderConfirmation.service.test.ts src/server.ts
$ git commit -m "feat(order-confirmations): process orders and send WhatsApp confirmations"
```

---

### Task 6: Route Interactive Replies And Enforce Opt-Out Suppression

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.whatsapp.parser.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.whatsapp.parser.test.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts`
- Modify: `back-end/src/modules/meta/whatsapp/whatsapp.controller.ts`
- Modify: `back-end/src/modules/meta/core/metaProcessor.service.ts`

**Interfaces:**
- Produces `parseWhatsAppInteractiveReply(message: unknown): { actionToken: string; buttonTitle?: string } | null`.
- Produces `isWhatsAppOptOut(text: string): boolean` and `normalizeOptOutText(text: string): string`.
- Consumes `enqueueOrderAction` and `processOrderAction` from Task 5.

- [ ] **Step 1: Write parser tests.**

Cover Meta `interactive.button_reply.id`, missing IDs, non-interactive text, button titles, English opt-out phrases such as `stop` and `unsubscribe`, Arabic opt-out phrases such as `وقف` and `الغاء`, punctuation/whitespace normalization, and non-opt-out phrases that must continue to AI.

- [ ] **Step 2: Run parser tests and confirm failure.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.whatsapp.parser.test.ts
```

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement pure parsing and suppression matching.**

Keep the action token as an opaque string. Do not parse an order ID from the button payload. Keep the opt-out dictionary narrowly transactional and localized; do not treat ordinary words such as `cancel` as a global opt-out because they may be an order action.

- [ ] **Step 4: Extend the WhatsApp webhook controller.**

Before the current text/media validation, inspect `msg.interactive?.button_reply`. For a valid button reply, enqueue an inbound Meta event with `type: "ORDER_ACTION"`, `orderActionId`, `buttonTitle`, `phoneNumberId`, `businessProfileId`, actual customer phone, and the Meta inbound message ID. Preserve the existing business-echo handling and normal message parsing.

- [ ] **Step 5: Route order actions before AI.**

Extend `MetaMessageJob` with `orderActionId?: string` and `buttonTitle?: string`. In `processMetaMessage`, branch on `type === "ORDER_ACTION"` before AI identity/context work and enqueue `PROCESS_ACTION`. The branch must return after queueing so a button payload is never sent to the AI agent as ordinary customer text.

- [ ] **Step 6: Add opt-out handling to normal WhatsApp text.**

After the inbound message is persisted and before AI processing, check `isWhatsAppOptOut`. Upsert `WhatsAppSuppression` for the business profile and normalized phone, emit an audit log, and return without generating an AI reply. Keep ordinary order text and all non-opt-out messages on the existing path.

- [ ] **Step 7: Run parser and backend regression tests and commit.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.whatsapp.parser.test.ts src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts src/modules/meta/core/metaWebhook.test.ts src/modules/meta/core/conversation.service.test.ts
npm run build
```

Expected: PASS. Commit:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.whatsapp.parser.ts src/modules/order-confirmation/orderConfirmation.whatsapp.parser.test.ts src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts src/modules/meta/whatsapp/whatsapp.controller.ts src/modules/meta/core/metaProcessor.service.ts
$ git commit -m "feat(order-confirmations): handle WhatsApp actions and opt-outs"
```

---

### Task 7: Add Generic Signed Store Status Synchronization

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.store.adapter.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.store.adapter.test.ts`
- Modify: `back-end/src/modules/order-confirmation/orderConfirmation.worker.ts`
- Modify: `back-end/src/modules/order-confirmation/orderConfirmation.service.ts`

**Interfaces:**
- Produces `sendGenericOrderStatusCallback(syncId: number): Promise<void>`.
- Produces `processStoreSync(syncId: number): Promise<void>` and extends the worker to dispatch `SYNC_STORE`.
- Consumes `assertExternalApiUrlNetworkSafe` from `src/modules/integrations/external/agentActionExecutor.service.ts` and retry classification from `src/modules/integrations/retryPolicy.ts`.
- Uses callback headers `Idempotency-Key`, `X-Wkil-Timestamp`, and `X-Wkil-Signature: v1=<hex digest>`.

- [ ] **Step 1: Write callback adapter tests.**

Mock `global.fetch`, DNS safety checks, Prisma, and logger. Cover a `2xx` response, an already-applied `409` response treated as success, `429` and `5xx` as retryable, malformed/private callback URLs rejected before network access, timeout/network errors classified as retryable, permanent `401`/`403` as failed without unbounded retry, and callback-secret rotation using the current then previous secret.

- [ ] **Step 2: Run adapter tests and confirm failure.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.store.adapter.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement secure callback delivery.**

Load the `OrderStoreSync`, `Order`, and `OrderIntegration` records. Require an active HTTPS callback URL and callback secret. Run both URL-shape and network DNS safety checks, use an eight-second abort timeout, disable redirects, serialize only the status callback contract, and sign the exact outgoing body. Update `OrderStoreSync` to `SUCCEEDED` for `2xx` or already-applied status, `PENDING` for retryable failures, and `FAILED` for permanent failures.

- [ ] **Step 4: Connect the worker and recovery behavior.**

Make `processStoreSync` call the adapter and preserve the local `CONFIRMED` or `CANCELED` order state on every failure. Add the `enqueueStoreSync` call to the applied-action path when a pending sync row is created, add the worker `SYNC_STORE` dispatch, and add an enqueue helper for manual retry that uses the existing sync row and deterministic job ID. Ensure a retry never creates a new customer acknowledgement or changes the order state.

- [ ] **Step 5: Run tests and commit.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.store.adapter.test.ts src/modules/integrations/retryPolicy.test.ts
npm run build
```

Expected: PASS. Commit:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.store.adapter.ts src/modules/order-confirmation/orderConfirmation.store.adapter.test.ts src/modules/order-confirmation/orderConfirmation.worker.ts src/modules/order-confirmation/orderConfirmation.service.ts
$ git commit -m "feat(order-confirmations): add retryable store status callbacks"
```

---

### Task 8: Add Authenticated Management APIs

**Files:**
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.controller.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.routes.ts`
- Create: `back-end/src/modules/order-confirmation/orderConfirmation.management.test.ts`
- Modify: `back-end/src/modules/order-confirmation/orderConfirmation.repository.ts`
- Modify: `back-end/src/app.ts`

**Interfaces:**
- `orderConfirmation.routes.ts` is mounted once at `/v1` after the existing authenticated/verified/CSRF middleware; the router owns the `/order-integrations` and `/order-confirmations` prefixes.
- Controllers use the existing `getAccessibleProfileIds(userId)` authorization boundary.
- Produces these endpoints:
  - `GET /v1/order-integrations`
  - `POST /v1/order-integrations`
  - `PATCH /v1/order-integrations/:id`
  - `POST /v1/order-integrations/:id/rotate-secret`
  - `POST /v1/order-integrations/:id/test-event`
  - `GET /v1/order-confirmations/templates`
  - `GET /v1/order-confirmations/template-configs`
  - `POST /v1/order-confirmations/template-configs`
  - `PATCH /v1/order-confirmations/template-configs/:id`
  - `GET /v1/order-confirmations/orders`
  - `GET /v1/order-confirmations/orders/:id`
- `POST /v1/order-confirmations/notifications/:id/retry`
- `POST /v1/order-confirmations/sync/:id/retry`
- `GET /v1/order-confirmations/global-state` (admin only)
- `PATCH /v1/order-confirmations/global-state` (admin only)

- [ ] **Step 1: Write management authorization tests.**

Cover a user reading only integrations for accessible profiles, a user being denied another profile's integration, secret omission from list/detail responses, plaintext secret returned only by create/rotate, validation of HTTPS callback URL, rejection of missing callback secret when sync is enabled, template mapping to unknown fields, safe test-event behavior, pagination/status filters, and retry authorization.

- [ ] **Step 2: Run management tests and confirm failure.**

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.management.test.ts
```

Expected: FAIL because the controllers and routes do not exist.

- [ ] **Step 3: Implement integration settings endpoints.**

Create integration secrets with `generateRandomToken`, persist only encrypted values, return the plaintext secret once, and return the public webhook URL plus integration key. `PATCH` must support active state, default locale, synchronization flag, callback URL, callback-secret rotation, and selected WhatsApp account. Enabling generic synchronization must validate the callback URL and require a callback secret.

- [ ] **Step 4: Implement template endpoints.**

Use the existing `listWhatsAppTemplates(wabaId, accessToken)` function to list approved templates for the selected account. Store only the selected template name, language, event type, version, and allowlisted variable mapping. Validate that the selected template is currently approved and contains the required Confirm/Cancel quick replies before activation.

- [ ] **Step 5: Implement test-event, order-list, detail, and retry endpoints.**

The test-event endpoint validates a supplied canonical example and returns the selected locale/template rendering without contacting a customer. Order list/detail endpoints return order status, notification delivery, sync state, source event ID, and timestamps while omitting secrets and action tokens. Retry endpoints enqueue existing failed notification/sync records only when the order is still eligible; they must not create a second confirmation for a handled order.

Add the admin-only global-state endpoints using the existing `requireAdmin` middleware and `getSystemSetting`/`updateSystemSetting` with key `order_confirmations_global_enabled` and default value `true`. The response must expose only the boolean state and updated timestamp, never arbitrary system settings.

- [ ] **Step 6: Mount protected routes and run tests.**

Mount the router with `app.use("/v1", orderConfirmationRoutes)` after `app.use(authenticateToken)`, `app.use(requireVerified)`, and `app.use(validateCsrfToken)`. Add route-mount assertions to `src/app.routes.test.ts` so the public event route remains before the protected wall and management routes remain behind it.

Run:

```bash
npm test -- src/modules/order-confirmation/orderConfirmation.management.test.ts src/app.routes.test.ts
npm run build
```

Expected: PASS. Commit:

```bash
$ git add src/modules/order-confirmation/orderConfirmation.controller.ts src/modules/order-confirmation/orderConfirmation.routes.ts src/modules/order-confirmation/orderConfirmation.management.test.ts src/app.ts src/app.routes.test.ts
$ git commit -m "feat(order-confirmations): add management APIs"
```

---

### Task 9: Document The API And Regenerate Types

**Files:**
- Modify: `back-end/docs/openapi.yaml`
- Modify: `app/src/types/openapi.generated.ts` through the generator command

**Interfaces:**
- OpenAPI documents the public HMAC headers, canonical event body, `202` response, authentication requirements, request bodies, status enums, template mappings, order responses, and retry responses.
- The generated frontend type file must be produced by `npm run types:api`; do not hand-edit generated declarations.

- [ ] **Step 1: Add the Order Confirmations tag and paths.**

Document `/v1/order-integrations/{integrationKey}/events` with security `[]`, required `Idempotency-Key`, `X-Wkil-Timestamp`, `X-Wkil-Signature`, and raw JSON request body. Document settings, rotate-secret, test-event, approved-template, template-config, order list/detail, notification retry, sync retry, and admin-only global-state operations with the existing bearer/cookie plus CSRF security forms.

- [ ] **Step 2: Add schemas and request bodies.**

Add schemas for `CanonicalOrderEvent`, `CanonicalOrder`, `OrderIntegration`, `OrderTemplateConfig`, `OrderSummary`, `OrderNotification`, `OrderStoreSync`, `OrderEventStatus`, and `OrderStatus`. Use exact enum values from the Prisma/domain contract. Mark secrets and action tokens as write-only or absent from response schemas.

- [ ] **Step 3: Run documentation lint, route coverage, bundle, and type generation.**

Run from the isolated backend worktree:

```bash
npm run docs:lint
npm run docs:routes
npm run docs:bundle
npx openapi-typescript docs/openapi.yaml -o "D:/zTechy Org/pagespilot.com/wkil-fullstack/app/.worktrees/whatsapp-order-confirmations/src/types/openapi.generated.ts"
```

Expected: Redocly lint passes, `scripts/check-openapi-routes.js` reports no missing or extra routes, the OpenAPI bundle is generated, and the isolated frontend worktree's `src/types/openapi.generated.ts` is updated.

- [ ] **Step 4: Commit in both repositories.**

Backend:

```bash
git add docs/openapi.yaml dist/openapi.json
git commit -m "docs(api): document order confirmation endpoints"
```

Frontend generated types:

```bash
git -C ../app add src/types/openapi.generated.ts
git -C ../app commit -m "chore(api): sync order confirmation types"
```

If `dist/openapi.json` is ignored, stage only the tracked OpenAPI source and confirm the generated bundle is present for build output.

---

### Task 10: Add Frontend API Client And Query Hooks

**Files:**
- Create: `app/src/lib/order-confirmation-api.ts`
- Create: `app/src/hooks/integrations/useOrderConfirmations.ts`
- Modify: `app/src/lib/config.ts`
- Modify: `app/src/hooks/integrations/integrations.keys.ts`
- Modify: `app/src/hooks/integrations/index.ts`

**Interfaces:**
- API client methods:

```ts
listIntegrations(signal?: AbortSignal): Promise<OrderIntegration[]>
createIntegration(payload: CreateOrderIntegrationPayload): Promise<CreateOrderIntegrationResponse>
updateIntegration(id: number, payload: UpdateOrderIntegrationPayload): Promise<OrderIntegration>
rotateSecret(id: number): Promise<{ secret: string }>
listApprovedTemplates(whatsappAccountId: number, signal?: AbortSignal): Promise<WhatsAppTemplate[]>
listTemplateConfigs(integrationId: number, signal?: AbortSignal): Promise<OrderTemplateConfig[]>
saveTemplateConfig(payload: SaveOrderTemplateConfigPayload): Promise<OrderTemplateConfig>
sendTestEvent(integrationId: number, payload: CanonicalOrderEvent): Promise<TestEventPreview>
listOrders(filters: OrderListFilters, signal?: AbortSignal): Promise<OrderListResponse>
retryNotification(id: number): Promise<void>
retryStoreSync(id: number): Promise<void>
```

- Hooks use query keys scoped by integration ID and filters and invalidate integration/order queries after settings or retry mutations.

- [ ] **Step 1: Add API path constants.**

Extend `API_CONFIG` with `ORDER_INTEGRATIONS` and `ORDER_CONFIRMATIONS` paths. Export URL builders that use the existing `buildApiUrl` function and preserve the current `fetchWithAuth` CSRF behavior.

- [ ] **Step 2: Define frontend domain types and API methods.**

Keep response types explicit and omit secret fields from list/detail types. Represent status values as string unions matching the backend. Use `AbortSignal` for all list/template queries and unwrap the existing `{ data: responseData }` response conventions consistently.

- [ ] **Step 3: Add query keys and hooks.**

Add `orderConfirmationIntegrations`, `orderConfirmationTemplates`, `orderConfirmationTemplateConfigs`, and `orderConfirmationOrders` keys to `INTEGRATION_KEYS`. Implement `useOrderConfirmationIntegrations`, `useOrderConfirmationTemplates`, `useOrderConfirmationTemplateConfigs`, `useOrderConfirmationOrders`, and mutations for save, rotate, test, notification retry, and sync retry.

- [ ] **Step 4: Run frontend type checking.**

Run from `app`:

```bash
npx tsc --noEmit
```

Expected: PASS. Commit:

```bash
$ git add src/lib/config.ts src/lib/order-confirmation-api.ts src/hooks/integrations/integrations.keys.ts src/hooks/integrations/useOrderConfirmations.ts src/hooks/integrations/index.ts
$ git commit -m "feat(order-confirmations): add frontend API hooks"
```

---

### Task 11: Build The Merchant Dashboard

**Files:**
- Create: `app/src/app/[locale]/(protected)/user/(dashboard)/channels/order-confirmations/page.tsx`
- Create: `app/src/components/user/OrderConfirmationSettings.tsx`
- Create: `app/src/components/user/order-confirmations/OrderConfirmationIntegrationForm.tsx`
- Create: `app/src/components/user/order-confirmations/OrderConfirmationTemplateForm.tsx`
- Create: `app/src/components/user/order-confirmations/OrderConfirmationOrders.tsx`
- Modify: `app/src/app/[locale]/(protected)/user/(dashboard)/channels/layout.tsx`
- Modify: `app/src/app/[locale]/(protected)/user/(dashboard)/channels/page.tsx`
- Modify: `app/messages/en/integrations.json`
- Modify: `app/messages/ar/integrations.json`

**Interfaces:**
- The route renders `OrderConfirmationSettings` inside the existing Channels layout.
- The settings component consumes the hooks from Task 10 and existing `useBusinessProfiles` and `useWhatsAppAccounts`.
- All user-facing copy comes from the `integrations` namespace in both locales.

- [ ] **Step 1: Add translation keys in English and Arabic.**

Add `channelsPage.tabs.orderConfirmations`, `channelsPage.cards.orderConfirmations`, and an `orderConfirmationsPage` namespace covering title, webhook setup, secret rotation, callback sync, template mapping, preview, test event, order statuses, retry labels, empty/loading/error states, and validation messages. Keep Arabic text RTL-safe and use existing terminology for WhatsApp, order, confirmation, and synchronization.

- [ ] **Step 2: Add the route and channel navigation.**

Create the protected page that renders the settings component. Add the channel overview card and channel tab. Change the tab grid from three columns to a responsive layout that remains usable on narrow screens. Preserve the existing WhatsApp, Facebook, and Wkil Chat links and active-state behavior.

- [ ] **Step 3: Build the integration form.**

Show the selected business profile and WhatsApp account. Display the webhook URL and integration key with copy controls. Reveal the generated secret only after create/rotate and never repopulate it from a GET response. Add active toggle, default locale, status-callback URL, callback-secret rotation, and synchronization toggle. Block synchronization until the callback URL is HTTPS and the required callback secret exists.

- [ ] **Step 4: Build template mapping and preview.**

Load only approved templates for the selected WhatsApp account. Let the merchant choose locale, event type `order.created`, template, and allowed canonical fields. Show missing-variable errors before save and render a sample message using fixed test data. Explain that Meta approval is required and do not expose arbitrary JSON-path editing.

- [ ] **Step 5: Build order operations.**

Show orders grouped or filtered by `AWAITING_CONFIRMATION`, `CONFIRMED`, and `CANCELED`, with independent notification and store-sync badges. Show source event ID, customer phone in a privacy-conscious format, order number, total/currency, timestamps, failure reason, and safe retry controls. Disable confirmation retry once the order has a terminal response.

- [ ] **Step 6: Run lint and type checks.**

Run from `app`:

```bash
npm run lint
npx tsc --noEmit
```

Expected: PASS with both English and Arabic routes compiling. Commit:

```bash
$ git add -- "src/app/[locale]/(protected)/user/(dashboard)/channels/order-confirmations/page.tsx" "src/components/user/OrderConfirmationSettings.tsx" "src/components/user/order-confirmations/OrderConfirmationIntegrationForm.tsx" "src/components/user/order-confirmations/OrderConfirmationTemplateForm.tsx" "src/components/user/order-confirmations/OrderConfirmationOrders.tsx" "src/app/[locale]/(protected)/user/(dashboard)/channels/layout.tsx" "src/app/[locale]/(protected)/user/(dashboard)/channels/page.tsx" "messages/en/integrations.json" "messages/ar/integrations.json"
$ git commit -m "feat(order-confirmations): add merchant dashboard"
```

Use quoted paths if the shell interprets parentheses or brackets.

---

### Task 12: Run Full Verification And Perform The Sandbox Rollout Check

**Files:**
- Modify only files required by verification failures; do not broaden scope.

**Interfaces:**
- Verifies every acceptance criterion in the approved design.
- Uses the existing backend and frontend scripts rather than adding a second test framework.

- [ ] **Step 1: Run the complete backend test suite.**

From `back-end`:

```bash
npm test
```

Expected: all existing and order-confirmation tests pass.

- [ ] **Step 2: Run backend build and documentation checks.**

```bash
npm run build
npm run docs:check
```

Expected: TypeScript build succeeds, OpenAPI lint succeeds, route coverage has no drift, and the OpenAPI bundle is generated.

- [ ] **Step 3: Run frontend verification.**

From `app`:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Expected: lint, type checking, and the production Next.js build pass in both locales.

- [ ] **Step 4: Execute the signed webhook smoke test without a real customer.**

Use a local canonical payload with `eventId: "evt_smoke_001"`, a test integration secret, and a customer number reserved for the Meta sandbox. Compute the signature over the exact raw JSON bytes, POST the event, verify `202`, send the same event again, verify the duplicate response, and inspect the database for one event, one order, one confirmation notification, and two action-token hashes.

- [ ] **Step 5: Execute the button and sync smoke test.**

Use the Meta test number to send one Confirm reply and verify the order changes to `CONFIRMED`, one acknowledgement is recorded, and one status callback is sent when synchronization is enabled. Send Cancel afterward and verify the order remains `CONFIRMED`. Force the callback endpoint to return `503`, verify the local response remains confirmed and sync enters `PENDING`/`FAILED`, then run the retry endpoint and verify the idempotency key remains stable.

- [ ] **Step 6: Inspect both repositories before handoff.**

Run:

```bash
$ git -C ../back-end status --short --branch
$ git -C ../back-end log --oneline -10
$ git -C ../app status --short --branch
$ git -C ../app log --oneline -10
```

Expected: only intended feature commits/files are present, no secrets are staged, and generated OpenAPI types are committed in `app`.

- [ ] **Step 7: Record rollout readiness.**

Confirm the per-business feature flag is disabled by default, the global kill switch is documented, approved templates exist for every enabled locale, the generic status callback is HTTPS and reachable, and metrics/log correlation IDs are visible before enabling an internal cohort.
