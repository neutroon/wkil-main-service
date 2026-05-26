export const INTEGRATION_ACTION_TYPES = ["LOOKUP", "MUTATION"] as const;
export type IntegrationActionType = (typeof INTEGRATION_ACTION_TYPES)[number];

export const INTEGRATION_ACTION_TRIGGERS = ["CHAT_REQUESTED"] as const;
export type IntegrationActionTrigger = (typeof INTEGRATION_ACTION_TRIGGERS)[number];

export const INTEGRATION_EXECUTION_MODES = ["BACKGROUND"] as const;
export type IntegrationExecutionMode = (typeof INTEGRATION_EXECUTION_MODES)[number];

export const INTEGRATION_CONFIRMATION_POLICIES = [
  "REQUIRE_VERIFIED_RESULT",
  "ACCEPT_HTTP_SUCCESS",
] as const;
export type IntegrationConfirmationPolicy =
  (typeof INTEGRATION_CONFIRMATION_POLICIES)[number];

export const EXTERNAL_FAILURE_BEHAVIORS = [
  "AUTO",
  "HANDOFF_ON_FAILURE",
  "ANSWER_WITH_CONTEXT_ON_FAILURE",
  "SILENT_ON_FAILURE",
] as const;
export type ExternalFailureBehavior = (typeof EXTERNAL_FAILURE_BEHAVIORS)[number];
