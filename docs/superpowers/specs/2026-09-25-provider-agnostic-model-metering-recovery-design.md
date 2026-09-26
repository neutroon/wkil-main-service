# Confirmed-usage AI metering and chat recovery

## Outcome and scope

WKIL's AI credits are a monthly usage allowance, not a strict prepaid cash balance. A failed or ambiguous provider call must not leave a credit hold that prevents later chat. WKIL charges customer credits only for actual usage evidence received from a model response, once per model-call event ID. If a provider or billing response is lost and usage cannot be proven, WKIL accepts that bounded cost risk rather than charging a customer without evidence or suspending chat pending review.

The observed production failure came from `AgentModelReservation.userId` being the primary key: one failed provider call left a row without `AiCallLog`, causing all later model attempts by the same user to fail with HTTP 409. The one-time production waiver already performed was an incident action; this design prevents that lock class from recurring.

This design covers the backend's internal quota and usage endpoints, the Python model-metering callback, and verification that web/mobile display run failures. It does not add a new ledger, provider-specific billing adapters, a second LangGraph checkpointer, a new admin UI, or a recurring manual reconciliation prerequisite for chat.

## Billing policy and data flow

Retain the existing `GET /internal/agent/quota` preflight gate before an agent run. The gateway/agent supply canonical authenticated identity; the quota endpoint checks that user's recorded credits. The current backend uses a 60-second quota cache; successful usage posting must invalidate that cache for the affected user. Distinguish a confirmed `quota_exceeded` result from a timeout or backend outage. On an unavailable quota service, fail closed quickly with a retryable service-unavailable error, not a false upgrade/quota message.

Remove the pre-model `reserve_model_call` and post-model `release_model_call` from the active Python callback path. The backend keeps the old `/model-calls/reserve` and `/release` routes temporarily as compatibility endpoints during a coordinated deployment, but they must no longer create or consult a user-wide blocking reservation. Existing `AgentModelReservation` rows are preserved as historical data and are ignored for admission; do not delete them or run a destructive production migration as part of this work.

At model start, the callback records the stable model run/event ID and authenticated scope locally. On a response with `usage_metadata`, it sends actual model name and token counts to the existing internal `/usage` endpoint. `AiCallLog.eventId` already has a unique constraint, and the existing billing transaction records the usage log, aggregates, and credit debit together. Preserve and test identical-event idempotency and conflicting-event rejection. Usage posts may be retried only with the same event ID and payload. No estimated usage is charged.

A provider error, timeout, missing usage metadata, or exhausted usage-post retry does not debit credits or hold quota. The callback emits a redacted operational error with event ID, model identifier, and failure category, without prompts, response text, email, or credentials. Billing-report failure must not replace an otherwise valid model reply with a blank/failed chat; WKIL absorbs that unrecorded usage unless authoritative evidence is recovered later through an explicitly audited adjustment. Alerts are for cost and reliability monitoring, not a condition for the customer to continue chatting.

## Cost and latency bounds

This policy is intentionally not a mathematically exact prepaid spending cap. A run can cross the monthly limit before its final usage is recorded, and concurrent runs can increase that overage. Bound exposure using the existing model output cap of 4,096 tokens, agent-loop limit of eight model turns per run, input/context limits, authenticated gateway limits, and the preflight quota gate. Do not add a new permanent lock or a reservation table to approximate a hard cap. Measure per-user concurrent runs and quota overage in production; tighten admission limits only if evidence shows the current bounds are insufficient.

The quota call already exists today. Removing the separate reservation HTTP request and database transaction adds no new pre-model round trip. Do not promise a specific latency improvement without p50/p95 measurement. Give the quota request a short bounded timeout so a billing-service outage does not produce a long spinner.

## Agent and client failure behavior

Keep the existing LangChain provider fallback and bounded SDK retry settings; do not stack another retry layer without an explicit attempt budget. Exhausted model failures must be observable as failures, never converted to an ordinary assistant answer. LangGraph Agent Server continues to own run/checkpoint persistence. Its replay semantics do not make external model calls exactly once, so each successful usage event still needs its stable idempotency key.

Verify that the backend gateway forwards Agent Server stream errors and that both web and mobile display a retryable error state rather than an indefinitely pending message when the provider returns 503 or the quota service is unavailable. Change client code only if this verification reveals a gap. A later chat attempt must not be rejected because an earlier run failed without usage.

## Rollout and verification

Coordinate backend and agent deployment: make compatibility reserve/release routes nonblocking before deploying an agent version that no longer calls them. Do not deploy or mutate production data as part of local implementation. Keep old reservation rows for a separate, explicitly approved retention/cleanup decision. No public API schema change is expected; update the internal contract and operational runbook. If public response behavior changes, update OpenAPI and affected generated clients together.

Test: existing unresolved row does not affect new chat; quota exceeded versus quota-service outage; no reservation call before a model; provider 503 followed by a successful later chat; success posts exact usage once; duplicate and conflicting event IDs; usage-post failure still permits a valid reply and raises a redacted alert; quota-cache invalidation; bounded timeout; web/mobile run-error presentation. Run each repository's required focused and broad checks. No live provider credentials or production customer data are needed.

## Framework and operational basis

- [LangChain model errors](https://docs.langchain.com/oss/python/langchain/models#model-exceptions) and [retry/fallback middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in#model-retry) provide provider-agnostic failure handling, not a customer-credit ledger.
- [LangGraph fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance), [re-execution and idempotency](https://docs.langchain.com/oss/python/langgraph/graph-api#re-execution-and-idempotency), and [Agent Server-managed persistence](https://docs.langchain.com/oss/python/langgraph/persistence) define the execution boundary.
- [Usage-event identifiers](https://docs.stripe.com/api/billing/meter-event/object) and [idempotent responses](https://docs.aws.amazon.com/wellarchitected/2024-06-27/framework/rel_prevent_interaction_failure_idempotent.html) inform the metering contract; [bounded request throttling](https://docs.aws.amazon.com/wellarchitected/2023-10-03/framework/rel_mitigate_interaction_failure_throttle_requests.html) informs cost exposure controls. This is an application-specific inference, not a claim that these sources prescribe WKIL's credit policy.
