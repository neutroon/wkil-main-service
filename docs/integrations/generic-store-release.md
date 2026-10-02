# Generic integration release and recovery

The coordinated implementation spans WKIL backend/web and the reference store
backend/admin. Changes and commits are local; no push or deployment has been
performed. The migrations below have been exercised only against disposable
PostgreSQL data, not production. See the verification record for results and
the WKIL historical migration limitation. The store backend preserves main's
Meta tracking changes and inserts both event records in the order transaction.

## Deployment order

1. Apply WKIL's additive `20261002000000_order_notification_diagnostics` migration
   through the normal reviewed deployment process, then deploy the WKIL backend.
   Generate its Prisma client and integration assets during the build. Keep the
   existing schema-version-1 ingestion endpoint available.
2. Deploy WKIL web with the generated OpenAPI types. Downloadable guide/schema,
   field catalog, validation, and nullable failure diagnostics depend on the new
   backend. Choose **Shipping Address / عنوان الشحن** (`shippingFullAddress`) only
   when the desired message variable should contain the address. Saved country
   mappings are preserved.
3. Apply the reference store's additive `20261002000000_add_wkil_outbox` migration
   before deploying its backend. Generate that repository's Prisma client. Its
   checkout transaction now inserts outbox records and requires the new table.
   Start the worker after database connection succeeds.
4. Deploy the store admin, save the canonical HTTPS ingestion URL and signing
   secret, and run **Check connection** using synthetic data. The connection may
   be inactive for setup. Enable real events after schema and template readiness
   succeed. Missing setup endpoints return `WKIL_UPGRADE_REQUIRED`; there is no
   fallback that sends a live test confirmation.

`202` means the signed event was durably accepted. It does not establish WhatsApp
delivery. Confirm notification sent/delivered/read status separately in WKIL.
No production credentials or order data are needed for local setup verification.

## Store queue operation

- Poll at startup and every ten seconds. Claim at most five rows using
  PostgreSQL `FOR UPDATE SKIP LOCKED`, with two-minute leases and at most two
  concurrent eight-second HTTP requests.
- Read current configuration before each transport. Disabled connections pause
  delivery; secret rotation uses the current secret. A different connection URL
  blocks an existing record rather than sending it to a different destination.
- Retry network/timeout, `408`, `429`, and `5xx` using the same event ID and JSON
  bytes. Sign each request with a fresh timestamp. Automatic cycles have at most
  ten attempts, exponential backoff starting at five seconds, ±20% jitter, and a
  fifteen-minute ceiling including `Retry-After`. Other rejection statuses block.
- Lease-token and expiration checks protect attempt starts and completions.
  Reclaimed work may replay an accepted-but-unacknowledged request. WKIL's event
  deduplication makes that replay safe without rebuilding an edited order.
- Deleting an order revokes active work in the deletion transaction. Safe audit
  metadata remains; the order reference becomes null. Accepted records cannot be
  retried from the store admin.
- After thirty days, bounded cleanup removes private JSON bytes from terminal
  accepted/blocked/exhausted rows. It retains status metadata and preserves
  pending/sending work. Attempted records without retained bytes cannot be retried.

## Correcting blocked records

Read the stable failure code and field paths in the store admin or WKIL order
details. Fix the source fields or template mapping, then use the explicit retry
control. Retry validates the payload and current configured template before
releasing the record. An unsent, zero-attempt record can rebuild from corrected
source data; once attempted, its original bytes remain fixed. A manual retry
starts a new capped retry cycle while retaining the lifetime attempt count.
Use the delivery status filter and **Load older deliveries** to find failures
that are older than the latest page. Connection fields stay locked while a setup
check is pending so its result applies to the displayed saved connection.

Changed destinations require a separate reviewed recovery operation. This admin
flow does not reassign old work to a new tenant or integration. Likewise, replay
of an accepted event does not update the existing WKIL order snapshot. Historical
order data repair, including the originally reported order, requires a separate
authorized procedure; creating a different event ID to force a second message
is not a repair.

## Rollback and verification limits

Disable the store connection to pause delivery before rolling back its worker.
Keep additive tables/columns during application rollback. Returning to the old
store backend also restores its old notification behavior and stops creating
outbox records, so coordinate the rollback instead of running both sender paths.
Stop the worker gracefully before disconnecting Prisma. Pending payloads contain
private order data; apply the repository's database access and backup controls.

Local conformance executes the actual store payload builder and WKIL schema and
field renderer with synthetic values. Browser checks intercept APIs and block
external calls. An independent loopback PostgreSQL cluster applied all 51 store
migrations and verified bounded/disjoint claims, lease fencing, source deletion,
and both outboxes' commit/rollback and idempotency behavior. WKIL's exact additive
diagnostics migration preserved a seeded pre-change row and passed Prisma
read/write/clear checks. Full WKIL migration history requires the existing
pgvector extension, which the portable test server lacks. No production
deployment or live message delivery has been performed.
