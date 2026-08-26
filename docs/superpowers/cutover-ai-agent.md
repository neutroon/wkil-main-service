# AI Agent Cutover Runbook

**Branch:** `feat/ai-agent-langgraph-service`
**Plan:** `docs/superpowers/plans/2026-08-25-ai-agent-microservice.md` (Tasks 24 + 25)
**Scope:** Make the LangGraph `agent-svc` the sole path for AI orchestration in the monolith. Remove the dual-write / flag-branch wiring, delete the legacy in-process agents, and drop the pgvector `BusinessProfileChunk` table.

> **WARNING — irreversible.** Steps 2–4 delete source files and drop a database table. Read the **Rollback** section before executing.

---

## 1. Preconditions

Before starting the cutover, ALL of the following must be true:

- [ ] Branch `feat/ai-agent-langgraph-service` is merged into `main` (or the cutover target branch).
- [ ] `langgraph-sdk` is installed and resolves from the package registry (`npm install` succeeds in the monolith).
- [ ] `npx prisma generate` is green.
- [ ] Environment variables set in the target environment:
  - `LANGGRAPH_API_URL` — base URL of `agent-svc`.
  - `LANGGRAPH_API_KEY` — shared bearer.
  - `MONOLITH_SERVICE_TOKEN` — for agent-svc → monolith internal callbacks.
  - `QDRANT_URL` — Qdrant instance URL.
  - `QDRANT_COLLECTION` — collection name (e.g. `business_profile_chunks`).
- [ ] `USE_AGENT_SERVICE=true` has been set in production for **≥ 1 week** with stable replay parity (see `scripts/replay-e2e.ts`, Task 25).
- [ ] `agent-svc` is deployed via docker compose and reachable from the monolith.
- [ ] Database backup / point-in-time recovery is available.
- [ ] Maintenance window scheduled (table drop + monolith redeploy).

---

## 2. Step 1 — Remove `USE_AGENT_SERVICE` flag branches from callers

Twelve caller files were wired in Tasks 21–22. Each contains the dual-path guard:

```ts
if (AgentClient.enabled()) {
  return AgentClient.runAgent({ /* ... */ } as any) as any;
}

// legacy body using core/nodes/rag modules below
```

After cutover, `AgentClient` is the **sole** path. The transformation is:

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

### Exact pattern (manual or scripted)

```bash
# For each caller file, remove the flag-guard block:
# Pattern (regex, applied per file):
#   ^\s*if\s*\(\s*AgentClient\.enabled\(\)\s*\)\s*\{\s*\n[\s\S]*?\n\s*\}\s*\n
# Replace with empty string.
#
# Then remove the legacy body (everything between the deleted guard and the next
# top-level statement or closing brace). The result should be a thin wrapper.
#
# Finally remove unused imports from:
#   @modules/ai-agent/core/...
#   @modules/ai-agent/nodes/...
#   @modules/ai-agent/rag/...
```

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

Commit message:

```text
refactor(ai-agent): remove USE_AGENT_SERVICE flag — AgentClient is the sole path
```

---

## 3. Step 2 — Delete moved code

The orchestration logic now lives in `agent-svc`. Delete the legacy in-process modules:

```bash
git rm -r src/modules/ai-agent/core
git rm -r src/modules/ai-agent/nodes
git rm -r src/modules/ai-agent/rag
# Note: `core/agentActionTools.ts` is already removed as part of `core/` above.
```

> The `rag.service.ts` dual-write guard is gone in Step 1; deleting the directory removes the underlying pgvector writers.

Consolidate into **one** commit together with Step 1's flag-removal diff:

```text
refactor(ai-agent): remove flag branches and delete legacy core/nodes/rag modules
```

---

## 4. Step 3 — Prisma schema

Remove the `BusinessProfileChunk` model from `prisma/schema.prisma`. Locate the block:

```prisma
model BusinessProfileChunk {
  id                String   @id @default(cuid())
  businessProfileId String
  // ... columns ...
  @@index([businessProfileId])
  @@index([embedding])
}
```

Delete the entire block (including the `@@index` declarations).

Commit (schema only — the migration is Step 4):

```text
chore(prisma): drop BusinessProfileChunk model — chunks live in Qdrant
```

---

## 5. Step 4 — Apply migration

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

Then regenerate the Prisma client so any lingering references (there should be none after Steps 1–2) surface as compile errors:

```bash
npx prisma generate
```

Commit (the schema change in Step 3 is already committed; the SQL file was committed alongside the runbook in Task 24). If applying via `migrate dev` locally, no additional commit is needed — Prisma records the migration state.

---

## 6. Step 5 — Build + smoke

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

If any step fails, **STOP** and consult Rollback.

---

## 7. Rollback

After cutover, the `USE_AGENT_SERVICE` flag and the legacy `core/nodes/rag` modules are gone. Rollback = single `git revert` + redeploy.

```bash
# Identify the cutover commit (the merge of Steps 1–4).
git log --oneline -n 20 | grep -E "remove USE_AGENT_SERVICE|drop BusinessProfileChunk"

# Revert it.
git revert <cutover-commit-sha>

# Redeploy monolith + agent-svc.
docker compose up -d --build
```

The migration drop is irreversible at the database level (the `BusinessProfileChunk` table is gone). To recover the data, restore from the pre-cutover DB backup. Re-running `migrate deploy` will **not** recreate the table — Prisma only tracks forward migrations.

If rollback is needed because `prisma migrate deploy` succeeded but the monolith still references `BusinessProfileChunk`, ensure the schema revert and the source-code revert land together (one commit per revert).

---

## 8. Acceptance

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

Additional checks:

- `npx prisma validate` passes.
- `npm run build` succeeds with no TypeScript errors.
- `npm test` is green.
- `scripts/replay-e2e.ts` exits with `done: N ok, 0 fail`.

When all greps are empty and all commands pass, the cutover is complete.
