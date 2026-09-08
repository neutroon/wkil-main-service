# Task 3 implementation report

## Changed files

- `src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.ts`
  - Added `syncCoexistenceContacts(input)` against Task 1's exact normalized `WhatsappCoexistenceContactsJob` contract.
  - Resolves `businessProfileId` from the persisted active WhatsApp account using the job's `phoneNumberId`; callers do not enrich the job with undocumented fields.
  - Handles add, edit, and remove events using the existing customer identity upsert path and supports nested Task 1 contact fields (`wa_id`, `phone_number`, and `full_name`).
  - Claims each event/contact identity in `WhatsAppCoexistenceContactEvent` inside the same Prisma transaction as customer persistence and external-identity attachment.
  - Uses the database unique constraint to suppress repeated and concurrent deliveries; a failed transaction rolls back the claim so a retry can complete.
  - Writes removals as `metadata.whatsappCoexistence.state = "REMOVED"` with a tombstone marker and timestamp, and clears tombstone fields plus legacy JSON event markers on a later add/edit.

- `src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts`
  - Added focused tests for contact add/edit/remove, normalized phone identity, exact Task 1 job input, active-account profile resolution, external identity preservation, explicit null create payloads, repeated delivery, concurrent delivery, transaction rollback/retry, tombstone clearing, live interaction behavior, and historical activity timestamps.

- `src/modules/business/customer/customer.service.ts`
  - Allows `upsertCustomerFromConversation` to run on a supplied Prisma transaction client without changing live callers' default client.
  - Preserved current-time `lastInteractionAt` updates for existing live callers by default.
  - Allows Coexistence/history callers to opt out of current-time interaction updates, explicitly sends `lastInteractionAt: null` for a new no-activity opt-out create, and handles nullable timestamps when merging identities.

- `src/modules/meta/whatsapp/whatsappCoexistence.service.ts`
  - Validates and dispatches normalized contact jobs to `syncCoexistenceContacts(input)`.
  - Leaves the Task 2 history importer stub unchanged.

- `src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts`
  - Verifies contact jobs dispatch while history jobs retain the existing stub failure.

- `src/modules/content/contentBrief.service.ts`
  - Omits the evidence `createdAt` field when a customer's nullable `lastInteractionAt` is null, while preserving the existing ISO timestamp for non-null activity.

- `src/modules/content/contentBrief.service.test.ts`
  - Adds a regression test proving null activity does not throw and the customer signal remains available.

- `prisma/schema.prisma`
  - Makes `Customer.lastInteractionAt` nullable and adds the dedicated durable Coexistence event-claim model/relation.

- `prisma/migrations/20260908140000_nullable_customer_interaction_and_coexistence_event_claims/migration.sql`
  - Drops the `Customer.lastInteractionAt` default and `NOT NULL` constraint.
  - Creates the unique, indexed `WhatsAppCoexistenceContactEvent` ledger with a cascading business-profile foreign key.

## Tests run

The earlier review-fix RED run for the create payload was:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts -t "adds a contact using the normalized phone identity"

1 failed, 6 skipped
Expected `lastInteractionAt` to be `null`, received `undefined`.
```

This round's worker-boundary RED run was:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts -t "dispatches normalized contacts"

1 failed, 6 skipped
The promise rejected with "whatsapp coexistence contacts importer is not installed".
```

The atomic-delivery RED run was:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts -t "atomic durable event claim|rolls back an event claim"

2 failed, 9 skipped
The concurrent call processed twice and the retry path created zero durable event claims.
```

After implementation, the contact tests passed:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts

Test Files  1 passed (1)
Tests       11 passed (11)
```

The final relevant Vitest command was rerun with temporary required test environment variables (no environment files were changed):

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts src/modules/business/customer/customer.service.test.ts src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts

Test Files  3 passed (3)
Tests       41 passed (41)
```

`npx prisma generate` also completed successfully after the schema change. The full backend suite was not run; validation remained limited to the relevant Task 3 Vitest files as requested.

The follow-up nullability RED/GREEN cycle was:

```text
npm test -- src/modules/content/contentBrief.service.test.ts -t "keeps a customer signal"

1 failed, 3 skipped
TypeError: Cannot read properties of null (reading 'toISOString')

npm test -- src/modules/content/contentBrief.service.test.ts -t "keeps a customer signal"

1 passed, 3 skipped
```

The focused TypeScript audit completed successfully:

```text
npx tsc --noEmit --pretty false

TypeScript exit code: 0
```

The final focused Vitest run covered the Task 3 services and the required nullable caller:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts src/modules/business/customer/customer.service.test.ts src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts src/modules/content/contentBrief.service.test.ts

Test Files  4 passed (4)
Tests       45 passed (45)
```

## Design decisions

- Customer synchronization reuses `upsertCustomerFromConversation` so phone normalization, business scoping, external identity attachment, and existing customer merge conventions remain centralized.
- Contact synchronization passes `updateInteraction: false`; new no-activity creates explicitly carry a null `lastInteractionAt` payload, while existing add/edit operations do not receive a current-time interaction update.
- `activityAt` is independent of the opt-out: a valid historical timestamp can advance customer activity, but never regress a newer timestamp.
- The normalized job remains the single caller contract. The service obtains profile ownership from the active `WhatsAppAccount` identified by `phoneNumberId`.
- Durable idempotency is a unique event ledger claim in the same transaction as customer and external-identity writes. The marker is event-based when available and otherwise deterministic from contact action, external ID, and normalized phone.
- The transaction client is passed through the shared customer upsert path, preserving atomicity without changing default live-caller behavior.
- Removes never delete customers, external identities, conversations, or messages. They record a tombstone in customer metadata; a later add/edit clears the tombstone and removes legacy JSON event-marker data.
- Nullable customer activity is represented as an omitted evidence timestamp in content briefs; non-null activity continues to serialize as the same ISO timestamp.
- No WhatsApp SDK or third-party WhatsApp library was added. History queue behavior remains unchanged.

## Unresolved concerns

- The dedicated event ledger retains one unique identity row per processed event; a retention policy must not purge rows needed for the desired lifetime of redelivery idempotency.
- The tombstone shape is local to this importer (`metadata.whatsappCoexistence.state/removed/removedAt`) and should be treated as the downstream contract for any UI or reporting consumer.
- Full backend tests were not run because the known baseline lacks environment variables. Task 1 files and unrelated queue/controller edits were left untouched.
