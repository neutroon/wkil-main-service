import { generateContent } from "@modules/ai-agent/gemini";
import { imageModel } from "@modules/ai-agent/vertexai.config";
import cloudinary from "@modules/media/cloudinary.config";
import { AppError } from "@middlewares/errorHandler.middleware";

export interface ContentGenerationRequest {
  topic: string;
  length?: string;
  keywords?: string[];
  context?: string;
  generateImage?: boolean;
  businessProfile?: {
    name: string;
    identity: string;
    targetAudience: string;
    voice: string;
    tone: string;
    productsServices?: string[];
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
    generateImage = false,
  } = request;

  if (!topic) {
    throw new AppError("Topic is required", 400);
  }

  console.log(
    `[ContentService] Post generation started: "${topic}" | Image: ${
      generateImage ? "Yes" : "No"
    }`,
  );

  // Validate length
  const validLengths = ["short", "medium", "long"];

  if (!validLengths.includes(length)) {
    throw new AppError(
      `Invalid length. Must be one of: ${validLengths.join(", ")}`,
      400
    );
  }

  // Build the prompt for Gemini
  const prompt = buildPostPrompt(request);

  // Generate content using Gemini with enhanced error handling
  const { text: generatedText } = await generateContent(prompt);

  // Log usage via new service if you want to track it for individual posts
  // (Assuming you have businessProfileId available if logged in)

  if (!generatedText) {
    throw new AppError("No response received from Gemini", 502);
  }

  if (generatedText.trim().length === 0) {
    throw new AppError("Empty response from Gemini", 502);
  }

  // Parse the response to extract content, hashtags, and image suggestion
  const parsedResponse = parseGeminiResponse(generatedText);

  // Optionally generate image with Imagen
  if (generateImage && parsedResponse.suggestedImage) {
    try {
      const imageBuffer = await generateImageWithImagen(
        parsedResponse.suggestedImage,
      );
      const { url, publicId } = await uploadBufferToCloudinary(imageBuffer);

      console.log(`[ContentService] Post generated successfully | Image: Yes`);

      return {
        ...parsedResponse,
        imageUrl: url,
        imagePublicId: publicId,
      };
    } catch (imageError: any) {
      console.error(
        "[ContentService] Image generation error:",
        imageError.message,
      );
      // Return text content even if image generation fails
      console.log(`[ContentService] Post generated with image error`);

      return {
        ...parsedResponse,
        imageError: "Failed to generate image: " + imageError.message,
      };
    }
  }

  console.log(`[ContentService] Post generated successfully | Image: No`);
  return parsedResponse;
};

// Helper function to build effective prompts
function buildPostPrompt(req: ContentGenerationRequest): string {
  const { topic, length, keywords, context, businessProfile } = req;

  const lengthGuidelines = {
    short: "Keep it under 100 characters, be concise and punchy",
    medium: "Write 1-2 sentences, around 100-200 characters",
    long: "Write 2-3 sentences, around 200-300 characters",
  };

  const selectedLength =
    lengthGuidelines[(length || "medium") as keyof typeof lengthGuidelines] ||
    lengthGuidelines.medium;

  return `You are a senior social media strategist, conversion-focused content writer, and Facebook-native copywriter. Generate a high-performing Facebook post about "${topic}".

${
  businessProfile
    ? `<persona>
- Agency/Business Name: ${businessProfile.name}
- Identity/Industry: ${businessProfile.identity}
- Target Audience: ${businessProfile.targetAudience}
- Voice (REQUIRED LANGUAGE): ${businessProfile.voice}
- Tone: ${businessProfile.tone}
${businessProfile.productsServices?.length ? `- Products/Services: ${businessProfile.productsServices.join(", ")}` : ""}
${businessProfile.aiBehaviorInstructions ? `- Additional Writing Instructions: ${businessProfile.aiBehaviorInstructions}` : ""}
${businessProfile.corePolicies ? `- Factual Boundaries and Policies: ${businessProfile.corePolicies}` : ""}
</persona>

CRITICAL: The business profile voice and tone are the source of truth. All generated content (post text and hashtags) MUST be written strictly in the language and dialect specified in the "Voice" field above (e.g., if Voice is Egyptian Arabic, you MUST write in Egyptian Arabic). The tone MUST match the "Tone" field. Additional context may refine the topic and details, but must not override the profile voice, language, dialect, tone, or factual boundaries. Do not use English unless the Voice field explicitly allows it.`
    : `<tone>\nUse a friendly, professional tone optimized for high social media engagement.\n</tone>`
}

<post_requirements>
1. Length: ${selectedLength}
${keywords && keywords.length > 0 ? `2. Keywords to include naturally: ${keywords.join(", ")}` : ""}
${context ? `3. Additional Context: ${context}` : ""}
4. Output format: Must be raw, strictly valid JSON without markdown wrapping.
</post_requirements>

<copywriting_standards>
- Start with a specific hook tied to the target audience's pain point, desire, timely opportunity, or curiosity gap.
- Write like a real social media specialist: clear angle, useful insight, brand-fit wording, and a natural call-to-action.
- Make the post platform-native for Facebook: conversational, scannable, and engaging without sounding like an ad unless the context asks for sales copy.
- Use concrete benefits and business-specific details from the persona/context. Do not invent prices, guarantees, statistics, locations, or claims that were not provided.
- Keep emojis tasteful and relevant. Avoid generic AI phrases, filler, repeated slogans, and overused hashtags.
- Hashtags must be relevant, concise, and in the same language/dialect style as the post unless the persona requires otherwise.
- The suggested image should be a brand-aware visual concept that supports the post angle and would stop the target audience while scrolling.
</copywriting_standards>

<json_structure>
{
  "content": "The main post text including emojis and line breaks if appropriate",
  "hashtags": ["#hashtag1", "#hashtag2"],
  "suggestedImage": "Brief visual description of an ideal AI-generated image to attach to this post"
}
</json_structure>

Return ONLY the JSON.`;
}

// Helper function to parse Gemini response
function parseGeminiResponse(text: string): GeneratedContent {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        content: parsed.content || text,
        hashtags: parsed.hashtags || [],
        suggestedImage: parsed.suggestedImage || null,
      };
    }
  } catch (error) {
    console.log("Could not parse JSON from Gemini response, using raw text");
  }

  // Fallback: return the raw text as content
  return {
    content: text,
    hashtags: [],
    suggestedImage: null,
  };
}

// Helper function to generate image with Imagen
async function generateImageWithImagen(prompt: string): Promise<Buffer> {
  try {
    console.log(
      `[ContentService] Generating image for prompt: ${prompt.substring(
        0,
        50,
      )}...`,
    );

    const result = await imageModel.generateContent(prompt);

    if (
      !result.response ||
      !result.response.candidates ||
      result.response.candidates.length === 0
    ) {
      throw new AppError("No image generated from Imagen", 502);
    }

    const imageBase64 =
      result.response.candidates[0].content.parts[0].inlineData?.data;

    if (!imageBase64) {
      throw new AppError("No image data returned from Imagen", 502);
    }

    const imageBuffer = Buffer.from(imageBase64, "base64");

    if (!imageBuffer || imageBuffer.length === 0) {
      throw new AppError("Empty image buffer returned", 502);
    }

    console.log(
      `[ContentService] Image generated successfully (${imageBuffer.length} bytes)`,
    );
    return imageBuffer;
  } catch (error: any) {
    throw new AppError(`Failed to generate image: ${error.message}`, 502);
  }
}

// Helper function to upload buffer to Cloudinary
async function uploadBufferToCloudinary(
  buffer: Buffer,
): Promise<{ url: string; publicId: string }> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "pagespilot-ai-generated" },
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error.message);
          reject(error);
        } else if (result) {
          resolve({ url: result.secure_url, publicId: result.public_id });
        } else {
          reject(new AppError("No result from Cloudinary upload", 502));
        }
      },
    );
    uploadStream.end(buffer);
  });
}




