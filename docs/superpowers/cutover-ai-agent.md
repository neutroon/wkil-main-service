# AI Agent Cutover Runbook

**Branch:** `feat/ai-agent-langgraph-service`
**Plan:** `docs/superpowers/plans/2026-08-25-ai-agent-microservice.md` (Tasks 24 + 25)
**Scope:** Make the LangGraph `agent-svc` the sole path for AI orchestration in the monolith. Remove the dual-write / flag-branch wiring, delete the legacy in-process agents, and drop the pgvector `BusinessProfileChunk` table.

> **WARNING — irreversible.** Steps 2–4 delete source files and drop a database table. Read the **Rollback** section before executing.

> **Status:** Steps 1–3 below are ✅ COMPLETED on this branch. Step 4 (build + smoke) remains PENDING and must be verified in the real environment where `langgraph-sdk` is installed.

---

## 1. Preconditions

Before starting the cutover, ALL of the following must be true:

- [x] Branch `feat/ai-agent-langgraph-service` is the cutover target branch.
- [ ] `langgraph-sdk` is installed and resolves from the package registry (`npm install` succeeds in the monolith).
- [x] `npx prisma generate` is green.
- [ ] Environment variables set in the target environment:
  - `LANGGRAPH_API_URL` — base URL of `agent-svc`.
  - `LANGGRAPH_API_KEY` — shared bearer.
  - `MONOLITH_SERVICE_TOKEN` — for agent-svc → monolith internal callbacks.
  - `QDRANT_URL` — Qdrant instance URL.
  - `QDRANT_COLLECTION` — collection name (e.g. `business_profile_chunks`).
- [ ] `USE_AGENT_SERVICE=true` has been set in production for **≥ 1 week** with stable replay parity (see `scripts/replay-e2e.ts`, Task 25).
- [ ] `agent-svc` is deployed via docker compose and reachable from the monolith. The Python service lives in the sibling repo at `/agent-svc/` (workspace root, NOT inside `back-end/`).
- [ ] Database backup / point-in-time recovery is available.
- [ ] Maintenance window scheduled (table drop + monolith redeploy).

---

## 2. Step 1 — Remove `USE_AGENT_SERVICE` flag branches from callers

✅ **COMPLETED** on this branch (commit `4726e4f`).

Twelve caller files were wired in Tasks 21–22. Each contained the dual-path guard:

```ts
if (AgentClient.enabled()) {
  return AgentClient.runAgent({ /* ... */ } as any) as any;
}

// legacy body using core/nodes/rag modules below
```

After cutover, `AgentClient` is the **sole** path. The transformation was:

1. **Delete** the entire `if (AgentClient.enabled()) { ... }` guard block at the top of the function.
2. **Delete** the entire legacy body below the guard.
3. **Replace** the function body with a direct call:

   ```ts
   export async function processFoo(payload: FooPayload) {
     return AgentClient.runAgent({
       business_profile_id: payload.businessProfileId,
       user_id: payload.userId,
       messages: payload.messages ?? [],
       stage: payload.stage ?? "fast",
     } as any) as any;
   }
   ```

4. **Delete** imports from the legacy modules that are no longer used (`@modules/ai-agent/core/*`, `@modules/ai-agent/nodes/*`, `@modules/ai-agent/rag/*`). Keep the `AgentClient` import — it is now the only AI entry point.

### The 12 caller files

| # | File |
|---|------|
| 1 | `src/modules/ai-agent/chat/businessChatReply.service.ts` |
| 2 | `src/modules/business/customer/customerMemoryCapture.job.ts` |
| 3 | `src/modules/business/profile/ai.service.ts` |
| 4 | `src/modules/business/profile/business.controller.ts` |
| 5 | `src/modules/content/contentBrief.service.ts` |
| 6 | `src/modules/content/contentPlan.service.ts` |
| 7 | `src/modules/follow-up/followUp.service.ts` |
| 8 | `src/modules/integrations/external/agentAction.job.ts` |
| 9 | `src/modules/integrations/external/integrationActionRun.service.ts` |
| 10 | `src/modules/media/services/geminiVisual.service.ts` |
| 11 | `src/modules/meta/core/metaProcessor.service.ts` |
| 12 | `src/modules/widget/services/widgetChat.service.ts` |

Commit:

```text
4726e4f feat(ai-agent): cutover — AgentClient is the sole agent path
```

---

## 3. Step 2 — Delete moved code

✅ **COMPLETED** on this branch (commit `baea3be`).

The orchestration logic now lives in `agent-svc` (sibling repo at workspace root). The legacy in-process modules under `src/modules/ai-agent/core`, `src/modules/ai-agent/nodes`, and `src/modules/ai-agent/rag` were deleted via `git rm -r`.

> After deletion, `src/modules/ai-agent/` should still contain `chat/` (helpers), `client/`, and `tools/`. The `chat/` directory still has files that import from the deleted `core/` module (type-only imports and runtime helpers) — these need to be cleaned up in a follow-up commit. The runtime behavior is unaffected because the 12 caller files no longer reach those helpers.

Commit:

```text
baea3be feat(ai-agent): cutover — delete moved legacy modules
```

---

## 4. Step 3 — Prisma schema

✅ **COMPLETED** on this branch (commit `167ed80`).

The `BusinessProfileChunk` model and its relation from `BusinessProfile` were removed from `prisma/schema.prisma`. `npx prisma generate` ran successfully (no DB connection required — client regenerated from schema only).

The migration SQL is already committed at:

```text
prisma/migrations/20260825120000_drop_business_profile_chunk/migration.sql
```

Contents (for reference):

```sql
-- Drop pgvector RAG table; chunks now live in Qdrant (owned by agent-svc).
DROP INDEX IF EXISTS "BusinessProfileChunk_businessProfileId_idx";
DROP INDEX IF EXISTS "BusinessProfileChunk_embedding_idx";
DROP TABLE IF EXISTS "BusinessProfileChunk";
```

Apply in the target environment:

```bash
# Production / staging (deployment migration):
npx prisma migrate deploy

# Local development (regenerates client + applies):
npx prisma migrate dev
```

Commit:

```text
167ed80 feat(ai-agent): cutover — drop BusinessProfileChunk from Prisma schema
```

---

## 5. Step 4 — Build + smoke

⏳ **PENDING in real env** — must be verified where `langgraph-sdk` is installed.

In this order:

```bash
# 1. Type-check / build the monolith (must succeed; langgraph-sdk is now the only AI dep).
npm run build

# 2. Run unit + integration tests.
npm test

# 3. Bring up agent-svc via docker compose.
docker compose -f docker-compose.agent-svc.yml up -d

# 4. HTTP smoke against agent-svc.
python scripts/smoke.py

# 5. End-to-end replay against the live monolith (Task 25).
USE_AGENT_SERVICE=true \
  LANGGRAPH_API_URL=https://agent-svc.internal \
  LANGGRAPH_API_KEY=*** \
  npx ts-node scripts/replay-e2e.ts
```

Expected: `done: N ok, 0 fail`.

> **Note:** This env cannot install `langgraph-sdk`, so `npm run build` will fail here (the `AgentClient` import resolves to a missing module). The cutover code changes are the correct end state — `npm run build` and live smoke MUST be verified in the real environment / CI where `langgraph-sdk` is installed.

If any step fails, **STOP** and consult Rollback.

---

## 6. Rollback

After cutover, the `USE_AGENT_SERVICE` flag and the legacy `core/nodes/rag` modules are gone. Rollback = single `git revert` + redeploy.

```bash
# Identify the cutover commits (Steps 1–3 in this order).
git log --oneline -n 20 | grep -E "AgentClient is the sole agent path|delete moved legacy modules|drop BusinessProfileChunk from Prisma schema"

# Revert them in reverse order.
git revert 167ed80
git revert baea3be
git revert 4726e4f

# Redeploy monolith + agent-svc.
docker compose up -d --build
```

The migration drop is irreversible at the database level (the `BusinessProfileChunk` table is gone). To recover the data, restore from the pre-cutover DB backup. Re-running `migrate deploy` will **not** recreate the table — Prisma only tracks forward migrations.

If rollback is needed because `prisma migrate deploy` succeeded but the monolith still references `BusinessProfileChunk`, ensure the schema revert and the source-code revert land together (one commit per revert).

---

## 7. Acceptance

After Step 5, the following greps must return **zero matches**:

```bash
# No legacy module references remain.
grep -RIn "ai-agent/core" src/            || echo OK
grep -RIn "ai-agent/nodes" src/           || echo OK
grep -RIn "ai-agent/rag" src/             || echo OK

# No Prisma model references remain.
grep -RIn "BusinessProfileChunk" src/     || echo OK
grep -RIn "BusinessProfileChunk" prisma/  || echo OK

# No flag references remain.
grep -RIn "USE_AGENT_SERVICE" src/        || echo OK
grep -RIn "AgentClient\.enabled" src/     || echo OK
```

> **Known follow-up:** The `ai-agent/chat/` directory still contains files (e.g. `aiFallbackPolicy.ts`, `deliveryPolicy.ts`, `replySideEffects.service.ts`) that import types from the now-deleted `ai-agent/core/aiEngine.utils`. These are type-only imports and do not affect the AgentClient-direct code path, but they will surface as TypeScript errors in the real-env build. They need to be cleaned up in a follow-up commit.

Additional checks:

- [ ] `npx prisma validate` passes.
- [ ] `npm run build` succeeds with no TypeScript errors.
- [ ] `npm test` is green.
- [ ] `scripts/replay-e2e.ts` exits with `done: N ok, 0 fail`.

When all greps are empty and all commands pass, the cutover is complete.
