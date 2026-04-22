import { calculateSystemCost, calculateCustomerCost } from "../services/billing.service";
import { CREDIT_VALUE_USD } from "../config/billing";
import { logger } from "../utils/logger";

async function runTest() {
  const modelName = "gemini-3.1-flash-image-preview";
  const promptTokens = 1000;
  const completionTokens = 2000; // Typical for high-res 1.5k-2k pixels tokens

  logger.info("--- STARTING CREDIT BILLING VERIFICATION ---", { modelName, promptTokens, completionTokens });

  // 1. System Cost
  const systemCost = calculateSystemCost({ modelName, promptTokens, completionTokens });
  logger.info("System Cost Check:", { 
    systemCost, 
    expected: (1000 * (0.50/1000000)) + (2000 * (60.00/1000000)) 
  });

  // 2. Customer Cost & Credits
  const { customerCost, multiplier } = await calculateCustomerCost({ modelName, promptTokens, completionTokens });
  const creditsUsed = Math.ceil(customerCost / CREDIT_VALUE_USD);
  
  logger.info("Credit Deduction Check:", { 
    customerCost, 
    multiplier,
    creditsUsed,
    expectedCredits: Math.ceil((0.1205 * multiplier) / 0.001)
  });

  // 3. Fallback Test
  const fallbackSystemCost = calculateSystemCost({ modelName: "unknown-model", promptTokens, completionTokens });
  logger.info("Fallback Cost Check (should warn):", { 
    fallbackSystemCost,
    expected: (1000 * (0.075/1000000)) + (2000 * (0.30/1000000)) 
  });

  logger.info("--- CREDIT BILLING VERIFICATION COMPLETE ---");
}

runTest().catch(console.error);
