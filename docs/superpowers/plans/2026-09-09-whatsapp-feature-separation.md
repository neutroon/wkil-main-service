# WhatsApp AI Replies and Order Confirmations Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let each connected WhatsApp number independently run order confirmations, AI replies, or both, preserving the existing per-conversation AI control and order workflow.

**Architecture:** Add WhatsAppAccount.aiRepliesEnabled, default true. Normal WhatsApp messages must pass the account-level gate and the existing conversation-level gate before invoking AI. Order-confirmation events, notifications, acknowledgements, and button actions never consult this flag. Expose the account gate through an authenticated API and the WhatsApp channel UI.

**Tech Stack:** TypeScript, Express, Prisma/PostgreSQL, BullMQ, Zod, OpenAPI, Next.js, React Query, Vitest.

**Spec:** back-end/docs/superpowers/specs/2026-09-09-whatsapp-feature-separation-design.md

## Global Constraints

- Database default true preserves existing behavior.
- Account AI off still persists inbound customer messages but sends no AI reply.
- Confirm/Cancel actions bypass AI and remain idempotent.
- Order-confirmation messages are not blocked by AI settings.
- Messenger, widget, and other channel behavior is unchanged.
- Write and observe a failing test before each production behavior change.
- Update the OpenAPI document and regenerate app/src/types/openapi.generated.ts.

---

### Task 1: Add the account-level AI setting and API

**Files:**
- Create: back-end/prisma/migrations/20260909100000_add_whatsapp_ai_reply_toggle/migration.sql
- Modify: back-end/prisma/schema.prisma, WhatsAppAccount
- Modify: back-end/src/modules/meta/whatsapp/whatsapp.controller.ts
- Modify: back-end/src/modules/meta/whatsapp/whatsapp.routes.ts
- Modify: back-end/src/modules/meta/whatsapp/whatsapp.controller.test.ts

**Interfaces:**
- Consumes: existing account authorization and toggleAiSchema.
- Produces: PATCH /v1/whatsapp/accounts/:id/ai-toggle with body { enabled: boolean }, returning a sanitized account containing aiRepliesEnabled.

- [ ] **Step 1: Write the failing controller tests**

Extend the Prisma mock with accountUpdate and add a test named updates account-level AI replies without changing order-confirmation settings. Arrange an active linked account and a successful update, call whatsappController.toggleAiReplies with id 9 and enabled false, and assert:

~~~ts
expect(mocks.accountUpdate).toHaveBeenCalledWith({
  where: { id: 9 },
  data: { aiRepliesEnabled: false },
});
expect(response.json).toHaveBeenCalledWith({
  data: expect.objectContaining({ id: 9, aiRepliesEnabled: false }),
});
~~~

Add tests for an unlinked account owned by the authenticated user, a linked account requiring profile-management access, and an unrelated account being rejected.

- [ ] **Step 2: Run the focused test and verify the intended failure**

Run from back-end:

~~~powershell
npm test -- src/modules/meta/whatsapp/whatsapp.controller.test.ts
~~~

Expected: the new test fails because the method and update path do not exist. If collection stops first on the pre-existing R2_PUBLIC_URL test-environment error, fix only test setup or record that blocker without weakening the production assertion.

- [ ] **Step 3: Add the schema field and migration**

Add aiRepliesEnabled Boolean @default(true) to WhatsAppAccount. Add a migration containing:

~~~sql
ALTER TABLE "WhatsAppAccount"
ADD COLUMN "aiRepliesEnabled" BOOLEAN NOT NULL DEFAULT TRUE;
~~~

- [ ] **Step 4: Implement the controller method**

Add toggleAiReplies. Parse the positive account id, load the active account, authorize it using the same linked-profile or owning-user rules as link/unlink, update only aiRepliesEnabled, invalidate the WhatsApp identity cache, and return sanitiseAccount(updated). Do not update OrderIntegration or Conversation rows.

- [ ] **Step 5: Mount and validate the route**

Import toggleAiSchema and mount:

~~~ts
whatsappRoutes.patch(
  "/accounts/:id/ai-toggle",
  authenticateToken,
  validate(toggleAiSchema),
  (req, res) => whatsappController.toggleAiReplies(req, res),
);
~~~

- [ ] **Step 6: Run backend API tests**

~~~powershell
npm test -- src/modules/meta/whatsapp/whatsapp.controller.test.ts src/app.routes.test.ts
~~~

Expected: the new API behavior passes; report any unrelated R2_PUBLIC_URL setup failure separately.

### Task 2: Gate only normal WhatsApp AI

**Files:**
- Modify: back-end/src/modules/meta/core/metaProcessor.service.ts
- Modify: back-end/src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts
- Create if needed: back-end/src/modules/meta/core/metaProcessor.aiToggle.test.ts

**Interfaces:**
- Consumes: aiRepliesEnabled from WhatsApp identity resolution and aiEnabled from Conversation.
- Produces: persisted normal messages with no AI send when the account gate is false; unchanged order action routing.

- [ ] **Step 1: Write failing processor tests**

Add a test named persists a normal WhatsApp message but skips AI when account AI replies are disabled. Use an account fixture with aiRepliesEnabled false, a conversation with aiEnabled true, and assert the user message is saved while AgentClient customer_reply is not called. Add the inverse enabled-account test and retain the existing action-bypass assertion.

The action test must include aiRepliesEnabled false and still assert enqueueOrderAction is called before account identity or AI work.

- [ ] **Step 2: Run the processor tests and verify failure**

~~~powershell
npm test -- src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts src/modules/meta/core/metaProcessor.aiToggle.test.ts
~~~

Expected: the disabled-account test reaches the current AI path and fails for that reason.

- [ ] **Step 3: Carry the setting through identity resolution**

Add aiRepliesEnabled to IdentityResolution and CachedIdentity. Select it from both cached-token and database WhatsApp account lookups, preserve it in the cache payload, and invalidate identity:whatsapp:<phoneNumberId> and cache:known_wa:<phoneNumberId> after a toggle.

- [ ] **Step 4: Add the normal-message gate**

After the normal WhatsApp user message is persisted and before history/model invocation, apply:

~~~ts
if (platform === "whatsapp" && identity.aiRepliesEnabled === false) return;
if (conversation.aiEnabled === false) return;
~~~

Keep ORDER_ACTION above identity resolution. Do not add the gate to order-confirmation senders, action processing, delivery receipts, opt-out suppression, coexistence imports, or manual outbound replies.

- [ ] **Step 5: Run focused processor tests again**

Expected: account-off messages persist without AI; account-on plus conversation-on messages invoke and deliver AI; order buttons still bypass AI.

### Task 3: Add frontend API, mutation, and channel UI

**Files:**
- Modify: app/src/lib/whatsapp-api.ts
- Modify: app/src/lib/config.ts
- Modify: app/src/hooks/social/useWhatsAppIntegration.ts
- Modify: app/src/components/user/WhatsAppConnection.tsx
- Modify: app/messages/en/social.json or the existing WhatsApp translation file
- Modify: app/messages/ar/social.json or the existing WhatsApp translation file
- Test: app/src/components/user/WhatsAppConnection.test.tsx or create it

**Interfaces:**
- Consumes: the account toggle endpoint and account response field.
- Produces: a permission-aware optimistic switch whose copy says it controls normal AI replies only and order confirmations remain independent.

- [ ] **Step 1: Write failing frontend tests**

Add an API/component test asserting that switching account 9 sends PATCH with { enabled: false }, updates the cached account, and renders AI-reply and independent-order-confirmation copy. Assert the control is disabled for a user without channel-management permission.

- [ ] **Step 2: Run the focused frontend test and verify failure**

~~~powershell
npm test -- src/components/user/WhatsAppConnection.test.tsx
~~~

Expected: the new assertions fail because the API method, mutation, field, and control do not exist.

- [ ] **Step 3: Add the frontend contract**

Extend WhatsAppAccount with aiRepliesEnabled: boolean. Add WHATSAPP_API.AI_TOGGLE(id) and whatsappAPI.toggleAiReplies(id, enabled), returning either data or the direct account shape.

- [ ] **Step 4: Add the React Query mutation**

Create useToggleWhatsAppAiReplies. Cancel account queries, snapshot both unscoped and profile-scoped caches, optimistically change the matching account, roll back on error, and invalidate on settle.

- [ ] **Step 5: Add the account-card switch**

Render the switch for linked accounts in WhatsAppConnection, guarded by canManageChannels and the existing busy/action conventions. Disabling must say it stops automatic AI replies to normal messages; order confirmations, Confirm, and Cancel remain independent.

- [ ] **Step 6: Add English and Arabic translations and rerun the test**

Add label, enabled/disabled state, description, and failure text without implying that the WhatsApp connection or order-confirmation integration is disabled.

### Task 4: Document and regenerate the API contract

**Files:**
- Modify: back-end/docs/openapi.yaml
- Regenerate: app/src/types/openapi.generated.ts

- [ ] **Step 1: Add a failing route/documentation contract check**

Run the existing route/doc checks before adding the path and capture the missing route result:

~~~powershell
npm run docs:check
~~~

- [ ] **Step 2: Document the endpoint**

Add PATCH /v1/whatsapp/accounts/{id}/ai-toggle with authentication, positive id, enabled boolean request body, sanitized account response including aiRepliesEnabled, and a description stating that normal AI replies are controlled independently from order confirmations.

- [ ] **Step 3: Regenerate the types**

~~~powershell
npm run types:api
~~~

Confirm the generated file contains the new operation and no secrets or unrelated API churn.

- [ ] **Step 4: Run documentation checks**

~~~powershell
npm run docs:check
~~~

Expected: OpenAPI lint, route parity, and bundle checks pass.

### Task 5: Full verification and behavior audit

**Files:**
- Inspect: all changed files in app and back-end
- Modify: only for feature-specific failures found during verification

- [ ] **Step 1: Run backend focused regressions**

~~~powershell
cd back-end
npm test -- src/modules/order-confirmation/orderConfirmation.metaProcessor.test.ts src/modules/meta/core/metaProcessor.aiToggle.test.ts src/modules/meta/whatsapp/whatsapp.controller.test.ts src/app.routes.test.ts
~~~

- [ ] **Step 2: Run frontend focused tests and lint**

~~~powershell
cd app
npm test -- src/components/user/WhatsAppConnection.test.tsx
npm run lint -- src/components/user/WhatsAppConnection.tsx src/hooks/social/useWhatsAppIntegration.ts src/lib/whatsapp-api.ts
~~~

- [ ] **Step 3: Run backend build and docs checks**

~~~powershell
cd back-end
npm run build
npm run docs:check
~~~

- [ ] **Step 4: Run the frontend production build**

~~~powershell
cd app
npm run build:noturbopack
~~~

- [ ] **Step 5: Audit all four combinations**

Verify from implementation and tests:

| Order integration | Account AI replies | Expected |
| --- | --- | --- |
| Off | Off | No automatic order-confirmation or AI replies |
| On | Off | Confirmation/acknowledgement works; normal text is saved without AI |
| Off | On | Normal text reaches AI; no order workflow is created |
| On | On | Both run independently; buttons still bypass AI |

- [ ] **Step 6: Inspect both Git repositories**

~~~powershell
git diff --check
git status --short --branch
git diff --stat
~~~

Report any pre-existing test-environment failure separately. Mark the goal complete only after fresh verification evidence covers each required behavior.
