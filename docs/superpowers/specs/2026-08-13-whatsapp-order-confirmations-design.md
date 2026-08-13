# WhatsApp Order Confirmations

Date: 2026-08-13
Status: Ready for user review

## Context

Wkil already has an official Meta WhatsApp Business integration, WhatsApp webhooks, approved-template sending, unified conversations, Prisma/PostgreSQL persistence, Redis, and BullMQ workers. It does not yet have an order domain or a generic order-event ingestion boundary.

The feature will allow an online store to send an `order.created` event to Wkil. Wkil will send the customer an approved WhatsApp utility template with Confirm and Cancel buttons. The first valid response changes the local order state, sends an acknowledgement, and optionally updates the source store.

The implementation is a modular monolith inside the existing backend. It is provider-neutral at the order boundary and uses WhatsApp as the first outbound messaging adapter.

## Goals

- Accept order events through a provider-neutral, signed webhook.
- Support Shopify, Salla, EasyOrders, and other providers later through adapters that normalize into one canonical schema.
- Send one duplicate-safe WhatsApp confirmation request for every accepted `order.created` event.
- Use approved, configurable WhatsApp templates with selected canonical order fields.
- Support localized templates using the customer locale with a business-default fallback.
- Process Confirm and Cancel button replies with first-response-wins semantics.
- Keep local order state, WhatsApp delivery state, and external-store synchronization state independent.
- Retry transient failures durably and expose permanent failures to merchants and operators.
- Reuse existing WhatsApp accounts, token encryption, conversation history, Meta delivery tracking, Redis, BullMQ, OpenAPI, and role authorization.
- Be safe for enterprise-scale multi-tenant traffic without introducing a new microservice or broker.

## Non-goals

- Shopify, Salla, EasyOrders, or other platform-specific adapters in the first release.
- Automated creation and submission of Meta templates in the first release.
- Reminder messages, automatic expiry, or full order lifecycle notifications.
- Direct processing of arbitrary store JSON by the confirmation engine.
- A customer consent checkbox, consent link, or consent field as a prerequisite for the first release. The merchant is responsible for lawful messaging; Wkil must still honor opt-outs.
- A separate integration microservice or event broker.

## Product Decisions

| Decision | Choice |
|---|---|
| Initial order source | Generic signed webhook; future providers use adapters |
| Initial trigger | Every accepted `order.created` event |
| Customer interaction | WhatsApp Confirm/Cancel quick-reply buttons |
| Unanswered orders | Remain `AWAITING_CONFIRMATION` indefinitely |
| Duplicate responses | First valid response wins |
| Acknowledgement | Send an immediate localized acknowledgement |
| Store synchronization | Optional per-business setting |
| Store-sync failure | Preserve the local response, retry asynchronously, and alert after repeated failure |
| Template strategy | Select an existing approved WABA template and map canonical fields |
| Template automation | Add a provider abstraction now; automate creation/submission later |
| Message locale | Customer locale first, business default as fallback |
| Event contract | Versioned canonical schema; adapters normalize provider payloads |
| Scale strategy | Enterprise-ready modular monolith using PostgreSQL, Redis, and BullMQ |

## Architecture

Create a focused `order-confirmation` module under `back-end/src/modules`. The module owns order events, canonical orders, confirmation state, templates, action tokens, notification attempts, and store synchronization. It does not own Meta token management or low-level WhatsApp HTTP calls.

The module exposes stable internal ports:

- `OrderEventNormalizer` converts generic or provider-specific payloads into the canonical order model.
- `MessageChannel` sends confirmation and acknowledgement messages.
- `OrderStatusAdapter` updates the source store when synchronization is enabled.
- `TemplateResolver` selects an approved template and maps canonical fields to its variables.

The first implementation adapters are:

- `GenericSignedWebhookAdapter` for the initial public event endpoint.
- `WhatsAppMessageChannel` backed by the existing WhatsApp Cloud API service.
- `GenericOrderStatusCallbackAdapter` for the initial generic integration. It sends a signed `order.status_changed` callback to the merchant store, which applies the status change.

The high-level flow is:

```text
Store
  -> POST signed order event
  -> Verify signature and timestamp
  -> Persist event inbox record
  -> Return 202
  -> Queue durable processing job
  -> Normalize and validate order.created
  -> Upsert order idempotently
  -> Create confirmation notification and action tokens
  -> Resolve locale and approved template
  -> Send WhatsApp template
  -> Save notification and shared-inbox message
  -> Receive interactive button reply through WhatsApp webhook
  -> Validate action token and customer/order association
  -> Conditionally transition order state
  -> Queue acknowledgement
  -> Queue optional store synchronization
```

The webhook controller must only authenticate, persist, and enqueue. It must not call Meta or a store API in the request path. A dedicated BullMQ order-confirmation queue should use the existing Redis deployment so transactional jobs are not blocked behind AI work in `metaExpressQueue`.

The existing WhatsApp webhook parser must recognize `interactive.button_reply`. Order actions should be routed to the order-confirmation module before AI processing. Normal customer text continues through the existing conversation and AI pipeline.

## Canonical Order Event

The public event contract is versioned and intentionally smaller than any individual provider payload. Provider adapters and custom integrations must normalize into this shape before processing.

Minimum required fields:

- `schemaVersion`
- `eventId`
- `eventType`, initially `order.created`
- `occurredAt`
- `order.id`
- `order.number`
- `order.currency`
- `order.total`
- `order.customer.phone`

Optional fields include customer name and locale, line items, shipping address, source status, payment method, and provider metadata.

Example:

```json
{
  "schemaVersion": "1",
  "eventId": "evt_123",
  "eventType": "order.created",
  "occurredAt": "2026-08-13T10:30:00Z",
  "order": {
    "id": "ord_123",
    "number": "#123",
    "currency": "EGP",
    "total": 850,
    "customer": {
      "name": "Mona",
      "phone": "+201001234567",
      "locale": "ar"
    },
    "items": [
      {
        "id": "sku_1",
        "name": "Product",
        "quantity": 2,
        "unitPrice": 425,
        "total": 850
      }
    ],
    "shippingAddress": {
      "city": "Cairo",
      "country": "EG"
    },
    "metadata": {}
  }
}
```

Money must be normalized to a decimal-safe representation and formatted only at the message boundary. Phone numbers must be normalized to E.164 before a confirmation can be sent. The confirmation engine must never resolve fields by arbitrary JSON paths at send time.

## Webhook Authentication

Each `OrderIntegration` receives an opaque integration key and a unique signing secret. The public endpoint is:

```text
POST /v1/order-integrations/:integrationKey/events
```

Required headers:

- `Idempotency-Key`, matching the body `eventId`
- `X-Wkil-Timestamp`
- `X-Wkil-Signature: v1=<hex digest>`

The signature is HMAC-SHA256 over `${timestamp}.${rawRequestBody}`. Verification must use the exact raw request bytes and constant-time comparison. The timestamp must be inside a small replay window. Secrets are encrypted at rest using the existing token-encryption approach.

Valid events are persisted in the event inbox before a `202` response. Invalid signatures are rejected without persistence. Duplicate events return a successful response without creating another processing job. If database persistence fails, the endpoint returns `5xx` so the source can retry.

The body `eventId` and `Idempotency-Key` must match. This prevents a caller from accidentally reusing an idempotency key for a different order event.

Secret rotation supports current and previous secrets for a short overlap period. The dashboard must provide rotation and revocation.

## Data Model

The exact Prisma names may follow existing repository conventions, but the design requires these separate records and constraints.

### `OrderIntegration`

Stores the business-level integration configuration:

- Business profile relation
- Integration kind and opaque public key
- Encrypted current and previous signing secrets
- Optional HTTPS status-callback URL and encrypted current and previous callback secrets
- Active flag
- Store synchronization enabled flag
- Business default locale
- Created and updated timestamps

The public key is unique. Management access is scoped through the existing accessible-business-profile authorization.

### `OrderEvent`

Immutable webhook inbox record:

- Integration relation
- External event ID
- Event type and schema version
- Occurred-at timestamp
- Raw JSON payload
- Processing status: `RECEIVED`, `PROCESSING`, `PROCESSED`, or `FAILED`
- Attempt count, last error, received-at, processed-at

Enforce uniqueness on `(integrationId, externalEventId)`. Store raw payloads with a defined retention policy and redact them from application logs.

### `Order`

Canonical order snapshot:

- Business profile and integration relations
- External order ID and display order number
- Internal status: `AWAITING_CONFIRMATION`, `CONFIRMED`, or `CANCELED`
- Normalized customer phone, name, and locale
- Decimal-safe total and ISO currency code
- Line items JSON, optional shipping address JSON, and provider metadata JSON
- Source order status and timestamps

Enforce uniqueness on `(integrationId, externalOrderId)`. Index business profile, status, customer phone, and updated-at for dashboard and reconciliation queries.

### `OrderNotification`

Represents one outbound order-related message:

- Order relation
- Kind: `CONFIRMATION_REQUEST` or `ACKNOWLEDGEMENT`
- Locale and template configuration relation
- Rendered variable snapshot
- Delivery status: `QUEUED`, `SENDING`, `SENT`, `DELIVERED`, `READ`, or `FAILED`
- Provider message ID
- Shared conversation-message relation when available
- Attempt count, last error, and timestamps
- Unique idempotency key

The confirmation request has one active notification per order. Acknowledgement creation is also idempotent.

### `OrderActionToken`

Stores one hashed opaque token per action and order:

- Order and originating notification relations
- Action: `CONFIRM` or `CANCEL`
- Token hash with a unique index
- Used-at timestamp
- Created-at timestamp

Tokens do not expire while the order is pending, because unanswered orders remain pending. They become invalid once the order leaves `AWAITING_CONFIRMATION`. The button payload must contain only the opaque token and action context, never a raw order ID.

### `OrderStoreSync`

Tracks external status synchronization independently:

- Order relation
- Requested target status
- Status: `DISABLED`, `PENDING`, `SUCCEEDED`, or `FAILED`
- Provider idempotency key and provider status
- Attempt count, last error, next attempt, and timestamps

### `OrderTemplateConfig`

Stores a business/account-specific approved template mapping:

- WhatsApp account relation
- Event kind and locale
- Meta template name and language code
- Template version and active flag
- Canonical-field-to-variable mapping JSON
- Last known approval status and synchronization timestamps

Template configuration is validated against the current approved templates returned by Meta before activation.

### `WhatsAppSuppression`

Stores customer opt-outs independently from order state:

- Business profile relation
- Normalized phone
- Suppression reason and source
- Created-at and optional cleared-at timestamps

The suppression list is checked before every outbound message. Explicit opt-in is not required by the MVP flow, but opt-out handling is mandatory.

## State And Concurrency Rules

Processing an accepted `order.created` event uses a database transaction to:

1. Claim or confirm the unique event inbox record.
2. Upsert the canonical order by integration and external order ID.
3. Create the confirmation workflow only if one does not already exist.
4. Create notification and action-token records with deterministic idempotency keys.
5. Mark the event as processed or leave it recoverable when downstream enqueueing fails.

A recovery scanner re-enqueues persisted `RECEIVED` or recoverable `FAILED` events that have no active job. This avoids losing work when a process exits after the database transaction and before BullMQ accepts a job.

Button processing uses a conditional update that requires `status = AWAITING_CONFIRMATION`. The first transaction that succeeds owns the response. Later valid tokens do not mutate the order. They may receive a current-state acknowledgement, but cannot reverse a confirmation or cancellation.

The customer response is committed locally before any store API call. Store synchronization is an independent job and never rolls back the customer response.

## WhatsApp Messaging

### Confirmation Request

For every eligible order:

1. Validate the E.164 phone and minimum canonical fields.
2. Resolve customer locale, then business default locale.
3. Resolve the active approved utility template for the WhatsApp account and locale.
4. Validate all template variables against the allowed canonical fields.
5. Generate Confirm and Cancel action tokens.
6. Send through the existing WhatsApp Cloud API service.
7. Persist the provider message ID and delivery state.
8. Save a shared-inbox message with `origin = order_confirmation` so the merchant can audit it.

The template can include merchant-selected fields such as customer name, order number, item summary, total, currency, and delivery details. It must include Confirm and Cancel quick-reply buttons. Display text is not used as the action identity.

### Customer Response

The existing WhatsApp webhook is extended to extract `interactive.button_reply` payloads. The order module validates:

- Meta webhook signature
- Token hash
- Business integration
- Target phone number
- Target order
- Current order state

After a successful transition, Wkil sends a localized acknowledgement and records it as a separate notification. The immediate acknowledgement can use free-form text because the customer just interacted. If a delayed retry is outside the active customer-service window, an approved acknowledgement template is required.

### Message Rules

- No arbitrary per-order template text is generated outside approved Meta templates.
- Template variables are rendered from the canonical order snapshot.
- Currency and totals are formatted according to the selected locale and currency.
- Secrets, action tokens, and unnecessary personal data never appear in message logs.
- Customer opt-out messages are recognized and added to suppression before future sends.

## External Store Synchronization

When a business enables synchronization, a Confirm response requests the provider's confirmed status and a Cancel response requests its canceled status. The status mapping belongs to the `OrderStatusAdapter`, not to the WhatsApp channel.

For the generic integration, synchronization uses the configured HTTPS status-callback URL. Wkil sends a signed `order.status_changed` callback containing the canonical order ID, external order ID, target status, event ID, and idempotency key. The merchant store is responsible for applying that status to its order. The callback URL is configured by an authenticated business user, must use HTTPS, and is subject to SSRF protections. Callback secrets support the same short overlap rotation model as inbound secrets. Future Shopify, Salla, and EasyOrders adapters can replace this callback with their native APIs without changing the order workflow.

Every request carries an idempotency key derived from the Wkil order and target status. The adapter must distinguish:

- Successful provider acknowledgement
- Already-applied status
- Retryable timeout, rate limit, or server failure
- Permanent authorization, validation, or unsupported-status failure

The dashboard must make the synchronization capability explicit. Enabling sync for a generic integration requires a valid status-callback URL and callback secret. If no callback is configured, the setting remains disabled rather than appearing enabled but doing nothing.

The local order response remains authoritative for the Wkil workflow. A provider outage sets synchronization to `PENDING` or `FAILED` and never asks the customer to repeat a response. Repeated failures are visible to the merchant and operators.

## Reliability And Security

Webhook handling:

- Verify HMAC over the exact raw body.
- Enforce the timestamp replay window.
- Persist before returning `202`.
- Return success for recognized duplicates without reprocessing.
- Return `5xx` for persistence failures.
- Never call an external provider in the request path.

Queue handling:

- Retry network, timeout, Meta `429`, and transient `5xx` failures with exponential backoff and jitter.
- Do not retry invalid phones, malformed canonical data, rejected templates, invalid tokens, or permanent authorization failures.
- Store every attempt and provider error code.
- Expose exhausted jobs as actionable failed records.
- Apply per-business concurrency and rate limits.
- Recover jobs stuck in `SENDING` after a worker crash.

Observability:

- Emit structured logs with correlation ID, business profile ID, integration ID, event ID, order ID, notification ID, provider ID, and job ID.
- Redact access tokens, signatures, secrets, action tokens, and unnecessary PII.
- Add metrics for event acceptance, normalization failures, confirmation latency, Meta delivery, button response rate, store-sync success, retries, failures, and opt-outs.
- Send worker failures to the existing Sentry integration.

## Backend APIs

Public:

- `POST /v1/order-integrations/:integrationKey/events`

Authenticated management APIs:

- `GET /v1/order-integrations`
- `POST /v1/order-integrations`
- `PATCH /v1/order-integrations/:id`
- `POST /v1/order-integrations/:id/rotate-secret`
- `GET /v1/order-confirmations/templates`
- `GET /v1/order-confirmations/template-configs`
- `POST /v1/order-confirmations/template-configs`
- `PATCH /v1/order-confirmations/template-configs/:id`
- `GET /v1/order-confirmations/orders`
- `GET /v1/order-confirmations/orders/:id`
- `POST /v1/order-confirmations/notifications/:id/retry`
- `POST /v1/order-confirmations/sync/:id/retry`

All management routes reuse existing authentication, accessible business-profile resolution, role checks, validation middleware, and error handling. OpenAPI must be updated in the same change, followed by generated frontend types.

## Merchant Experience

The dashboard adds an Order Confirmations area with:

- Enable/disable controls
- Webhook URL and integration key
- One-time secret reveal, rotation, and revocation
- Canonical payload example and test-event action
- Store synchronization toggle
- HTTPS status-callback URL and callback-secret rotation when generic synchronization is enabled
- Business default locale
- Approved template selection per locale
- Placeholder mapping to allowed order fields
- Sample rendered-message preview
- Template approval and missing-variable errors
- Order list filtered by confirmation and sync state
- Delivery, event-processing, and synchronization failures
- Safe retry actions
- An audit panel showing raw event, normalized order, template variables, response, provider IDs, and timestamps

English and Arabic translations are required for all new states, errors, and controls. The UI must not allow a retry that can create a second confirmation after an order has already been handled.

## Testing

Unit tests:

- HMAC signing, raw-body verification, timestamp window, and secret rotation
- Canonical schema validation and provider normalization
- E.164 phone validation and locale fallback
- Template variable mapping and missing-variable errors
- Action-token hashing and scope checks
- State transitions and first-response-wins concurrency
- Retry classification and idempotency-key generation

Integration tests:

- Valid, invalid, expired, and duplicate webhook requests
- Durable event persistence before acknowledgement
- BullMQ enqueueing and recovery scanning
- Duplicate order events and duplicate button deliveries
- Meta send success, rate limit, rejected template, invalid token, and network timeout
- Store synchronization success, already-applied status, transient failure, and permanent failure
- Shared-inbox message persistence and delivery-status updates

Contract tests:

- Canonical order-event schema
- OpenAPI route and schema alignment
- Generated frontend type synchronization

End-to-end and operational tests:

- Signed generic webhook to Meta test-number confirmation
- Confirm and Cancel button flows
- Customer opt-out suppression
- Worker crash recovery
- Tenant isolation, per-business rate limits, and queue load

## Rollout

1. Add tables, enums, indexes, and constraints through a backward-compatible Prisma migration.
2. Deploy backend code with the feature disabled by default.
3. Add OpenAPI and generated frontend types before enabling dashboard controls.
4. Validate WhatsApp account, approved templates, locale mappings, and test event before activation.
5. Enable a small internal cohort.
6. Monitor delivery, response, synchronization, failure, and opt-out metrics.
7. Expand by business after operational review.

Provide both a per-business kill switch and a global operational kill switch. Test events must never contact a real customer.

## Acceptance Criteria

- A valid signed `order.created` event is durably accepted and processed asynchronously.
- The same event delivered repeatedly creates one order and one confirmation request.
- A configured approved template renders selected order fields and two opaque action buttons.
- A valid Confirm or Cancel response creates exactly one state transition.
- Duplicate or stale button replies cannot reverse the first response.
- Every handled response produces one acknowledgement or a visible retryable failure.
- Store synchronization is optional, idempotent, independently retryable, and never loses the local response.
- Invalid signatures, malformed events, invalid phones, missing templates, and permanent provider failures are visible without infinite retries.
- Customer opt-outs suppress future messages.
- Arabic and English locale fallback works as configured.
- The feature can be disabled per business or globally without data loss.
- The system remains auditable from source event through order state, WhatsApp delivery, customer action, acknowledgement, and store synchronization.

## Deferred Extensions

- Shopify adapter
- Salla adapter
- EasyOrders adapter
- Custom mapping UI that transforms arbitrary provider payloads into the canonical schema
- Automated Meta template creation, submission, and approval polling
- Reminder notifications
- Order lifecycle events such as processing, shipped, delivered, refund, and payment failure
- Additional messaging channels such as SMS or email
