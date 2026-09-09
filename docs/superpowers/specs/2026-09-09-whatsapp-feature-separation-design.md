# WhatsApp AI Replies and Order Confirmations Separation

Date: 2026-09-09  
Status: Approved for implementation

## Goal

Allow a connected WhatsApp number to run order confirmations, AI replies, or both without either workflow depending on the other.

## Current behavior and problem

Order confirmations already have their own `OrderIntegration` and queue, while normal WhatsApp messages use the shared Meta inbound queue and the per-conversation `Conversation.aiEnabled` flag. The missing boundary is a WhatsApp-number-level AI control: new conversations default to AI enabled, so a merchant who wants confirmation-only operation must disable AI conversation by conversation. There is also no channel-settings control that communicates the two independent capabilities.

## Design

Add `WhatsAppAccount.aiRepliesEnabled`, defaulting to `true` for backward compatibility. This is the channel-level gate for normal customer-message AI on that connected number. The existing `Conversation.aiEnabled` remains the finer-grained per-conversation override.

The effective AI policy for a normal WhatsApp inbound message is:

```text
WhatsAppAccount.aiRepliesEnabled === true
  AND Conversation.aiEnabled !== false
```

If the account-level flag is false, the message is persisted but no AI run or AI outbound message is created. If it is true, the existing conversation-level toggle continues to control individual threads. Other channels are unchanged.

Order-confirmation processing does not consult `aiRepliesEnabled` or `Conversation.aiEnabled`:

- A signed `order.created` event is accepted only by an active order integration.
- The order-confirmation worker resolves an active approved WhatsApp template and sends the request independently.
- Templates without buttons are notification-only.
- Templates with the required Confirm and Cancel quick replies create an order action workflow.
- Confirm/Cancel webhook events are classified as `ORDER_ACTION`, queued to the order-confirmation worker, and never enter the AI path.
- A successful action sends a separate acknowledgement and may enqueue independent store synchronization.

This gives four intentional combinations per WhatsApp number:

| Order integration | AI replies | Result |
| --- | --- | --- |
| Off | Off | No automatic order-confirmation or AI replies |
| On | Off | Order confirmations and button acknowledgements only |
| Off | On | Normal WhatsApp AI replies only |
| On | On | Both independent workflows |

The existing per-conversation AI toggle can still turn AI off for a single thread when the account-level AI setting is on. Re-enabling the account-level setting does not overwrite conversation-level choices.

## Backend changes

1. Add a Prisma migration for `WhatsAppAccount.aiRepliesEnabled BOOLEAN NOT NULL DEFAULT TRUE`.
2. Include the flag in account list and OAuth connection responses, without exposing secrets.
3. Add `PATCH /v1/whatsapp/accounts/:id/ai-toggle` with the existing authenticated account-management authorization pattern and `{ enabled: boolean }` validation.
4. Update `processMetaMessage` to load the account flag as part of identity resolution and skip only normal WhatsApp AI when it is false. It must still save the inbound message and must not affect `ORDER_ACTION`, delivery receipts, opt-out suppression, coexistence imports, manual replies, order notifications, or acknowledgements.
5. Keep order-confirmation sender and action paths independent from the account AI flag.
6. Add backend unit/controller/route coverage for authorization, persistence, account-level gating, and action bypass.
7. Update `back-end/docs/openapi.yaml` and regenerate `app/src/types/openapi.generated.ts`.

## Frontend changes

1. Extend `WhatsAppAccount` with `aiRepliesEnabled`.
2. Add the account toggle API method and React Query mutation with optimistic cache update and rollback.
3. Add an AI replies toggle to each linked WhatsApp account card in `WhatsAppConnection`, visible only to users who can manage channels.
4. Explain in the UI that this controls normal AI replies only; order confirmations remain independent.
5. Preserve the existing inbox per-conversation AI switch and make no changes to Messenger or widget settings.
6. Add English and Arabic translations and component/API tests.

## Error handling and compatibility

- Database default `true` preserves current behavior for all existing and newly connected accounts.
- A failed toggle request rolls back the UI cache and reports the existing user-facing error.
- Account lookup failure remains a queue failure and is retried by the existing inbound-message policy; once the account is resolved, the persisted database flag controls AI execution.
- Order-confirmation failures remain visible through their existing notification/order state and retry paths.
- No order-confirmation message is blocked by an AI setting.

## Verification

- Run focused backend tests for WhatsApp account controller, Meta processor, order-confirmation action routing, and route mounting.
- Run focused frontend tests for WhatsApp account API/hooks and connection UI.
- Run backend TypeScript build and OpenAPI route/docs checks.
- Run frontend typecheck/build-compatible test suite and lint for touched files where available.
- Inspect the final diff in both repositories and verify all four behavior combinations from code/tests.
