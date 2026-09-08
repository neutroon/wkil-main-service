# Task 3 implementation report

## Changed files

- `src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.ts`
  - Added `syncCoexistenceContacts(input)` against Task 1's exact normalized `WhatsappCoexistenceContactsJob` contract.
  - Resolves `businessProfileId` from the persisted active WhatsApp account using the job's `phoneNumberId`; callers do not enrich the job with undocumented fields.
  - Handles add, edit, and remove events using the existing customer identity upsert path and supports nested Task 1 contact fields (`wa_id`, `phone_number`, and `full_name`).
  - Persists deterministic event/contact markers in `metadata.whatsappCoexistence.processedEventIds` and skips markers already stored on the customer, making repeated deliveries idempotent across service invocations.
  - Writes removals as `metadata.whatsappCoexistence.state = "REMOVED"` with a tombstone marker and timestamp, and clears tombstone fields on a later add/edit while retaining marker history.

- `src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts`
  - Added focused tests for contact add/edit/remove, normalized phone identity, exact Task 1 job input, active-account profile resolution, external identity preservation, explicit null create payloads, invocation-local and repeated-delivery duplicates, tombstone clearing, live interaction behavior, and historical activity timestamps.

- `src/modules/business/customer/customer.service.ts`
  - Extended `upsertCustomerFromConversation` with optional metadata, `updateInteraction`, and historical `activityAt` support.
  - Preserved current-time `lastInteractionAt` updates for existing live callers by default.
  - Allows Coexistence/history callers to opt out of current-time interaction updates, explicitly sends `lastInteractionAt: null` for a new no-activity opt-out create, and prevents an older historical timestamp from replacing newer activity.

## Tests run

The review-fix RED run was intentionally focused on the newly required create behavior:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts -t "adds a contact using the normalized phone identity"

1 failed, 6 skipped
Expected `lastInteractionAt` to be `null`, received `undefined`.
```

After implementation, the contact tests passed:

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts

Test Files  1 passed (1)
Tests       9 passed (9)
```

The final relevant Vitest command was rerun with temporary required test environment variables (no environment files were changed):

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts src/modules/business/customer/customer.service.test.ts src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts

Test Files  3 passed (3)
Tests       39 passed (39)
```

The full backend suite was not run because the worktree baseline has no required environment variables, as instructed.

## Design decisions

- Customer synchronization reuses `upsertCustomerFromConversation` so phone normalization, business scoping, external identity attachment, and existing customer merge conventions remain centralized.
- Contact synchronization passes `updateInteraction: false`; new no-activity creates explicitly carry a null `lastInteractionAt` payload, while existing add/edit operations do not receive a current-time interaction update.
- `activityAt` is independent of the opt-out: a valid historical timestamp can advance customer activity, but never regress a newer timestamp.
- The normalized job remains the single caller contract. The service obtains profile ownership from the active `WhatsAppAccount` identified by `phoneNumberId`.
- Durable idempotency is stored with the customer metadata rather than kept only in an invocation-local set. The marker is event-based when available and otherwise deterministic from contact action, external ID, and normalized phone.
- Removes never delete customers, external identities, conversations, or messages. They record a tombstone in customer metadata; a later add/edit removes the tombstone state fields without discarding processed markers.
- No WhatsApp SDK or third-party WhatsApp library was added, and no queue/controller plumbing was changed.

## Unresolved concerns

- `Customer.lastInteractionAt` is still declared non-null with a database `now()` default. The service and exact create-payload test now send `null` for the no-activity opt-out, but the current database schema/migration may reject that value; making null persistable would require a schema/migration change outside Task 3's permitted write set.
- The durable marker is persisted in customer metadata, so the marker list can grow with the number of delivered contact events and may need a retention/compaction policy later.
- Marker checking is durable for sequential queue redeliveries, but the read-then-write sequence is not an atomic claim under simultaneous workers; an event ledger or conditional database update would be needed for strict concurrent idempotency.
- The tombstone shape is local to this importer (`metadata.whatsappCoexistence.state/removed/removedAt`) and should be treated as the downstream contract for any UI or reporting consumer.
- `npx tsc --noEmit` remains blocked by broad baseline errors, including a stale/mismatched generated Prisma client and unrelated existing type errors; the focused Vitest files passed.
- Task 1 files and unrelated controller/queue changes were already present in the shared worktree and were intentionally left outside this Task 3 commit.
