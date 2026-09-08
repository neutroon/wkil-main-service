# Task 3 implementation report

## Changed files

- `src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.ts`
  - Added `syncCoexistenceContacts(input)` and the normalized contact input/summary types.
  - Accepts normalized `stateSync` jobs as well as the equivalent contact/event aliases.
  - Handles add, edit, and remove events using the existing customer identity upsert path.
  - Supports nested Task 1 contact fields (`wa_id`, `phone_number`, and `full_name`).
  - Deduplicates repeated events within a bounded job using event identity or deterministic contact identity.
  - Writes removals as `metadata.whatsappCoexistence.state = "REMOVED"` with a tombstone marker and timestamp.

- `src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts`
  - Added focused tests for contact add/edit/remove, normalized phone identity, external identity preservation, duplicate events, live interaction behavior, and historical activity timestamps.

- `src/modules/business/customer/customer.service.ts`
  - Extended `upsertCustomerFromConversation` with optional metadata, `updateInteraction`, and historical `activityAt` support.
  - Preserved current-time `lastInteractionAt` updates for existing live callers by default.
  - Allows Coexistence/history callers to omit current-time interaction updates and prevents an older historical timestamp from replacing newer activity.

## Tests run

The first focused run was intentionally RED because the new contact service module was absent. After implementation, the focused Vitest command was rerun with temporary required test environment variables (no environment files were changed):

```text
npm test -- src/modules/meta/whatsapp/whatsappCoexistenceContacts.service.test.ts src/modules/business/customer/customer.service.test.ts src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts

Test Files  3 passed (3)
Tests       36 passed (36)
```

The full backend suite was not run because the worktree baseline has no required environment variables, as instructed.

## Design decisions

- Customer synchronization reuses `upsertCustomerFromConversation` so phone normalization, business scoping, external identity attachment, and existing customer merge conventions remain centralized.
- Contact synchronization passes `updateInteraction: false`; add/edit operations therefore do not explicitly write `lastInteractionAt`.
- `activityAt` is independent of the opt-out: a valid historical timestamp can advance customer activity, but never regress a newer timestamp.
- Removes never delete customers, external identities, conversations, or messages. They record a tombstone in customer metadata.
- No WhatsApp SDK or third-party WhatsApp library was added, and no queue/controller plumbing was changed.

## Unresolved concerns

- The Task 1 normalized job contains `phoneNumberId`, `wabaId`, and `stateSync` but no `businessProfileId`; the queue worker/caller must enrich the job with the profile ID before invoking this service.
- `Customer.lastInteractionAt` is non-null with a database `now()` default. A newly created contact with no historical timestamp therefore receives the database default even though the service omits an explicit current-time write; existing contact rows are not advanced.
- The tombstone shape is local to this importer (`metadata.whatsappCoexistence.state/removed/removedAt`) and should be treated as the downstream contract for any UI or reporting consumer.
- `npx tsc --noEmit` remains blocked by broad baseline errors, including a stale/mismatched generated Prisma client and unrelated existing type errors; the focused Vitest files passed.
- Task 1 files and unrelated controller/queue changes were already present in the shared worktree and were intentionally left outside this Task 3 commit.
