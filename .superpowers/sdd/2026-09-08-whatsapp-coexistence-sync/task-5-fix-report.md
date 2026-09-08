# Task 5 review-fix report

## Finding resolved

Coexistence history/contact processors now use one stable event key per BullMQ job (with the existing deterministic batch key as the direct-call fallback). Duplicate and concurrent deliveries cannot create multiple pending events for the same business profile, phone number, and job key.

## Implementation

- Added `WhatsAppCoexistenceImportEvent` as a minimal durable outbox record. It stores only the exact bulk invalidation payload, delivery state, attempt count, and short lease metadata; it does not store message content.
- The worker passes the real BullMQ `job.id` into both coexistence processors.
- A worker atomically claims a pending event with a five-second lease, emits the unchanged `{ businessProfileId, phoneNumberId, conversationIds, importedMessageCount, importedContactCount }` payload, and marks it delivered.
- A crashed worker leaves a pending row that a later retry can reclaim. If delivery succeeded but the marker write was lost, a retry may emit a duplicate invalidation; the event is intentionally safe to apply repeatedly.
- Historical messages continue using the existing origin-based suppression, so no individual `new_message` event is emitted.

## Verification

- Focused coexistence/realtime/queue run: 6 suites, 46 tests passed.
- Prisma schema validation and client generation passed.
- TypeScript check and `npm run build` passed.
- `git diff --check` passed.

## Caveat

Socket.IO remains an at-least-once transport boundary. The durable lease/outbox prevents permanent suppression after a process crash and permits safe duplicate invalidations, but it cannot claim exactly-once network delivery. The broader controller test suite still has a pre-existing fixture issue where its mocked environment omits `R2_PUBLIC_URL`; it was excluded from the focused run and is unrelated to this change. The history test also logs an SMTP connection warning with placeholder test settings while its assertions pass.
