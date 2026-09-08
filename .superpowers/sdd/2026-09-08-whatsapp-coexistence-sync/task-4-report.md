# Task 4 Report: OAuth Lifecycle and Registration Hardening

## Status

Implemented in `D:\zTechy Org\pagespilot.com\wkil-worktrees\backend`.

Required commit message: `fix(whatsapp): harden coexistence lifecycle`.

## Changed files

- `D:\zTechy Org\pagespilot.com\wkil-worktrees\backend\src\modules\meta\whatsapp\whatsappOauth.service.ts`
  - Uses the saved account returned by the upsert as the lifecycle boundary.
  - Starts Coexistence contact/history sync only for saved `COEXISTENCE` accounts with a non-null `businessProfileId`.
  - Logs and defers unlinked Coexistence accounts without making Meta sync requests; a later reconnect can start sync after profile linking.
  - Keeps `/register` out of the Coexistence branch.
  - Runs standard automatic registration only when the configured PIN is present and passes that PIN through without logging it.
  - Preserves the existing Meta mode detection, one-time markers, contact-before-history ordering, already-requested handling, and best-effort sync error behavior.
- `D:\zTechy Org\pagespilot.com\wkil-worktrees\backend\src\config\env.ts`
  - Adds optional `WHATSAPP_REGISTRATION_PIN` validation requiring exactly six digits.
- `D:\zTechy Org\pagespilot.com\wkil-worktrees\backend\src\modules\meta\whatsapp\whatsappOauth.service.test.ts`
  - Adds coverage for profile deferral, later reconnect, already-requested responses, no-PIN registration skip, configured-PIN registration, `/register` exclusion, ordering, marker persistence, and secret-safe logs.
- `D:\zTechy Org\pagespilot.com\wkil-worktrees\backend\.superpowers\sdd\2026-09-08-whatsapp-coexistence-sync\task-4-report.md`
  - This report.

The pre-existing untracked plan at `docs\superpowers\plans\2026-09-08-whatsapp-coexistence-sync.md` was preserved and not modified.

## TDD evidence

Tests were written before production changes.

RED run:

```text
npx vitest run src/modules/meta/whatsapp/whatsappOauth.service.test.ts
7 tests | 4 failed
```

The observed failures were the expected missing behaviors: an unlinked account made three fetches instead of one, the reconnect scenario made six instead of four, missing PIN still attempted `/register`, and configured PIN still sent `123456` instead of `654321`.

GREEN run:

```text
npx vitest run src/modules/meta/whatsapp/whatsappOauth.service.test.ts
1 test file passed
7 tests passed
```

No production code was written before the failing focused run.

## Tests and verification

- Focused OAuth tests: passed, 7/7.
- Focused OAuth/controller tests: passed, 2 files and 15/15 tests.
- TypeScript: `npx tsc --noEmit` passed with no output/errors.
- Production build: `npm run build` passed; Prisma client generation and OpenAPI bundling completed.
- Environment validation: valid `WHATSAPP_REGISTRATION_PIN=654321` loaded successfully; invalid `WHATSAPP_REGISTRATION_PIN=12345` exited with the intended six-digit validation error.
- Diff hygiene: `git diff --check` passed.

Full backend test run:

```text
49 test files passed
338 tests passed
26 suites failed during environment module loading
```

The 26 failures are the repository’s existing missing-required-environment baseline: those suites import `src/config/env.ts` without the required database, auth, Meta, Redis, storage, and SMTP variables, causing its existing `process.exit(1)`. `WHATSAPP_REGISTRATION_PIN` is optional and was not among the reported missing variables.

## Decisions

1. The existing Meta phone-number mode detection remains unchanged. The saved upsert result controls the post-save branch, so Coexistence never falls through to standard registration.
2. A null/undefined saved `businessProfileId` means the account remains pending for synchronization. No automatic migration, bulk repair, or manual sync endpoint was added.
3. Existing synchronization markers and the current already-requested response classification remain intact. Successful and already-requested contact/history requests continue to persist request timestamps.
4. Sync persistence/API failures remain best-effort and are logged without rejecting the live account save.
5. The registration PIN is configuration-only, validated at startup, omitted from logs, and never replaced with a default.

## Concerns

- Standard Cloud API automatic registration is intentionally skipped until production config supplies a valid six-digit `WHATSAPP_REGISTRATION_PIN`; explicit standard registration remains available when it is configured.
- The full suite still needs its existing required environment fixture or CI environment to load the 26 affected suites. This was not changed because it is outside Task 4 scope.
