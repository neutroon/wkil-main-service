# Task 5 payload fix report

## Finding resolved

Coexistence import event counts now remain stable across importer retries and racing duplicate deliveries. The event payload no longer uses attempt-local `imported` or `processed` summary values, which can be zero after the database writes already committed.

## Implementation

- History events derive `importedMessageCount` from unique WAMIDs with valid source timestamps in the normalized history job.
- Contact events derive `importedContactCount` from unique recognized add/edit/remove contact identities in the normalized state-sync job.
- Existing history importer `conversationIds` remain the source for affected conversations.
- Importer summary semantics are unchanged; only the bulk realtime event payload uses stable source counts.
- The durable outbox/lease strategy and at-least-once Socket.IO behavior are unchanged.
- No frontend files, raw message logging, or raw message content in the event ledger were added.

## TDD evidence

- RED: `npx vitest run src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts` — 2 expected regression failures, both showing a source item was forwarded as count `0`.
- GREEN: focused coexistence/realtime/queue run with placeholder environment — 5 suites, 43 tests passed.
- Added direct helper coverage for unique valid history WAMIDs and recognized contact state-sync entries.

## Verification

- `npx prisma validate` — passed.
- `npx prisma generate` — passed.
- `npx tsc --noEmit` — passed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Caveats

The history test continues to print the repository's existing dummy SMTP connection refusal while its assertions pass. The pre-existing untracked implementation plan was preserved and excluded from the commit.
