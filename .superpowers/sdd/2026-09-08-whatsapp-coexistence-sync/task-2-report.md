# Task 2 Report: Historical Message Persistence and Timestamp-Safe Pagination

## Scope and outcome

Implemented the real WhatsApp Coexistence history importer in the backend worktree. History jobs now validate at the queue boundary, resolve the linked WhatsApp account, persist historical messages through a dedicated write path, preserve source timestamps, deduplicate WAMIDs, and avoid live-message/AI side effects. Numeric message cursors now resolve their timestamp anchor and paginate by `createdAt DESC, id DESC`.

## Changed files

- Created `src/modules/meta/whatsapp/whatsappCoexistenceHistory.service.ts`.
- Created `src/modules/meta/whatsapp/whatsappCoexistenceHistory.service.test.ts`.
- Modified `src/modules/meta/whatsapp/whatsappCoexistence.service.ts` to dispatch validated history jobs to `importCoexistenceHistoryChunk`.
- Modified `src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts` to replace the Task 1 stub assertion with the dedicated importer delegation assertion.
- Modified `src/modules/meta/core/conversation.service.ts` for timestamp-safe numeric cursor pagination.
- Modified `src/modules/meta/core/conversation.service.test.ts` with the old-history-after-new-live regression test.
- Modified `src/config/prisma.ts` to suppress per-message realtime sync for `origin = "whatsapp_coexistence_history"`.
- Modified `prisma/schema.prisma` with `@@index([conversationId, createdAt, id])`.
- Created `prisma/migrations/20260908130000_coexistence_history_ordering/migration.sql`.
- Created this report.

`src/modules/meta/core/meta.queue.ts` was inspected and left unchanged because its existing `whatsapp_coexistence_history` worker branch already dispatches through `processCoexistenceHistoryJob`; changing it was unnecessary and would risk Task 1 wiring.

## TDD red/green evidence

Each focused behavior was driven by a failing test before the production change:

1. Importer test initially failed because `whatsappCoexistenceHistory.service` did not exist. The first implementation made the timestamp/role/status/media/no-AI test green.
2. Placeholder test failed because missing-media metadata lacked the marker. Adding `placeholder: true` and `placeholderReason: "media_id_unavailable"` made it green.
3. P2002 duplicate test failed with the uncaught `{ code: "P2002" }`. Catching unique conflicts and counting them made it green.
4. Existing-conversation preservation test failed because an unlinked existing conversation was not linked. The minimal `customerId` update, with the original `updatedAt` explicitly retained and no `readAt`/`status` writes, made it green.
5. The 101-message batch test failed after creating a second conversation across the 100-message boundary. Sharing the per-import thread conversation cache made it green and retained the full-thread activity timestamp.
6. Pagination initially hit the repository's required-environment bootstrap; after rerunning with disposable test values, the actual red failure showed no cursor-anchor lookup. Resolving the numeric cursor and using the timestamp/id keyset predicate made it green.
7. Queue delegation failed while the Task 1 stub still threw. Calling `importCoexistenceHistoryChunk` made the queue-boundary test green.
8. In-chunk duplicate WAMID test failed because the mock accepted both inserts. Adding an in-memory external-ID set made it green while retaining database P2002 handling for races.
9. Invalid timestamp test was run against a deliberately bypassed timestamp guard and failed by persisting the message. Restoring source timestamp validation made it green; invalid/missing timestamps are skipped.

## Verification

- Focused Task 2 plus existing queue tests: **4 test files, 17 tests passed**.
- `npx tsc --noEmit`: passed.
- `npx prisma generate`: passed.
- `npx prisma validate`: passed with disposable `DATABASE_URL` and `DIRECT_URL` values. The first validation attempt correctly reported the missing `DIRECT_URL` environment variable before the rerun.
- `npm run build`: passed, including TypeScript, alias compilation, and OpenAPI bundling.
- `git diff --check`: passed.

## Decisions

- Historical messages use `role = "user"` when the sender matches the thread participant and `role = "agent"` for the business side; explicit direction fields are honored when present.
- Numeric Meta timestamps are interpreted as Unix seconds, ISO timestamps are parsed as UTC-capable `Date` values, and invalid timestamps are skipped.
- Read history maps to `READ`; all other historical messages map to `SENT`.
- Media IDs and selected metadata are retained. Media without a usable ID receives a placeholder marker rather than being discarded or downloaded.
- Imports are processed in bounded batches of 100 messages. Existing conversations are not reopened or otherwise activity-touched; only a missing customer link is added while retaining the existing `updatedAt`.
- The Prisma message extension checks write input/result origin and suppresses individual realtime imports for the history origin. No history message calls `processMetaMessage`.
- Missing/deleted numeric cursor anchors retain the legacy `id < cursor` fallback for caller compatibility.

## Concerns and blockers

- No live PostgreSQL integration or migration deployment was run because no live database credentials were in scope and the user requested focused verification only. The migration and Prisma schema validate, but applying the migration against a real database remains an operational follow-up.
- Focused importer tests use Prisma/customer mocks, so database-specific transaction behavior should be covered by the deployment/staging smoke test.
- The pre-existing untracked file `docs/superpowers/plans/2026-09-08-whatsapp-coexistence-sync.md` was preserved and intentionally excluded from the Task 2 commit.
