import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { AppError } from "@middlewares/errorHandler.middleware";

export interface ContentGenerationRequest {
  topic: string;
  length?: string;
  keywords?: string[];
  context?: string;
  generateImage?: boolean;
  businessProfile?: {
    name: string;
    voice: string;
    tone: string;
    corePolicies?: string | null;
    aiBehaviorInstructions?: string | null;
  } | null;
}

export interface GeneratedContent {
  content: string;
  hashtags: string[];
  suggestedImage?: string | null;
  imageUrl?: string;
  imagePublicId?: string;
  imageError?: string;
}

export const generatePostContent = async (
  request: ContentGenerationRequest,
): Promise<GeneratedContent> => {
  const {
    topic,
    length = "medium",
    keywords,
    context,
    businessProfile,
  } = request;

  if (!topic) {
    throw new AppError("Topic is required", 400);
  }

  const validLengths = ["short", "medium", "long"];
  if (!validLengths.includes(length)) {
    throw new AppError(
      `Invalid length. Must be one of: ${validLengths.join(", ")}`,
      400
    );
  }

  const result = await AgentClient.runContentGeneration("post", {
    topic,
    length,
    keywords: keywords || [],
    context: context || "",
    settings: businessProfile
      ? {
          name: businessProfile.name,
          voice: businessProfile.voice,
          tone: businessProfile.tone,
          core_policies: businessProfile.corePolicies,
          ai_behavior_instructions: businessProfile.aiBehaviorInstructions,
        }
      : {},
  });

  const draft = (result as any)?.content_generation ?? result ?? {};
  const content = draft.caption ?? draft.content;
  if (!content) {
    throw new AppError("Post content generation returned no content", 502);
  }

  return {
    content,
    hashtags: draft.hashtags || [],
    suggestedImage:
      draft.image_prompt ?? draft.imagePrompt ?? draft.suggestedImage ?? null,
  };
};
