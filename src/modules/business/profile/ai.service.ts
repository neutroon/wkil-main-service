import { AgentClient } from "@modules/ai-agent/client/agent.client";

async function discoverStrategicLinks(
  userId: number,
  businessProfileId: number | null,
  baseUrl: string,
  pageContent: string,
) {
  return AgentClient.runAgent({
    business_profile_id: businessProfileId,
    user_id: userId,
    messages: [],
    stage: "fast",
  } as any) as any;
}

async function extractBusinessIdentity(
  userId: number,
  businessProfileId: number | null,
  markdown: string,
) {
  return AgentClient.runAgent({
    business_profile_id: businessProfileId,
    user_id: userId,
    messages: [],
    stage: "fast",
  } as any) as any;
}

export { discoverStrategicLinks, extractBusinessIdentity };


