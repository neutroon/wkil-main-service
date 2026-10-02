# Connect a store to WKIL

Use the generic API for schema version `1`. Each connection has a separate public
integration key and signing secret. Keep the secret on the store backend.
Templates are selected by business profile, WhatsApp account and locale. Stores
sharing an account share its template configuration.

## Setup without contacting customers

From your server, send signed raw JSON to:

- `POST /v1/order-integrations/:integrationKey/requirements` with
  `{"schemaVersion":"1","locale":"ar"}` (locale is optional).
- `POST /v1/order-integrations/:integrationKey/validate` with a complete synthetic
  order event. Include `Idempotency-Key` matching `eventId`.

Both endpoints allow configured inactive connections. Requirements reports the
resolved template, its variable mapping and canonical source paths. Validation
checks the schema and every mapped field and returns a rendered preview. It
does not save an order, reserve an event ID, send WhatsApp or invoke a callback.
Use invented values such as the example below; never send production data for setup.

```json
{"schemaVersion":"1","eventId":"synthetic-order-1","eventType":"order.created","occurredAt":"2026-10-02T00:00:00Z","order":{"id":"synthetic-1","number":"TEST-1","currency":"EGP","total":"349.00","customer":{"name":"Test Customer","phone":"+201000000000","locale":"en"},"items":[{"id":"item-1","name":"Test Product","quantity":"1","unitPrice":"349.00","total":"349.00"}],"shippingAddress":{"addressLine1":"Test Street 1","city":"Cairo","country":"Egypt"},"sourceStatus":"pending","paymentMethod":"cod"}}
```

## Signing and ingestion

Serialize once. Calculate HMAC-SHA256 using the signing secret over
`timestamp + "." + exactRawJsonBytes`. Send these headers:

```text
Content-Type: application/json
X-Wkil-Timestamp: <Unix seconds>
X-Wkil-Signature: v1=<hex HMAC digest>
Idempotency-Key: <eventId>  # required for validate and events
```

Timestamp tolerance is five minutes. Regenerate timestamp/signature for each
request. Current and previous secrets are supported during rotation. Setup is
limited to 30 authenticated requests per integration per minute; honor Retry-After.

After validation, enable the connection and send real new events to
`POST /v1/order-integrations/:integrationKey/events`. `202` acknowledges durable
event acceptance, with `accepted`, `duplicate` and `eventId`; WhatsApp delivery is
tracked separately. Persist an outgoing event in the order transaction and send it
from a bounded worker. After a timeout or crash, retry the same event ID and exact
payload bytes. Never change attempted payloads or invent a new creation event ID
to force a second notification. Successful duplicate acceptance does not repair
an existing stored order. Use a separate authorized recovery process for old data.

## Fields and actionable errors

Money and quantity are non-negative decimal **strings**, phones use E.164, and
unknown properties are rejected. Optional fields may be omitted; supplied text
must be nonblank. A valid base schema does not guarantee template readiness.
Country strings such as `Egypt` and `EG` are accepted without inference.
`shippingCountry` reads `order.shippingAddress.country`.
`shippingFullAddress` reads the structured address and requires `addressLine1`;
city, state, postal code and country supplement it. Select **Shipping Address /
عنوان الشحن** in WKIL to send an address. Existing country selections stay unchanged.

```json
{"code":"TEMPLATE_DATA_INCOMPLETE","message":"Some mapped template fields have no usable value","retryable":false,"errors":[{"component":"body","placeholder":"5","field":"shippingCountry","paths":["order.shippingAddress.country"],"reason":"missing"}]}
```

`200` validation means schemaValid/templateReady are true. `400` means invalid
input; `401` invalid/expired signature; `404` unknown connection; `409` missing
account/template; `422` missing mapped values; `429` rate limit; `503` temporary
setup failure. Correct permanent errors before retrying. Missing setup endpoints
mean WKIL needs upgrading; never fall back to a live ingestion test.

Download the schema and this guide from authenticated WKIL setup. OpenAPI is the
source of truth; generated schema and TypeScript examples come from it.
