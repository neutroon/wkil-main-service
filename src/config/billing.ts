/**
 * Production-Grade AI Pricing Configuration (USD per 1,000,000 tokens)
 * Rates based on Vertex AI / Google AI Studio April 2026 standards.
 */
export const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  "gemini-2.5-flash": { prompt: 0.10, completion: 0.30 },
  "gemini-2.5-flash-lite": { prompt: 0.05, completion: 0.15 },
  "gemini-2.0-flash": { prompt: 0.10, completion: 0.30 },
  "gemini-1.5-flash": { prompt: 0.075, completion: 0.30 },
};

/**
 * Common services pricing
 */
export const EMBEDDING_RATE_PER_TOKEN = 0.025 / 1_000_000;
export const GROUNDING_FEE_PER_CALL = 0.035; // Flat fee for Google Search Grounding per query

// Default multiplier if not set in DB
export const DEFAULT_BILLING_MULTIPLIER = 2.5;
