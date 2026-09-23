# Final Fix Wave Report

Date: 2026-09-23

## Scope and starting state

Implemented the three independently confirmed review findings against the requested clean `main` heads:

- Mobile `m`: `138751921a61904ae6e6572d2e7b0210937b6033`
- Web app `app`: `7c8c3b8d6a33886b3f49e293f80eb2854f2bdf82`
- Backend `back-end`: `6652348ec1fbeb2c55497b7cdcbc39b20cac53ff`

All three repositories were clean before edits. No OpenAPI source changed, so generated app OpenAPI types did not need regeneration. SDK dependency stayed pinned to exactly `@langchain/langgraph-sdk` 1.11.0. No push, merge, deployment, or migration was performed.

## TDD evidence

### A. Mobile checkpoint indexing availability and latency

Red: `vitest run lib/mobile-langgraph-runtime.test.ts --reporter=verbose` reproduced three failures with 19 passing: load rejected when `getState` succeeded but history failed; consuming the run stream waited on delayed index refresh; and scanning fetched another history page after the per-thread node bound had been exceeded.

Green: the focused runtime and hook suites pass **30 tests**; the complete mobile suite passes **102 tests in 15 files**. `tsc --noEmit -p tsconfig.tests.json` exits 0.

Implementation: official `getState` is the visible load path. Checkpoint metadata is built separately in caught background work, fenced by thread context/generation and invalidated across runs. Stream completion does not await the metadata refresh. The index stores only ordered message IDs and checkpoint IDs, is limited to 20,000 nodes/states per thread and 30 LRU threads, and stops scanning once the bound is reached. Missing, evicted, oversized, failed, or stale metadata fails closed.

Pinned assistant-ui source truncates messages before awaiting `getCheckpointId`. Therefore, if an edit arrives before its checkpoint metadata is ready, the lookup rejects and the official UI may remain truncated; the regression test documents this accepted upstream limitation. No custom reconciliation or divergent run was added.

### B. Web checkpoint parity for older history

Red: the focused Copilot runtime suite initially had two expected failures (19 passing): official load did not prepare paginated checkpoint metadata, and there was no fail-closed no-match lookup path.

Green: Copilot runtime plus lifecycle tests pass **31 tests**; the complete app suite passes **415 tests in 75 files**. `tsc --noEmit` exits 0.

Implementation: after official `getState` returns visible data, a caught background indexer pages through the official SDK `getHistory(threadId, { limit: 100, before: { configurable: { checkpoint_id } } })` cursor contract. It stores only ID/checkpoint metadata and observes 30-thread LRU and per-thread bounds. Edits/regenerations synchronously consult this cache; an unprepared, failed, oversized, or no-match lookup rejects rather than starting a run. Verified empty/root cases remain distinct and can return `null`. There is no mutable shared lookup guard; concurrent miss and hit lookups are tested to ensure one cannot consume or clear the other's state.

### C. Backend create metadata contract

Red: focused gateway tests had four expected failures with 63 passing: unknown `workspace_id`, arbitrary metadata fields, and `null` metadata were silently accepted, while argument-free SDK create was rejected.

Green: focused gateway suite passes **67 tests**; full backend suite passes **922 tests in 94 files**; backend `tsc --noEmit` exits 0.

Implementation: create accepts omitted body/metadata and an optional title, rejects non-object metadata and unknown metadata keys, then stamps canonical server-owned workspace and assistant metadata. Regression tests cover valid argument-free SDK creation and strict rejection cases. The OpenAPI source already matched the intended contract and was not changed.

## Documentation and source consulted

- Required workspace and repository `AGENTS.md` guidance and the approved contract-centralization spec/plan, reports/ledger, and `final-review-package.diff`.
- The `ecosystem-primer`, assistant-ui, runtime, React Native, update, LangGraph persistence, LangChain dependencies, receiving-code-review, TDD, systematic debugging, and verification skills.
- Official LangGraph documentation pages for threads and interrupts, plus official LangChain SDK/API reference for thread history.
- Installed, version-matched SDK declaration: `app/node_modules/@langchain/langgraph-sdk/dist/client/threads/index.d.ts`; it confirms `getHistory(threadId, options)` supports `limit` and a `before` `Config` cursor.
- Installed pinned assistant-ui LangGraph runtime source: `app/node_modules/.pnpm/@assistant-ui+react-langgra.../node_modules/@assistant-ui/react-langgraph/src/useLangGraphRuntime.ts`; inspection confirms message truncation precedes the asynchronous `getCheckpointId` callback.

The Expo runtime MCP was unavailable in this task context; verification used repository tests and typechecks. No live app/browser runtime was required for these cache and contract regressions.

## Verification and environment notes

- Mobile full suite: **15 files, 102 tests passed**.
- Mobile focused runtime/hooks: **2 files, 30 tests passed**.
- Mobile test-project TypeScript check: passed.
- App full suite: **75 files, 415 tests passed**.
- App Copilot runtime/lifecycle focused suite: **31 tests passed**.
- App production TypeScript check: passed.
- App `pnpm lint`: exited 0 with 0 errors and 58 warnings; warnings are existing generated widget bundle and image-element warnings outside this change.
- Backend full suite: **94 files, 922 tests passed**; focused gateway suite: **67 tests passed**; TypeScript check: passed.
- `git diff --check` passed in each repository. Git emitted only its normal LF-to-CRLF working-copy notices.
- Backend full-suite output included expected local SMTP/Redis connection-refused noise from environment-dependent tests; suite exit remained 0.

## Commits

- Mobile: `d6b391f3d0029c93a280ef07e828179a51049d42` — `fix(copilot): decouple checkpoint indexing`.
- App: `3b08f076dbbc0abfe5781cbef890cef797b56758` — `fix(copilot): paginate checkpoint history`.
- Backend: `c9d3267e6772da420788a60eb2bd8a0399b74a58` — `fix(assistant): enforce create metadata contract`.

The report itself is committed separately because `.superpowers/sdd/` is ignored by the repository; it was force-added only at the specifically requested report path.

## Residual limitation

The only user-visible limitation is the pinned upstream assistant-ui ordering described above: an edit attempted before checkpoint metadata is prepared can leave the official UI truncated after the safe rejection. This wave intentionally does not add non-SDK reconciliation or permit a run with an unknown parent checkpoint.
