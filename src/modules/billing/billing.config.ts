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
  "gemini-3-flash-preview": { prompt: 0.075, completion: 0.30 },
  "gemini-3.1-flash-lite": { prompt: 0.018, completion: 0.072 },
  "gemini-3.1-flash-lite-preview": { prompt: 0.018, completion: 0.072 },
  "gemini-3.1-flash-image-preview": { prompt: 0.50, completion: 60.00 },
};

/**
 * Common services pricing
 */
export const EMBEDDING_RATE_PER_TOKEN = 0.025 / 1_000_000;
export const GROUNDING_FEE_PER_CALL = 0.035; // Flat fee for Google Search Grounding per query
export const GROUNDING_FREE_TIER_PER_DAY = 1000;

/**
 * Quota and Plan Limits (Monthly Credits)
 * Internal Unit: 1 Credit = $0.001 (1/10th of a cent)
 */
export const CREDIT_VALUE_USD = 0.001;

export const PLAN_CREDIT_LIMITS: Record<string, number> = {
  "FREE": 5_000,      // $5.00 of compute value
  "PRO": 50_000,     // $50.00 of compute value
  "ENTERPRISE": 500_000, // $500.00 of compute value
};

// Default multiplier if not set in DB
export const DEFAULT_BILLING_MULTIPLIER = 2.5;
