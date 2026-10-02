# Generic store integration verification — 2026-10-02

The generic API and reference-store integration are local across WKIL backend/web
and store backend/admin. Senior source review has no unresolved Critical or
Important findings. Local completion includes the previously integrated Meta
changes in the store's transaction and worker lifecycle. No push, deployment,
production migration, live message delivery or historical data repair has been
performed. The verified feature is integrated into local main only; the
deployment order and separate historical repair procedure remain in the release
handoff.

Local commits: WKIL web `d67660d2`, store admin `181450e`, store backend
`8f3dcca` (includes the WKIL checkpoint `3d1b24d` and existing Meta main).
The WKIL backend commit contains this record, the approved generic API and the
live-template ordering regression. Feature branches remain available for audit.
Store main is checked out in its existing clean
`.variant-worktrees/meta-tracking/main-backend` worktree; the primary backend
feature checkout retains the same final commit. Unrelated worktrees and the
web's pre-existing auth-file bytes were preserved.

## Implemented behavior

- Shared field registry and readiness inspection for signed developer setup,
  managed previews and actual notification sending. Missing mapped fields expose
  the placeholder, field and canonical paths before a Meta request. Permanent
  missing-data errors stop automatic retries.
- `shippingFullAddress` requires `order.shippingAddress.addressLine1` and formats
  available address components. City alone cannot satisfy it. Existing country
  mappings remain preserved; select the address field explicitly when desired.
- Signed requirements and validation endpoints use synthetic setup data without
  ingestion, message sending, action-token creation or production access.
- Downloadable canonical JSON schema, guide, TypeScript examples and field
  catalog support the generic API and future store implementations.
- Reference-store orders enqueue within their transaction. Durable delivery uses
  stable event IDs, frozen attempted bytes, fresh signatures/configuration,
  bounded retries, guarded leases, deletion revocation and safe diagnostics.
- Store admin exposes readiness and missing paths, guarded manual retries,
  delivery status filtering and cursor pagination. Connection inputs are locked
  during a pending setup check, preventing results for stale displayed settings.

## Verification results

| Repository/check | Result |
| --- | --- |
| WKIL backend `npm.cmd test -- --maxWorkers=2` | 103 files, 979 tests passed |
| WKIL web `pnpm test --maxWorkers=2` | 83 files, 437 tests passed |
| WKIL web lint | Exit 0, zero errors, 58 existing warnings |
| WKIL backend/web TypeScript checks | Passed |
| WKIL backend standard build | Exit 0: Prisma client/assets generation, TypeScript, aliases and OpenAPI bundle |
| WKIL web `next build --webpack` | Exit 0: production compilation, TypeScript and page generation |
| Integration asset generation/check and contract checks | Passed |
| OpenAPI lint/routes | Passed; 243 documented routes match 243 expected |
| WKIL actual order-detail browser fixtures | 2 passed: English desktop and Arabic mobile; missing country/address paths and placeholders visible; no collected page errors |
| Store backend focused `test:wkil` | 41 passed |
| Store backend `test:wkil:recovery` | 11 passed |
| Store backend `test:wkil:contract` | 1 passed using actual store builder and actual WKIL schema/inspection, eight fields in both locales |
| Store backend full `npm.cmd test` | 511 passed, zero failed, 6 optional skips; 517 total, against disposable DB with stable local-only test harness |
| Store backend standard build | Exit 0 |
| Store combined Meta route fixtures | 24 passed; Meta-only fake checkout persistence explicitly disables WKIL, while combined real-DB tests retain both enqueues |
| Store fresh PostgreSQL history | All 51 migrations applied to empty disposable store and Meta test databases, including both outboxes |
| Store `test:wkil:db` | 4 passed: real capped/disjoint claims, expired-lease fencing, frozen bytes and source deletion |
| Store `test:meta:db` | 22 passed: real Meta claims/leases and both queues' atomic commit/rollback and concurrent idempotency |
| WKIL exact diagnostics migration | Applied against seeded pre-change table; nullable TEXT/JSONB, existing row preservation and Prisma read/write/clear passed |
| Store admin existing UI tests | 4 passed using the installed local tsx executable |
| Store admin TypeScript | Exit 0 |
| Store admin standard production build | Exit 0, 23 static pages generated |
| Store admin fresh-preview browser fixtures | 4 passed: English/Arabic diagnostics, safe retry, delayed settings lock and older blocked delivery navigation; no collected page errors |
| All four repository diff whitespace checks | Passed after removing the task's extra EOF blank line |

Additional worker tests cover uncertain remote acceptance replay, secret rotation,
deleted sources, disabled configuration, stale claims, two-request concurrency,
ten-attempt exhaustion and bounded HTTP timeout. Recovery tests cover accepted,
leased, retargeted and expired payload rejection, frozen bytes, safe template
errors, competing state changes and non-admin authorization.

Initial checks without the initialized disposable database observed these three
failures:

- `apiScopes.test.ts`: invalid MCP tool call returns 500, expected 403.
- `entityValidation.test.ts`: category rich-description result is `true`, expected
  `undefined`.
- `routes/mcp.test.ts`: CORS preflight returns 500, expected 204.

All three pass in the final run against the initialized disposable database;
their existing assertions were retained. No unrelated production behavior was
changed to make them pass. The combined Meta checkout mocks were updated to
disable WKIL explicitly because those fake transactions do not implement its
queue; the real-DB tests separately prove both queues participate atomically.
The recovery/contract/real-DB suites have explicit package scripts.

## Independent review and regression proof

One fresh reviewer examined all four repositories: zero Critical, three Important
and one Minor finding. Author assessment retained those grades. No items were
declined for judgment. All Important findings are now fixed:

1. **Historical template selection:** setup now selects active approved template
   configurations with deterministic ordering. The repository regression failed
   before the fix and passed after. Repository/validation/managed-preview suites
   passed, followed by all 978 backend tests.
2. **Unreachable older failures:** status filtering, bounded cursor pagination and
   older-page controls expose blocked deliveries beyond newer events. The original
   repository failed the cursor regression; the proposed and subsequently applied
   implementation passed. Actual source-owned recovery checks and the browser
   navigation test passed.
3. **Stale setup result:** connection inputs stay locked during pending checks.
   A fresh preview with the locks removed failed the delayed-check regression.
   The exact source snapshot was restored and a fresh preview passed all four
   browser tests. Restored SHA-256 was independently checked. An earlier warm-cache
   attempt was inconclusive and is not counted as regression proof.

Minor deferred: WKIL order-detail diagnostics display raw field IDs for fields
other than country instead of all translated field labels. Canonical paths and
placeholders remain available.

A fresh GPT-6.1 Sol senior review of the combined code found two further
Important issues, both fixed and independently reread:

1. Live template resolution lacked setup's deterministic newest-update/ID
   ordering. Both queries now agree. A two-eligible-template behavior regression
   failed before the fix (9 passed, 1 failed) and passed afterward (10 passed),
   followed by all 979 backend tests.
2. A rejected worker lane could release its active poll while the sibling
   transport remained in flight. The reviewer reproduced early shutdown using
   the actual worker source. Each batch now drains with `Promise.allSettled`
   before propagating failure. A deferred-sibling regression failed before the
   fix (2 passed, 1 failed) and passed afterward (3 passed), asserting active-poll
   reuse, pending shutdown and only one claim until the sibling settles.

## Environment and remaining limits

- An earlier scoped store write was blocked because automatic approval review's
  account usage limit prevented review. A later explicitly requested continuation
  retried successfully; the hash-guarded patch was applied. The sandbox was not
  bypassed.
- Initial builds hit existing `dist` write permissions and blocked Google Fonts;
  scoped permission allowed the normal backend build and the Webpack web build.
  Default WKIL Turbopack compilation stalled for over ten minutes without new
  output and was interrupted. Project configuration was unchanged; a successful
  default Turbopack build is not claimed.
- The host has Node 24.12; WKIL web declares at least 24.15. The successful local
  checks do not remove that deployment runtime requirement.
- Initial Chromium launches failed with `spawn EPERM`; scoped launch permission
  enabled the final browser checks. WKIL's initial cold dev compilation timed out;
  its final diagnostic tests passed against the completed production build.
- The PowerShell npm wrapper is broken. `npm.cmd` or installed local test tools
  supplied the equivalent checks. Store admin lint retains its existing Next 16 /
  `next lint` incompatibility; a passing lint result is not claimed.
- Next DevTools discovered local servers. `get_errors` had no connected browser
  after the fixture pages closed. Browser tests collected page errors directly;
  a clean DevTools browser-session result is not claimed.
- Two earlier full runs hit randomly assigned local HTTP ports rejected by
  native Fetch. The final temporary preload allocates high local test-server
  ports and blocks external Fetch, preserving native Fetch and the original
  assertions. The preload remained unchanged for the entire final 112-second
  run and was removed after verification. This follows the
  [Fetch port-blocking rules](https://fetch.spec.whatwg.org/#port-blocking) and
  [Node 24.12 port allocation behavior](https://nodejs.org/download/release/v24.12.0/docs/api/net.html#serverlistenport-host-backlog-callback).
  One intervening run was invalid because an old preload path was removed while
  child processes still imported it; that run is not counted as verification.
  Tests ran in the default sandbox, which also rejected attempted external SDK
  connections. Only the TypeScript build received scoped access to existing
  `dist` outputs; no live cloud operation was authorized or performed.
- The explicitly authorized disposable cluster used loopback port 55441, separate
  from the other chat's 55439 cluster. Tests use synthetic data, guard their
  database targets, block external transport and clean owned fixtures. All 51
  store migrations applied. WKIL's full migration history failed at its existing
  first migration because portable PostgreSQL lacks `vector.control`. Old
  migrations and migration history were not edited or marked. Its new migration
  was tested independently against a pre-change notification table and Prisma.
  Production migration application and message delivery remain unverified.
- No matching Prisma documentation/API-reference MCP was available. Installed
  Prisma 6 generated APIs and repository configuration supplied the fallback.
  Next bundled documentation and Meta documentation tools were used successfully.
  LangGraph/assistant-ui behavior was outside this change.

User-directed model policy: cost-saving Luna agents handled the finish-session
implementation, merge resolution, regression fixes and verification. GPT-6.1 Sol
performed senior review; the root retained integration decisions and checked the
evidence. No Astra agent was used in this completion session.

All temporary preview servers owned by this work are stopped. The disposable
PostgreSQL cluster is stopped after verification; its fixtures, execution ledger
and logs remain in the ignored `.superpowers/sdd/2026-10-02-generic-store-integration/finish`
workspace. The other chat's cluster/worktrees were not altered. See
[release handoff](generic-store-release.md) for deployment order, rollback limits
and the separate historical data-repair procedure.
