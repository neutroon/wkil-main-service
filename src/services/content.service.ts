import generateContent from "../config/gemini";
import { imageModel } from "../config/vertexai";
import cloudinary from "../config/cloudinary";

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
    keywords = [],
    context = "",
    generateImage = false,
    businessProfile,
  } = request;

  if (!topic) {
    throw new Error("Topic is required");
  }

  console.log(
    `[ContentService] Post generation started: "${topic}" | Image: ${
      generateImage ? "Yes" : "No"
    }`,
  );

  // Validate length
  const validLengths = ["short", "medium", "long"];

  if (!validLengths.includes(length)) {
    throw new Error(
      `Invalid length. Must be one of: ${validLengths.join(", ")}`,
    );
  }

  // Build the prompt for Gemini
  const prompt = buildPostPrompt(request);

  // Generate content using Gemini with enhanced error handling
  const generatedText = await generateContent(prompt);

  if (!generatedText) {
    throw new Error("No response received from Gemini");
  }

  if (generatedText.trim().length === 0) {
    throw new Error("Empty response from Gemini");
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

  return `You are an expert social media manager. Generate a highly engaging Facebook post about "${topic}".

${
  businessProfile
    ? `<persona>
- Agency/Business Name: ${businessProfile.name}
- Identity/Industry: ${businessProfile.identity}
- Target Audience: ${businessProfile.targetAudience}
- Voice (REQUIRED LANGUAGE): ${businessProfile.voice}
- Tone: ${businessProfile.tone}
</persona>

CRITICAL: All generated content (post text and hashtags) MUST be written strictly in the language and dialect specified in the "Voice" field above (e.g., if Voice is Egyptian Arabic, you MUST write in Egyptian Arabic). Do not use English unless the Voice field explicitly allows it.`
    : `<tone>\nUse a friendly, professional tone optimized for high social media engagement.\n</tone>`
}

<post_requirements>
1. Length: ${selectedLength}
${keywords && keywords.length > 0 ? `2. Keywords to include naturally: ${keywords.join(", ")}` : ""}
${context ? `3. Additional Context: ${context}` : ""}
4. Output format: Must be raw, strictly valid JSON without markdown wrapping.
</post_requirements>

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
      throw new Error("No image generated from Imagen");
    }

    const imageBase64 =
      result.response.candidates[0].content.parts[0].inlineData?.data;

    if (!imageBase64) {
      throw new Error("No image data returned from Imagen");
    }

    const imageBuffer = Buffer.from(imageBase64, "base64");

    if (!imageBuffer || imageBuffer.length === 0) {
      throw new Error("Empty image buffer returned");
    }

    console.log(
      `[ContentService] Image generated successfully (${imageBuffer.length} bytes)`,
    );
    return imageBuffer;
  } catch (error: any) {
    console.error("[ContentService] Image generation error:", error.message);
    throw new Error(`Failed to generate image: ${error.message}`);
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
          reject(new Error("No result from Cloudinary upload"));
        }
      },
    );
    uploadStream.end(buffer);
  });
}
