import { env } from "@config/env";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import type {
  ChatTier,
  AiModelProvider,
} from "@modules/admin/ai-model/ai-model.service";

/**
 * Shared AI-agent helpers used by both `modelRuntime.ts` (chat agent
 * runtime) and `pipelineRuntime.ts` (every other pipeline). Kept in its
 * own module so the chat agent and the pipeline surfaces don't drift
 * apart in their retry / fallback / credential conventions.
 */

// ── Provider credentials ──────────────────────────────────────────────────────
/**
 * Returns the env API key for a provider, or `null` if not configured.
 * The tier resolver in `ai-model.service.ts` already filters out
 * unconfigured providers, so reaching here with a missing key is a
 * configuration drift (cache stale, env rotated) — surface it as a
 * clear error rather than letting the SDK send an undefined key and
 * produce a confusing 401.
 */
export function apiKeyForProvider(provider: AiModelProvider): string | null {
  switch (provider) {
    case "google":
      return env.GEMINI_API_KEY || null;
    case "openai":
      return env.OPENAI_API_KEY || null;
    case "anthropic":
      return env.ANTHROPIC_API_KEY || null;
    default:
      return null;
  }
}

// ── Error classification ─────────────────────────────────────────────────────
const RETRYABLE_ERROR_PATTERNS = [
  "high demand",
  "unavailable",
  "service unavailable",
  "deadline",
  "timeout",
  "timed out",
  "rate limit",
  "too many requests",
];

/**
 * Returns true when the error is transient and the call should be
 * retried (rate-limit / 5xx / timeout). Provider-agnostic — works for
 * Google, OpenAI, and Anthropic.
 */
export function isRetryableProviderError(error: any): boolean {
  const message = String(error?.message || error || "").toLowerCase();
  const status = Number(error?.status ?? error?.code);
  if (status === 503 || status === 429) return true;
  return RETRYABLE_ERROR_PATTERNS.some((p) => message.includes(p));
}

/**
 * Walks the chain of nested `error.message` fields (each provider wraps
 * the actual cause one or two levels deep in JSON) and returns the most
 * descriptive final string. Falls back to `String(error)` if it can't
 * peel anything off.
 */
export function parseProviderErrorMessage(error: any): string {
  let message = error?.message || String(error);
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(message);
      const next = parsed?.error?.message || parsed?.message;
      if (!next || next === message) break;
      message = next;
    } catch {
      break;
    }
  }
  return message;
}

// ── Timeout + abort plumbing ──────────────────────────────────────────────────
export function throwIfAborted(abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) throw new Error("MODEL_TIMEOUT");
}

export function waitWithAbort(ms: number, abortSignal?: AbortSignal) {
  if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
  const signal = abortSignal;
  if (signal.aborted) return Promise.reject(new Error("MODEL_TIMEOUT"));

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(cleanupAndResolve, ms);

    function cleanupAndResolve() {
      signal.removeEventListener("abort", cleanupAndReject);
      resolve();
    }
    function cleanupAndReject() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cleanupAndReject);
      reject(new Error("MODEL_TIMEOUT"));
    }
    signal.addEventListener("abort", cleanupAndReject, { once: true });
  });
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort("MODEL_TIMEOUT");
      reject(new Error("MODEL_TIMEOUT"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ── Tier-fallback executor ───────────────────────────────────────────────────
type FallbackContext = {
  pipelineKey?: string;
  operationName: string;
  /** Logger field name; defaults to `pipeline` for non-chat, `context` for chat. */
  logScope: "pipeline" | "context";
};

type TierFallbackResult<T> = {
  result: T;
  tier: ChatTier;
};

type TierFallbackParams<T> = {
  tiers: ChatTier[];
  /**
   * Optional filter — when provided, tiers whose provider/model fails
   * the check are excluded. Used by pipelines whose operation isn't
   * supported by every provider (e.g. embeddings on Anthropic).
   */
  supportsProvider?: (provider: AiModelProvider, modelId: string) => boolean;
  /**
   * Per-tier invocation. The same contract as the chat runtime's
   * per-call operation: it may receive the `abortSignal` so it can
   * short-circuit on timeout, and it must return a promise that
   * resolves with `{ result, model }` (model is the actual id the
   * provider used, in case the registry id differs from the runtime
   * id, e.g. a future model aliasing layer).
   */
  invoke: (tier: ChatTier, abortSignal: AbortSignal) => Promise<{ result: T; model: string }>;
  timeoutMs: number;
  context: FallbackContext;
  /**
   * If true and the call exceeds the timeout, throw an AppError(504)
   * instead of letting the last error bubble. Used by the chat
   * runtime where a hard timeout is the right escalation.
   */
  throwOnTimeout?: boolean;
};

/**
 * Executes `invoke` against the configured tier list with retry on
 * transient errors and fallback to the next tier on hard failures.
 * Used by both the chat-agent runtime and every pipeline runtime.
 *
 * Retry policy per tier: up to 2 attempts, exponential-ish backoff
 * (400-700ms). Fallback policy: on any non-retryable error, or after
 * retry exhaustion, move to the next tier. The last tier's error is
 * surfaced as a 502 AppError.
 */
export async function executeWithTierFallback<T>(
  params: TierFallbackParams<T>,
): Promise<TierFallbackResult<T>> {
  const eligibleTiers = params.supportsProvider
    ? params.tiers.filter((t) => params.supportsProvider!(t.provider, t.modelId))
    : params.tiers;

  if (eligibleTiers.length === 0) {
    const label = params.context.pipelineKey ?? params.context.operationName;
    throw new AppError(
      `No configured AI model for "${label}" supports this operation (all tiers are dormant, have no API key, or don't support the operation).`,
      500,
      true,
      "AI_NO_ELIGIBLE_TIER",
    );
  }

  let lastError: any;
  for (let i = 0; i < eligibleTiers.length; i++) {
    const tier = eligibleTiers[i];
    let attempt = 0;
    while (attempt < 2) {
      const controller = new AbortController();
      try {
        const { result, model } = await withTimeout(
          params.invoke(tier, controller.signal),
          params.timeoutMs,
          controller,
        );
        return { result, tier: { ...tier, modelId: model } };
      } catch (error: any) {
        lastError = error;
        if (params.throwOnTimeout) {
          throwIfAborted(controller.signal);
        }
        const retryable = isRetryableProviderError(error);
        if (retryable && attempt === 0) {
          attempt++;
          const delay = 400 + Math.random() * 300;
          logger.warn(`ai.${params.context.logScope === "pipeline" ? "pipeline" : "model_runtime"}.retrying`, {
            [params.context.logScope]: params.context.pipelineKey ?? params.context.operationName,
            model: tier.modelId,
            provider: tier.provider,
            delayMs: Math.round(delay),
            error: parseProviderErrorMessage(error),
          });
          await waitWithAbort(delay, controller.signal);
          continue;
        }
        if (i < eligibleTiers.length - 1) {
          logger.warn(`ai.${params.context.logScope === "pipeline" ? "pipeline" : "model_runtime"}.fallback`, {
            [params.context.logScope]: params.context.pipelineKey ?? params.context.operationName,
            model: tier.modelId,
            provider: tier.provider,
            nextModel: eligibleTiers[i + 1].modelId,
            nextProvider: eligibleTiers[i + 1].provider,
            retryable,
            error: parseProviderErrorMessage(error),
          });
          break;
        }
        const message = parseProviderErrorMessage(error);
        logger.error(`ai.${params.context.logScope === "pipeline" ? "pipeline" : "model_runtime"}.final_failure`, {
          [params.context.logScope]: params.context.pipelineKey ?? params.context.operationName,
          model: tier.modelId,
          provider: tier.provider,
          error: message,
        });
        throw new AppError(message, 502);
      }
    }
  }
  throw lastError;
}
