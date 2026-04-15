/**
 * Production-Grade AI Pricing Configuration (USD per 1,000,000 tokens)
 * Rates based on Vertex AI / Google AI Studio April 2026 standards.
 */
export const MODEL_PRICING: Record<
  string,
  { prompt: number; completion: number }
> = {
  "gemini-3.1-flash": { prompt: 0.075, completion: 0.30 },
  "gemini-3-flash": { prompt: 0.075, completion: 0.30 },
  "gemini-3.1-flash-lite": { prompt: 0.018, completion: 0.072 },
};

/**
 * Common services pricing
 */
export const EMBEDDING_RATE_PER_TOKEN = 0.025 / 1_000_000;
export const GROUNDING_FEE_PER_CALL = 0.035; // Flat fee for Google Search Grounding per query
export const GROUNDING_FREE_TIER_PER_DAY = 1000;

/**
 * Quota and Plan Limits (Monthly Tokens)
 */
export const PLAN_TOKEN_LIMITS: Record<string, number> = {
  "FREE": 500_000,
  "PRO": 5_000_000,
  "ENTERPRISE": 50_000_000,
};

// Default multiplier if not set in DB
export const DEFAULT_BILLING_MULTIPLIER = 2.5;
