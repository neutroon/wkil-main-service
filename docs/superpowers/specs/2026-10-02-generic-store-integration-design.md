# Generic Store Integration: First SaaS Release

Date: 2026-10-02 (Africa/Cairo)
Status: Approved by the user in this chat on 2026-10-02; implementation plan awaiting review
Owning repositories: WKIL `back-end/`, WKIL `app/`, and the reference store's `backend/` and `admin/`

## Intent and approved rollout

The user selected **generic API plus this store first**, with platform-specific
connectors reserved for later. The purpose is to let more stores connect to WKIL
through a consistent, testable contract without needing WKIL production data or
knowing how WhatsApp messages are constructed.

Success means a store developer can discover the selected template's data
requirements, validate a synthetic order, and receive actionable field errors.
Merchants can select a full shipping address as a message variable. Order events
survive store process restarts and duplicate delivery. Existing integrations
continue to work.

This document specifies the proposed first release. Selecting the rollout did
not authorize deployment, production repairs, publishing packages, or commits.
Implementation starts after specification review and the implementation-plan
review required by the brainstorming workflow.

## Verified baseline

- WKIL accepts signed `order.created` events, stores them before returning `202`,
  and uses PostgreSQL, Redis, and BullMQ for asynchronous processing and recovery.
- Event deduplication is scoped to `(integrationId, externalEventId)`. Orders are
  scoped to their integration and business profile.
- Templates currently belong to a business profile and WhatsApp account, with
  selection by event type and locale. Stores sharing an account therefore share
  its active template policy. This release preserves that scope explicitly.
- The general order schema makes customer name, items, and address parts optional.
  The renderer can turn missing mapped fields into empty strings. Template
  completeness is not currently enforced before the Meta request.
- The reference store's previous builder omitted `shippingAddress.country`.
  Existing uncommitted changes now supply `Egypt`, validate required source
  fields, and use the real builder for its connection test. Preserve these changes.
- This store restricts checkout destinations to Egyptian governorates. Its
  `shippingGov` is currently sent as canonical `city`; document this existing
  convention rather than silently changing the meaning of stored orders.
- Checkout and abandoned-cart conversion call a non-durable background webhook
  sender after order creation. It retries three times in memory, without a request
  timeout, and does not inspect remote error details.
- The store's connection test currently sends a real ingestion event. An accepted
  event can queue a WhatsApp message; this is unsuitable as the default setup test.
- WKIL currently supports seven message fields and no full-address field.

Fresh audit checks completed before writing this specification:

- Store: 21 tests passed across `wkilWebhook.test.ts`, `wkil.test.ts`, and
  `wkil-hook.test.ts` using mocked delivery and database operations.
- WKIL: 33 tests passed across template rendering, normalization, public
  ingestion, and the WhatsApp adapter.
- An isolated cross-repository probe ran the current store's synthetic payload
  through WKIL's actual normalizer and renderer, with persistence stubbed.
  Both locales produced zero empty values across all seven current fields.
- Removing country still passed the canonical schema and reproduced an empty
  fifth parameter with the reported mapping.

These checks do not establish production deployment or live message delivery.

## Architecture and alternatives

Extend the existing modular integration. Do not introduce a new microservice,
broker, independent canonical schema, or template logic inside stores.

```text
Store order transaction
  -> durable outgoing event
  -> signed canonical order event
  -> WKIL durable event inbox
  -> template completeness check
  -> existing WhatsApp queue and delivery tracking

Store developer
  -> signed requirements discovery
  -> signed validation with synthetic order
  -> requirements, preview, and field errors; no message is sent
```

Two viable rollout approaches were considered:

1. **Generic contract and reference store first (selected):** reuse the deployed
   boundary, prove developer onboarding and delivery reliability, then build
   platform adapters against this contract.
2. **Platform connectors immediately:** reduce custom coding for one chosen
   platform, but require provider authentication, lifecycle, and webhook work
   before the shared contract and testing flow are proven.

## One canonical contract

`back-end/docs/openapi.yaml` remains the public HTTP source of truth. The runtime
validator must agree with it, and conformance tests must detect drift. The older
feature design document is historical context, not an alternative payload guide.

Retain schema version `1`, the existing event envelope, signed ingestion URL, and
the decimal-string and E.164 conventions. The store sends order facts, not
placeholder arrays or preformatted WhatsApp text.

Address properties remain `addressLine1`, `addressLine2`, `city`, `state`,
`postalCode`, and `country`. Existing nonblank country strings, including `Egypt`
and `EG`, remain accepted. This release does not introduce a country-code-only
requirement or silently infer destination from a phone number. Each store's
adapter is responsible for representing its actual supported destinations.

Do not make every optional order field globally required. Distinguish:

- **Schema validity:** required envelope/order fields, types, formats, and
  nonblank supplied values.
- **Template readiness:** every variable selected by the merchant can be rendered
  from this order and satisfies its field-specific requirements.

Transport acknowledgement remains `202 { accepted, duplicate, eventId }` after
durable acceptance. It is not a message-delivery or template-readiness guarantee.
Existing event ingestion does not synchronously depend on Meta availability.

## Central template-field registry

Introduce one typed registry in WKIL's order-confirmation module. Each entry has
a stable field ID, source paths, availability rules, rendering function, and
English/Arabic labels. Template rendering, requirements discovery, validation,
and the web mapping selector consume that registry or its generated public
description. Keep source-path reads allowlisted; do not resolve arbitrary paths
supplied by an external caller.

| Field | Input requirements |
| --- | --- |
| `customerName` | Nonblank `order.customer.name` |
| `orderNumber` | Nonblank `order.number` |
| `itemSummary` | At least one nonblank `order.items[].name` |
| `quantity` | At least one valid item quantity; retain exact decimal summation |
| `total` | Valid `order.total` and `order.currency`; retain existing locale formatting |
| `shippingCity` | Nonblank `order.shippingAddress.city` |
| `shippingCountry` | Nonblank `order.shippingAddress.country` |
| `shippingFullAddress` | Nonblank `order.shippingAddress.addressLine1`; other address parts supplement it |

Add **Shipping Address / عنوان الشحن** as the label for `shippingFullAddress`.
Do not change saved `shippingCountry` mappings to the new field automatically.

The full-address formatter trims supplied components, normalizes embedded
whitespace to a single line, skips absent optional parts, and joins the ordered
street lines, city, state, postal code, and country with readable separators.
Use `، ` for Arabic and `, ` for English. Suppress identical normalized components
without trying to extract a city from street text. A city or country alone must
not pass the full-address requirement. Do not invent missing components.

No wire-payload change is necessary for this new field. It is derived by WKIL from
the already supported structured address.

## Developer discovery and validation

Add two signed, integration-scoped endpoints beneath the existing public mount:

- `POST /v1/order-integrations/:integrationKey/requirements`
- `POST /v1/order-integrations/:integrationKey/validate`

Reuse HMAC-SHA256 over `timestamp.rawBody`, timestamp tolerance, constant-time
comparison, and current/previous-secret rotation behavior. Possessing an
integration key alone grants no access. Do not return secrets or other stores'
settings. Integration lookup must support a configured, inactive integration for
these two read-only setup operations; ingestion must still require it to be active.

Requirements accepts `{ "schemaVersion": "1", "locale": "ar" }`, where locale
is optional and otherwise uses the integration default. The event type is fixed
to `order.created` for this release. Return schema version, supported field IDs,
and the resolved configured template's locale, mapping, and source requirements.
Describe the actual configured template, not a hardcoded list of five positions.
Use the same locale fallback policy as live sending and report the resolved locale.

Validation accepts the same canonical event and signing/idempotency headers as
ingestion. The idempotency header must match the event ID, but validation does not
reserve that ID. It runs schema validation, template resolution, availability
checks, and rendering. It must never persist an order, enqueue a notification,
call Meta, create action tokens, or invoke a store callback. It returns a preview
only of the data supplied by the caller; it does not fetch a production order.

Use one shared validation service for public validation, the existing authenticated
WKIL test-event endpoint, and live sending. This prevents test and live behavior
from drifting. Requirements/validation use local approved-template configuration,
not a remote template fetch on each request. Final Meta delivery remains subject
to Meta's current template status.

### Response and error contract

Successful validation returns `200` with schema validity, template readiness,
resolved locale, rendered preview, and each variable's field/path and presence.
Missing mapped values return `422` with stable structured errors. Invalid JSON,
event syntax, or idempotency headers return `400`; signature failure returns
`401`; unknown integration returns `404`. Missing account/template configuration
returns `409` with a configuration code. Bound request and response sizes using
the repository's existing limits and apply an integration-scoped rate limit to
the new setup endpoints.

Example template error:

```json
{
  "code": "TEMPLATE_DATA_INCOMPLETE",
  "message": "Some mapped template fields have no usable value",
  "retryable": false,
  "errors": [
    {
      "component": "body",
      "placeholder": "5",
      "field": "shippingCountry",
      "paths": ["order.shippingAddress.country"],
      "reason": "missing"
    }
  ]
}
```

Placeholder identity is a string to accommodate existing mapping keys. Errors
include paths, not customer values, addresses, credentials, or provider traces.
Schema errors use the same `errors` envelope with source path and reason.

The store's **Test connection** calls requirements and validation with a synthetic
order built through the real payload builder. It displays both contract and
template results. A successful transport response alone is insufficient. A live
test send stays a separate, deliberate merchant action rather than part of setup.

## Live failures and retries

Validate mapped values before acquiring the send permit, incrementing provider
attempts, or calling Meta. Save actionable failure information even when validation
prevents sending. Add nullable `failureCode` and `failureDetails` to notification
persistence and the managed notification response. Keep a readable `lastError`
for existing clients. Clear the structured fields on a successful retry.

The web order detail view displays placeholder, field label, source path, and
reason in both languages. Failed validation is not counted as a Meta send attempt.
Avoid misleading empty parameter lists or previews that hide missing values.

Missing-data failures terminate automatic notification retries. Temporary provider
failures follow a classified retry policy; preserve existing rate-limit handling,
suppression checks, and ambiguous-delivery protection. Never automatically resend
an ambiguous Meta send. Manual retry revalidates the current stored order and
template before proceeding.

## Durable reference-store delivery

Introduce a Prisma outbox owned by the reference store backend. Insert a single
outgoing event in the same transaction that creates an order when WKIL delivery
is enabled. Cover checkout and abandoned-cart conversion. Idempotent order replay
must not insert a second outgoing event.

Each record contains a unique stable event ID, order reference, canonical payload,
target connection identity, state, attempt count, next
attempt time, lease token/expiry, safe last error, and acceptance timestamp.
Never store signing secrets in the event. Read the current secret for each attempt.
If payload construction fails, retain a blocked record referencing the order and
field error so the order itself still completes. Correcting an unsent blocked
record with zero transport attempts can prepare its payload. Freeze the payload
when its first transport attempt starts, including after ambiguous transport
results. Manual retries of attempted records resend the same payload; changing
accepted or possibly accepted order facts needs a separate reconciliation flow.

Proposed states: `PENDING`, `SENDING`, `ACCEPTED`, `BLOCKED`, and `EXHAUSTED`.
Index pending state/next-attempt time, and enforce unique event ID.

Run a bounded dispatcher at startup and every 10 seconds. Claim at most five rows
per poll with expiring two-minute leases and lease-token-checked updates. Prevent
overlapping polls in one process and support concurrent processes through database
claims. Send at most two requests concurrently with an eight-second timeout each.

Retry ingestion network failures, `408`, `429`, and `5xx` with capped exponential
backoff and jitter: ten attempts, initial delay five seconds, maximum delay fifteen
minutes. Respect a valid bounded `Retry-After`. Other `4xx` responses block automatic
delivery and preserve the field/configuration error. Exhausted delivery remains
visible to the store administrator. Manual retry is available only for unaccepted
records and must refresh validation/configuration before requeueing.

Serialize a payload consistently across transport attempts. Generate a fresh
timestamp/signature per attempt while retaining the event ID. A crash after WKIL
acceptance but before the outbox update is recovered by delivering the same event;
WKIL's inbox deduplication prevents a second workflow.

Disabling the connection pauses dispatch. Changing its target integration must not
silently send old pending events to a different connection or tenant. Mark affected
records blocked until the merchant explicitly chooses an authorized recovery.
Do not automatically enqueue historical orders when enabling an integration.

Expose safe status/counts and retry controls through the store's existing admin
WKIL settings API. Keep logs limited to event IDs, statuses, and error paths. Persisted
payloads require retention cleanup after terminal delivery; use a 30-day default
without deleting pending recoverable records. The dispatcher needs graceful
shutdown and a documented operational recovery procedure.

## Onboarding materials and UI

Provide a single merchant/developer setup flow:

1. Create/select the integration and WhatsApp account.
2. Configure the approved template and locale.
3. Obtain the signed endpoint credentials and downloadable integration guide.
4. Inspect actual template requirements and validate a synthetic order.
5. Enable event delivery and monitor accepted events separately from message status.

Publish documentation in the backend repository with a complete synthetic event,
all header/signature rules, schema-vs-template semantics, response examples,
retry/idempotency guidance, and the discovery/validation endpoints. Make the guide
and generated schema accessible from WKIL's existing setup UI.

Generate downloadable schemas and TypeScript examples from the OpenAPI contract;
do not hand-maintain a second canonical type package. A public npm SDK and other
language SDKs are deferred until external integrators demonstrate demand. No
package publishing or external hosting change is included in implementation.

The existing WKIL setup page gains requirements/validation results and the new
field selector. The reference store's separate `admin/` repository updates its
existing `WkilCard` and typed API client to show validation details, safe delivery
counts, blocked/exhausted event summaries, and an explicit retry control. Its
current success check on `remoteStatus` alone must also check template readiness.
Preserve Arabic/English parity and tenant authorization for all managed controls.

## Compatibility, deployment, and recovery

- Changes are additive to schema version `1`; preserve existing valid payloads,
  saved mappings, signed ingestion headers, and acknowledgment shape.
- Apply additive nullable notification diagnostic fields and the store outbox
  migration only after generated SQL review. Do not reset a database.
- Deploy WKIL's new setup endpoints before changing the store's connection test.
  If they are unavailable, display an upgrade-required result; never fall back to
  sending a live message as a connection test.
- Enable the outbox path with its worker ready and replace the previous direct
  background sender for new orders to avoid double delivery.
- The current store fix has already populated all required street/country data
  for new local payloads; full-address mapping only requires a WKIL update.
- Accepted existing events and stored WKIL order snapshots are not repaired by
  replaying the same event ID. Do not change old payloads under accepted IDs or
  use a fresh creation ID solely to force another notification.
- Production correction of order 2069 is separate authorized operational work.
  A general order-update/reconciliation API is deferred rather than hiding repair
  behavior inside `order.created`.
- Per-store template overrides for stores sharing one WhatsApp account are
  deferred. Document account-level template scope in onboarding.

## Verification and acceptance criteria

Before implementation, create failing regression tests for the agreed behavior.
Required coverage:

- Field registry, canonical paths, missing/blank values, zero totals, exact
  quantities, item collections, and static templates.
- Full address in both locales; missing street; absent optional parts; repeated
  components; embedded whitespace; no inferred address data.
- Requirements are isolated by integration/profile/account and resolve the same
  locale/template as sending, including configured inactive setup.
- Validation rejects invalid signatures and returns useful field errors while
  proving no database writes, queue sends, token creation, Meta calls, or callbacks.
- Live missing values produce persistent structured diagnostics and zero provider
  requests; permanent failures stop automatic retries; manual retry revalidates.
- Store connection tests use the real builder and never invoke ingestion.
- Outbox insertion rolls back with order creation, survives restarts, deduplicates
  replay, recovers expired leases, and safely replays acceptance-after-crash.
- Retries cover classified HTTP/network failures, timeouts, fresh signatures,
  changed/disabled connections, and terminal/manual-retry states.
- Cross-repository synthetic events pass WKIL's real validator/renderer; omission
  cases return matching paths and placeholder errors without private data.
- OpenAPI route/schema checks pass, regenerated clients agree, and both languages
  display the new field and diagnostics correctly.

Run focused checks first. WKIL backend requires `npm test`, `npm run build`, and
`npm run docs:check`; WKIL app requires relevant tests, lint, typecheck, and build.
The store backend requires its focused tests, full suite, and TypeScript build.
The store admin requires its repository-owned lint, typecheck, tests where present,
and build commands, discovered before implementation. Capture existing failures
separately. Do not claim live delivery from mocked tests.

## Documentation sources and implementation routing

Observed implementation sources are the WKIL order-confirmation module and
OpenAPI contract, its web integration forms, and the store's webhook builder,
order service, checkout routes, and existing local payload audit.

Primary external references reviewed for the proposed behavior:

- Meta utility templates: parameter values are required for body variables.
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates
- BullMQ unrecoverable failures: terminate automatic retries for permanent errors.
  https://docs.bullmq.io/patterns/stop-retrying-jobs
- Stripe webhook guidance: durable acknowledgment and duplicate handling provide
  a reference pattern; WKIL does not gain a Stripe dependency.
  https://docs.stripe.com/webhooks

Implementation must consult current exact library documentation where signatures
or runtime behavior are needed. Use version-matched Next.js docs/Next DevTools for
the WKIL and store admin UIs, React guidance as relevant, and the standard regression-test/review
skills. The integration does not involve assistant-ui, LangGraph, or Deep Agents.
The store directory is outside the writable workspace; request narrowly scoped
filesystem escalation when editing it. Preserve its existing uncommitted work.

## Review checkpoint

The user approved this written specification on 2026-10-02. Review the resulting
implementation plan and select its execution method before implementation. No
product code, deployment, production changes, or commits accompany this specification.
