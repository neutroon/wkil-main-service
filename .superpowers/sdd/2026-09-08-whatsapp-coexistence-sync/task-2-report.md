# Task 2 Report: Historical Message Persistence and Timestamp-Safe Pagination

## Scope and outcome

Implemented and review-hardened the real WhatsApp Coexistence history importer in the backend worktree. History jobs now validate at the queue boundary, resolve the linked active Coexistence account, persist historical messages through a dedicated write path, preserve source timestamps, deduplicate WAMIDs transaction-safely, and avoid live-message/AI side effects. Numeric message cursors now resolve their timestamp anchor and paginate by `createdAt DESC, id DESC`.

## Changed files

- Created `src/modules/meta/whatsapp/whatsappCoexistenceHistory.service.ts`.
- Created `src/modules/meta/whatsapp/whatsappCoexistenceHistory.service.test.ts`.
- Modified `src/modules/meta/whatsapp/whatsappCoexistence.service.ts` to dispatch validated history jobs to `importCoexistenceHistoryChunk`.
- Modified `src/modules/meta/whatsapp/whatsappCoexistence.service.test.ts` to replace the Task 1 stub assertion with the dedicated importer delegation assertion.
- Modified `src/modules/meta/core/conversation.service.ts` for timestamp-safe numeric cursor pagination.
- Modified `src/modules/meta/core/conversation.service.test.ts` with the old-history-after-new-live regression test.
- Modified `src/config/prisma.ts` to suppress per-message realtime sync for `origin = "whatsapp_coexistence_history"`.
- Modified `prisma/schema.prisma` with `@@index([conversationId, createdAt, id])`.
- Modified `prisma/migrations/20260908130000_coexistence_history_ordering/migration.sql` to remove the redundant two-column index before creating the cursor-supporting three-column index.
- Created this report.

`src/modules/meta/core/meta.queue.ts` was inspected and left unchanged because its existing `whatsapp_coexistence_history` worker branch already dispatches through `processCoexistenceHistoryJob`; changing it was unnecessary and would risk Task 1 wiring.

## TDD red/green evidence

Each focused behavior was driven by a failing test before the production change:

1. Importer test initially failed because `whatsappCoexistenceHistory.service` did not exist. The first implementation made the timestamp/role/status/media/no-AI test green.
2. Placeholder test failed because missing-media metadata lacked the marker. Adding `placeholder: true` and `placeholderReason: "media_id_unavailable"` made it green.
3. P2002 duplicate test failed with the uncaught `{ code: "P2002" }`. The initial implementation counted that conflict, but the review fix replaced the unsafe in-transaction create/catch path with existing-WAMID prefiltering plus `createMany({ skipDuplicates: true })`.
4. Existing-conversation preservation test failed because an unlinked existing conversation was not linked. The minimal conditional `customerId` update, with no `readAt`/`status` writes, made it green.
5. The 101-message batch test failed after creating a second conversation across the 100-message boundary. Sharing the per-import thread conversation cache made it green and retained the full-thread activity timestamp.
6. Pagination initially hit the repository's required-environment bootstrap; after rerunning with disposable test values, the actual red failure showed no cursor-anchor lookup. Resolving the numeric cursor and using the timestamp/id keyset predicate made it green.
7. Queue delegation failed while the Task 1 stub still threw. Calling `importCoexistenceHistoryChunk` made the queue-boundary test green.
8. In-chunk duplicate WAMID test failed because the mock accepted both inserts. Adding an in-memory external-ID set made it green while retaining database P2002 handling for races.
9. Invalid timestamp test was run against a deliberately bypassed timestamp guard and failed by persisting the message. Restoring source timestamp validation made it green; invalid/missing timestamps are skipped.

### Review fix round

10. The concurrent duplicate regression initially failed because the importer still issued per-message creates and could poison the interactive transaction after a P2002. Batch prefiltering and `createMany({ skipDuplicates: true })` made the real transaction-safe path green.
11. The live-update race regression initially failed because the conversation link update had no stale-write predicate. `updateMany` now requires `customerId IS NULL` and `updatedAt <= historical activityAt`, making the update atomic and the regression green.
12. The concurrent conversation-creation regression initially failed because no transaction-scoped lock was taken before lookup. A PostgreSQL `pg_advisory_xact_lock` keyed by business profile, phone number, WABA, and thread was added before `findFirst`; selection now orders by `updatedAt DESC`.
13. Account-routing regression initially failed because lookup omitted WABA and connection mode. The lookup now requires matching `phoneNumberId`, matching `wabaId`, active status, and `COEXISTENCE` mode.
14. The timezone regression initially failed under the local Cairo timezone because a timezone-less ISO value was parsed as local time. The importer now appends `Z` for timezone-less ISO timestamps.
15. The redundant two-column message index was removed from the schema and migration; the three-column `(conversationId, createdAt, id)` index is retained for the final keyset query.

## Verification

- Focused Task 2 plus existing queue tests: **4 test files, 17 tests passed**.
- Review-fix focused importer test: **1 test file, 12 tests passed**.
- `npx tsc --noEmit`: passed.
- `npx prisma generate`: passed.
- `npx prisma validate`: passed with disposable `DATABASE_URL` and `DIRECT_URL` values. The first validation attempt correctly reported the missing `DIRECT_URL` environment variable before the rerun.
- `npm run build`: passed, including TypeScript, alias compilation, and OpenAPI bundling.
- `git diff --check`: passed.

## Decisions

- Historical messages use `role = "user"` when the sender matches the thread participant and `role = "agent"` for the business side; explicit direction fields are honored when present.
- Numeric Meta timestamps are interpreted as Unix seconds; timezone-less ISO timestamps are explicitly interpreted as UTC; offset-bearing ISO timestamps retain their offset; invalid timestamps are skipped.
- Read history maps to `READ`; all other historical messages map to `SENT`.
- Media IDs and selected metadata are retained. Media without a usable ID receives a placeholder marker rather than being discarded or downloaded.
- Imports are processed in bounded batches of 100 messages. A transaction-scoped advisory lock serializes conversation lookup/creation per business profile, phone number, WABA, and thread. Existing conversations are selected by newest `updatedAt`; a missing customer link is added only when the atomic timestamp predicate proves the historical write is not stale.
- Historical message inserts prefilter known WAMIDs and use `createMany({ skipDuplicates: true })`, so a concurrent unique race cannot be caught inside and poison the PostgreSQL interactive transaction.
- The Prisma message extension checks write input/result origin and suppresses individual realtime imports for the history origin. No history message calls `processMetaMessage`.
- Missing/deleted numeric cursor anchors retain the legacy `id < cursor` fallback for caller compatibility.

## Concerns and blockers

- No live PostgreSQL integration or migration deployment was run because no live database credentials were in scope and the user requested focused verification only. The migration and Prisma schema validate, but applying the migration against a real database remains an operational follow-up.
- `npm run build` passed before this review hardening; it was not rerun afterward because the user explicitly requested stopping long-running validation. The focused importer test and `git diff --check` passed after the hardening.
- Focused importer tests use Prisma/customer mocks, so database-specific advisory-lock, `createMany` conflict, and timestamp-race behavior should still be covered by a deployment/staging PostgreSQL smoke test.
- The pre-existing untracked file `docs/superpowers/plans/2026-09-08-whatsapp-coexistence-sync.md` was preserved and intentionally excluded from the Task 2 commit.
