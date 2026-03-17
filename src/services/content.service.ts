import geminiModel from "../config/gemini";
import { imageModel } from "../config/vertexai";
import cloudinary from "../config/cloudinary";

export interface ContentGenerationRequest {
  topic: string;
  tone?: string;
  length?: string;
  keywords?: string[];
  context?: string;
  generateImage?: boolean;
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
    tone = "casual",
    length = "medium",
    keywords = [],
    context = "",
    generateImage = false,
  } = request;

  if (!topic) {
    throw new Error("Topic is required");
  }

  console.log(
    `[ContentService] Post generation started: "${topic}" | Tone: ${tone} | Image: ${
      generateImage ? "Yes" : "No"
    }`,
  );

  // Validate tone and length
  const validTones = [
    "casual",
    "professional",
    "funny",
    "exciting",
    "informative",
  ];
  const validLengths = ["short", "medium", "long"];

  if (!validTones.includes(tone)) {
    throw new Error(`Invalid tone. Must be one of: ${validTones.join(", ")}`);
  }

  if (!validLengths.includes(length)) {
    throw new Error(
      `Invalid length. Must be one of: ${validLengths.join(", ")}`,
    );
  }

  // Build the prompt for Gemini
  const prompt = buildPostPrompt(topic, tone, length, keywords, context);

  // Generate content using Gemini with enhanced error handling
  const result = await geminiModel.generateContent(prompt);
  const response = result.response;

  if (!response) {
    throw new Error("No response received from Gemini");
  }

  const generatedText = response.text();

  if (!generatedText || generatedText.trim().length === 0) {
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
function buildPostPrompt(
  topic: string,
  tone: string,
  length: string,
  keywords: string[],
  context: string,
): string {
  const lengthGuidelines = {
    short: "Keep it under 100 characters, be concise and punchy",
    medium: "Write 1-2 sentences, around 100-200 characters",
    long: "Write 2-3 sentences, around 200-300 characters",
  };

  const toneGuidelines = {
    casual: "Use a friendly, conversational tone with emojis",
    professional: "Use a formal, business-appropriate tone",
    funny: "Use humor, wit, and entertaining language",
    exciting: "Use energetic, enthusiastic language with exclamation points",
    informative: "Use clear, educational language with facts",
  };

  let prompt = `Generate a Facebook post about "${topic}".`;

  prompt += `\n\nRequirements:`;
  prompt += `\n- Tone: ${
    toneGuidelines[tone as keyof typeof toneGuidelines] || toneGuidelines.casual
  }`;
  prompt += `\n- Length: ${
    lengthGuidelines[length as keyof typeof lengthGuidelines] ||
    lengthGuidelines.medium
  }`;

  if (keywords.length > 0) {
    prompt += `\n- Include these keywords naturally: ${keywords.join(", ")}`;
  }

  if (context) {
    prompt += `\n- Additional context: ${context}`;
  }

  prompt += `\n\nFormat your response as JSON with this structure:
{
  "content": "The main post text",
  "hashtags": ["#hashtag1", "#hashtag2"],
  "suggestedImage": "Brief description of ideal image"
}

Make the post engaging, platform-appropriate for Facebook, and include relevant hashtags.`;

  return prompt;
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
