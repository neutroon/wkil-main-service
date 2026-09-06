import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { AppError } from "@middlewares/errorHandler.middleware";

export interface ContentGenerationRequest {
  userId: number;
  businessProfileId: number;
  topic: string;
  length?: string;
  keywords?: string[];
  context?: string;
  generateImage?: boolean;
  businessProfile?: {
    id?: number;
    name: string;
    identity?: string;
    targetAudience?: string;
    productsServices?: unknown;
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
    userId,
    businessProfileId,
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

  const result = await AgentClient.runCapability({
    userId,
    businessProfileId,
    operation: "content_post",
    context: {
    topic,
    length,
    keywords: keywords || [],
      additionalContext: context || "",
      business: businessProfile
      ? {
          name: businessProfile.name,
            identity: businessProfile.identity,
            targetAudience: businessProfile.targetAudience,
            productsServices: businessProfile.productsServices,
          voice: businessProfile.voice,
          tone: businessProfile.tone,
            corePolicies: businessProfile.corePolicies,
            aiBehaviorInstructions: businessProfile.aiBehaviorInstructions,
        }
      : {},
      post: { generateImage: request.generateImage ?? false },
    },
  });

  const content = result.caption;
  if (!content) {
    throw new AppError("Post content generation returned no content", 502);
  }

  return {
    content,
    hashtags: result.hashtags,
    suggestedImage:
      result.suggested_image ?? result.image_prompt ?? null,
  };
};
