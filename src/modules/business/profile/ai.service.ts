import { AgentClient } from "@modules/ai-agent/client/agent.client";

async function discoverStrategicLinks(
  userId: number,
  businessProfileId: number | null,
  baseUrl: string,
  pageContent: string,
) {
  if (!businessProfileId) throw new Error("A business profile is required for strategic link discovery");
  const result = await AgentClient.runCapability({
    userId, businessProfileId, operation: "strategic_links",
    context: { baseUrl, pageContent },
  });
  return result.links.map((link) => link.url);
}

async function extractBusinessIdentity(
  userId: number,
  businessProfileId: number | null,
  markdown: string,
) {
  if (!businessProfileId) throw new Error("A business profile is required for business identity extraction");
  const result = await AgentClient.runCapability({
    userId, businessProfileId, operation: "business_identity", context: { markdown },
  });
  return {
    name: result.name,
    identity: result.identity,
    targetAudience: result.target_audience,
    voice: result.voice,
    tone: result.tone,
    productsServices: result.products_services,
    corePolicies: result.core_policies,
    confidence: result.confidence,
  };
}

export { discoverStrategicLinks, extractBusinessIdentity };


