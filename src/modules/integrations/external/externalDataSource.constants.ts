export const EXTERNAL_ROUTING_MODES = ["STRICT", "FAST"] as const;
export type ExternalRoutingMode = (typeof EXTERNAL_ROUTING_MODES)[number];

export const EXTERNAL_FAILURE_BEHAVIORS = [
  "AUTO",
  "HANDOFF_ON_FAILURE",
  "ANSWER_WITH_CONTEXT_ON_FAILURE",
  "SILENT_ON_FAILURE",
] as const;
export type ExternalFailureBehavior = (typeof EXTERNAL_FAILURE_BEHAVIORS)[number];

export const EXTERNAL_ROUTER_TIMEOUT = {
  defaultMs: 2_500,
  minMs: 1_000,
  maxMs: 10_000,
} as const;

export const EXTERNAL_DATA_SOURCE_LIMITS = {
  maxRouterSources: 12,
} as const;
