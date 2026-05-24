import { generateContent, generateContentStream } from "@modules/ai-agent/gemini";
import { recordAiUsage, assertQuotaAvailable } from "../billing/billing.service";
import { logger } from "@utils/logger";
import { retrieveRelevantChunks } from "../ai-agent/rag/rag.service";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";

export interface BriefingInput {
  businessProfileId: number;
  userId: number;
  startDate: string; // ISO format
  endDate: string; // ISO format
  goals?: string;
  currentTrends?: string;
}

const SOCIAL_MEDIA_SPECIALIST_ROLE = `You are a senior social media specialist, market-aware content strategist, and brand copywriter. Your job is to turn business context into platform-native content that attracts attention, builds trust, and supports measurable campaign goals.`;

export async function* generateContentStrategyStream(briefing: BriefingInput) {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: briefing.businessProfileId },
    include: {
      faqs: true,
    },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  // Pre-flight quota check
  await assertQuotaAvailable(profile.userId, briefing.businessProfileId);

  // 1. Common Persona Details
  const persona = `
Business Persona Details:
- Name: ${profile.name}
- Identity: ${profile.identity}
- Target Audience: ${profile.targetAudience}
- Voice (REQUIRED LANGUAGE & DIALECT): ${profile.voice}
- Tone (Attitude): ${profile.tone}
- Products/Services: ${profile.productsServices.join(", ")}
${profile.faqs.length > 0 ? `- Frequently Asked Questions: ${profile.faqs.map((f) => `Q: ${f.question} A: ${f.answer}`).join(" | ")}` : ""}
${briefing.goals ? `- Primary Campaign Goals: ${briefing.goals}` : ""}
${briefing.currentTrends ? `- Specific Topic/Trends to Focus On: ${briefing.currentTrends}` : ""}
  `.trim();

  // 1b. RAG Enhancement: Retrieve relevant chunks based on goals/trends
  let ragContext = "";
  try {
    const query =
      `${briefing.goals || ""} ${briefing.currentTrends || ""} ${profile.identity}`.trim();
    const chunks = await retrieveRelevantChunks(profile.id, query, 5);
    if (chunks.length > 0) {
      ragContext = `\n--- INTERNAL BUSINESS KNOWLEDGE ---\n${chunks.map((c) => `[${c.chunkType}]: ${c.content}`).join("\n\n")}\n----------------------------------\n`;
    }
  } catch (err) {
    logger.warn(
      `[StrategyPipe] RAG retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. STAGE 1: Market Intelligence & Trend Research (STREAMED)
  yield {
    type: "status",
    message: "Stage 1/2: Researching live market trends and holidays...",
  };

  const researchPrompt = `${SOCIAL_MEDIA_SPECIALIST_ROLE}
Your task is to research current trends, upcoming holidays, seasonal events, and industry movements relevant to the following business profile for the period between ${briefing.startDate} and ${briefing.endDate}.

${persona}
${ragContext}

Instructions:
1. Use Google Search to find specific dates for holidays or events.
2. Identify 3-5 trends, seasonal hooks, audience conversations, or category movements that are relevant to this exact business.
3. Translate each trend into practical content angles a social media specialist would actually brief to a writer.
4. Highlight audience motivations, likely objections, and timely reasons to post during this period.
5. Avoid generic trend labels. Tie every recommendation back to the persona, products/services, target audience, and campaign goals.
6. [CRITICAL] Provide a concise research summary in the language and dialect specified in the "Voice" field above (e.g., if Voice is Egyptian Arabic, you MUST write the summary in Egyptian Arabic even if sources are in English).`;

  let researchSummary = "";
  let isGrounded = false;

  let streamUsage: any = null;
  try {
    const { result, model } = await generateContentStream(
      researchPrompt,
      "text/plain",
      true,
    );
    for await (const chunk of result) {
      const chunkText = chunk.text || "";
      researchSummary += chunkText;

      // Capture exact usage from the final chunk (Gemini best practice)
      if (chunk.usageMetadata) {
        streamUsage = chunk.usageMetadata;
      }

      yield { type: "research_chunk", text: chunkText };
    }

    const usage = streamUsage;
    const grounding = (result as any).candidates?.[0]?.groundingMetadata
      ?.searchEntryPoint;

    recordAiUsage({
      userId: profile.userId,
      businessProfileId: profile.id,
      promptTokens: usage?.promptTokenCount || usage?.promptTokens || 0,
      completionTokens:
        usage?.candidatesTokenCount || usage?.completionTokens || 0,
      groundingCalls: grounding ? 1 : 0,
      modelName: model,
      operation: "content_plan_research",
    }).catch(console.error);

    isGrounded = true;
    yield {
      type: "status",
      message: "Live research complete. Building your strategy map...",
    };
  } catch (err: any) {
    console.warn(`[StrategyPipe] Research Stream FAILED: ${err.message}`);
    researchSummary =
      "Live research was unavailable. Proceeding with general marketing best practices.";
    isGrounded = false;
    yield {
      type: "status",
      message: "Live research failed (fallback enabled). Drafting strategy...",
    };
  }

  // 3. STAGE 2: Strategic Planning (JSON)
  yield {
    type: "status",
    message: "Stage 2/2: Drafting optimal content calendar...",
  };

  const strategyPrompt = `${SOCIAL_MEDIA_SPECIALIST_ROLE}
You are acting as the lead social media director. Build a Content Marketing Strategy Calendar between ${briefing.startDate} and ${briefing.endDate}.

${persona}
${ragContext}

--- MARKET RESEARCH & TRENDS ---
${researchSummary}
--------------------------------

Instructions:
1. Based on the persona, internal knowledge, campaign goals, and market research, plan a content calendar with specialist-level judgment.
2. Choose content pillars that cover a healthy mix of education, authority, trust proof, community engagement, offer/lead generation, and timely trend relevance.
3. Each topic must be a sharp creative brief, not a vague label. It should include the angle, audience benefit, or emotional trigger.
4. Match the format to the communication job: carousel for step-by-step education, image_post for strong single ideas, reel/story for quick hooks and timely moments.
5. Avoid repetitive angles and generic posts that could fit any business.
6. [CRITICAL] All user-facing strings in the JSON (topic, etc.) MUST be in the language specified in the "Voice" field.

Output strictly as a JSON array of objects.

Schema:
[
  {
    "scheduledAt": "ISO String",
    "platform": "facebook",
    "pillar": "Educational",
    "topic": "Topic in ${profile.voice}",
    "format": "carousel"
  }
]`;

  // We now capture usage from generateContent
  const { text: responseText, usage } = await generateContent(
    strategyPrompt,
    "application/json",
    false,
  );

  // Log strategic generation usage
  recordAiUsage({
    userId: profile.userId,
    businessProfileId: profile.id,
    ...usage,
    operation: "content_plan_strategy_generation",
  }).catch(console.error);

  if (!responseText) {
    throw new AppError("Failed to generate strategy JSON", 502);
  }

  let parsedCalendar = [];
  try {
    const cleanText = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    parsedCalendar = JSON.parse(cleanText);
  } catch (err) {
    throw new AppError("Invalid strategic format received from AI.", 502);
  }

  yield {
    type: "status",
    message: "Finalizing and saving to your workspace...",
  };

  // 4. Save to Database
  const plan = await prisma.contentPlan.create({
    data: {
      businessProfileId: profile.id,
      userId: briefing.userId,
      startDate: new Date(briefing.startDate),
      endDate: new Date(briefing.endDate),
      goals: briefing.goals,
      currentTrends: briefing.currentTrends,
      status: "draft",
      isGrounded,
      researchSummary,
      posts: {
        create: parsedCalendar.map((item: any) => ({
          scheduledAt: new Date(item.scheduledAt),
          platform: item.platform,
          pillar: item.pillar,
          topic: item.topic,
          format: item.format,
          status: "pending",
        })),
      },
    },
    include: {
      posts: true,
    },
  });

  yield { type: "result", data: plan };
}

export async function generateContentStrategy(briefing: BriefingInput) {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: briefing.businessProfileId },
    include: {
      faqs: true,
    },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  // Pre-flight quota check
  await assertQuotaAvailable(profile.userId, briefing.businessProfileId);

  // 1. Common Persona Details
  const persona = `
Business Persona Details:
- Name: ${profile.name}
- Identity: ${profile.identity}
- Target Audience: ${profile.targetAudience}
- Voice (REQUIRED LANGUAGE & DIALECT): ${profile.voice}
- Tone (Attitude): ${profile.tone}
- Products/Services: ${profile.productsServices.join(", ")}
${profile.faqs.length > 0 ? `- Frequently Asked Questions: ${profile.faqs.map((f) => `Q: ${f.question} A: ${f.answer}`).join(" | ")}` : ""}
${briefing.goals ? `- Primary Campaign Goals: ${briefing.goals}` : ""}
${briefing.currentTrends ? `- Specific Topic/Trends to Focus On: ${briefing.currentTrends}` : ""}
  `.trim();

  // 1b. RAG Enhancement
  let ragContext = "";
  try {
    const query =
      `${briefing.goals || ""} ${briefing.currentTrends || ""} ${profile.identity}`.trim();
    const chunks = await retrieveRelevantChunks(profile.id, query, 5);
    if (chunks.length > 0) {
      ragContext = `\n--- INTERNAL BUSINESS KNOWLEDGE ---\n${chunks.map((c) => `[${c.chunkType}]: ${c.content}`).join("\n\n")}\n----------------------------------\n`;
    }
  } catch (err) {
    logger.warn(
      `[StrategyPipe] RAG retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. STAGE 1: Market Intelligence & Trend Research (with Grounding)
  console.log(
    `[StrategyPipe] Stage 1: Deep Researching for Profile ${profile.id}...`,
  );

  const researchPrompt = `${SOCIAL_MEDIA_SPECIALIST_ROLE}
Your task is to research current trends, upcoming holidays, seasonal events, and industry movements relevant to the following business profile for the period between ${briefing.startDate} and ${briefing.endDate}.

${persona}
${ragContext}

Instructions:
1. Use Google Search to find specific dates for holidays or events in this period (both global and local to the business audience).
2. Identify 3-5 trends, seasonal hooks, audience conversations, or category movements that would resonate with the target audience right now.
3. Translate each trend into practical content angles a social media specialist would actually brief to a writer.
4. Suggest the best "Content Pillars" to focus on and explain why they fit the business goals.
5. Highlight audience motivations, likely objections, and timely reasons to post during this period.
6. Avoid generic trend labels. Tie every recommendation back to the persona, products/services, target audience, and campaign goals.
7. [CRITICAL] Provide a concise, high-quality research summary strictly in the language and dialect specified in the "Voice" field above (e.g., if Voice is Egyptian Arabic, you MUST write the summary in Egyptian Arabic).

Provide the research summary in plain text.`;

  let researchSummary = "";
  let isGrounded = false;

  try {
    const { text, usage } = await generateContent(
      researchPrompt,
      "text/plain",
      true,
    );

    // Log research usage (heavy grounding)
    recordAiUsage({
      userId: profile.userId,
      businessProfileId: profile.id,
      ...usage,
      operation: "content_plan_research_sync",
    }).catch(console.error);

    if (text) {
      researchSummary = text;
      isGrounded = true;
      console.log(`[StrategyPipe] Stage 1 COMPLETE. Research gathered.`);
    }
  } catch (err: any) {
    console.warn(
      `[StrategyPipe] Stage 1 FAILED: ${err.message}. Falling back to baseline knowledge.`,
    );
    researchSummary =
      "Live research was unavailable. Proceeding with general marketing best practices.";
    isGrounded = false;
  }

  // 3. STAGE 2: Strategic Planning (Structured JSON)
  console.log(
    `[StrategyPipe] Stage 2: Strategy Generation for Profile ${profile.id}...`,
  );

  const strategyPrompt = `${SOCIAL_MEDIA_SPECIALIST_ROLE}
You are acting as the lead social media director. Build a Content Marketing Strategy Calendar between ${briefing.startDate} and ${briefing.endDate}.

${persona}
${ragContext}

--- MARKET RESEARCH & TRENDS ---
${researchSummary}
--------------------------------

Instructions:
1. Based on the research and business persona above, calculate the optimal frequency and distribute posts evenly.
2. For each post, determine: 'platform' (facebook, instagram, linkedin), 'pillar', 'topic', and 'format' (image_post, carousel, reel, story).
3. Choose content pillars that cover a healthy mix of education, authority, trust proof, community engagement, offer/lead generation, and timely trend relevance.
4. Each topic must be a sharp creative brief, not a vague label. It should include the angle, audience benefit, or emotional trigger.
5. Match the format to the communication job: carousel for step-by-step education, image_post for strong single ideas, reel/story for quick hooks and timely moments.
6. Ensure the topics directly leverage the trends and holidays found during research where relevant.
7. Avoid repetitive angles and generic posts that could fit any business.
8. [CRITICAL] All user-facing strings in the output JSON (especially 'topic') MUST be in the language specified in the "Voice" field.
9. Output strictly as a JSON array of objects. No markdown.

Schema:
[
  {
    "scheduledAt": "ISO String",
    "platform": "facebook",
    "pillar": "Educational",
    "topic": "Actual topic in ${profile.voice}",
    "format": "carousel"
  }
]`;

  // We use structured JSON mode here (Search is already done, so no conflict)
  const { text: responseText, usage } = await generateContent(
    strategyPrompt,
    "application/json",
    false,
  );

  // Log strategy usage
  recordAiUsage({
    userId: profile.userId,
    businessProfileId: profile.id,
    ...usage,
    operation: "content_plan_strategy_sync",
  }).catch(console.error);

  if (!responseText) {
    throw new AppError("Failed to generate strategy from Gemini", 502);
  }

  let parsedCalendar: Array<{
    scheduledAt: string;
    platform: string;
    pillar: string;
    topic: string;
    format: string;
  }> = [];

  try {
    const cleanText = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    parsedCalendar = JSON.parse(cleanText);
  } catch (err) {
    console.error("Gemini failed to output valid JSON in Stage 2", err);
    throw new AppError(
      "Invalid format received from AI in strategy phase. Try again.",
      502
    );
  }

  // 4. Save to Database with Grounding Metadata
  const plan = await prisma.contentPlan.create({
    data: {
      businessProfileId: profile.id,
      userId: briefing.userId,
      startDate: new Date(briefing.startDate),
      endDate: new Date(briefing.endDate),
      goals: briefing.goals,
      currentTrends: briefing.currentTrends,
      status: "draft",
      isGrounded,
      researchSummary,
      posts: {
        create: parsedCalendar.map((item) => ({
          scheduledAt: new Date(item.scheduledAt),
          platform: item.platform,
          pillar: item.pillar,
          topic: item.topic,
          format: item.format,
          status: "pending",
        })),
      },
    },
    include: {
      posts: true,
    },
  });

  return plan;
}

export async function generatePostExecution(postId: number, userId: number) {
  // 1. Fetch Post and Plan Configuration
  const post = await prisma.contentPlanPost.findUnique({
    where: { id: postId },
    include: {
      contentPlan: {
        include: {
          businessProfile: {
            include: {
              faqs: true,
            },
          },
        },
      },
    },
  });

  if (!post) {
    throw new AppError("Post not found", 404);
  }

  // Pre-flight quota check
  await assertQuotaAvailable(userId, post.contentPlan.businessProfile.id);

  if (post.contentPlan.userId !== userId) {
    throw new AppError("Unauthorized", 401);
  }

  // 2. Set 'generating' status immediately for resilience
  await prisma.contentPlanPost.update({
    where: { id: postId },
    data: { status: "generating" },
  });

  try {
    const profile = post.contentPlan.businessProfile;

    // 2b. Build targeted prompt depending on the format
  const persona = `
- Brand Name: ${profile.name}
- Identity: ${profile.identity}
- Voice (REQUIRED LANGUAGE & DIALECT): ${profile.voice}
- Tone (Attitude): ${profile.tone}
- Target Audience: ${profile.targetAudience}
- Products: ${profile.productsServices.join(", ")}
${profile.faqs && profile.faqs.length > 0 ? `- FAQs: ${profile.faqs.map((f: any) => `Q: ${f.question} A: ${f.answer}`).join(" | ")}` : ""}
  `.trim();

  // 1b. RAG Context for specific post topic
  let postKnowledge = "";
  try {
    const chunks = await retrieveRelevantChunks(
      profile.id,
      `${post.topic} ${post.pillar} ${profile.name}`,
      3,
    );
    if (chunks.length > 0) {
      postKnowledge = `\n--- SPECIFIC BUSINESS KNOWLEDGE FOR THIS TOPIC ---\n${chunks.map((c) => c.content).join("\n\n")}\n------------------------------------------------\n`;
    }
  } catch (err) {
    logger.warn(
      `[PostExec] RAG retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let schemaInstruct = "";
  if (post.format === "carousel") {
    schemaInstruct = `
Output strictly as JSON:
{
  "caption": "A platform-native caption that introduces the carousel with a strong hook, useful promise, and hashtags",
  "carouselSlides": [
    {
      "slideText": "Short punchy slide copy with one clear idea, benefit, or step",
      "slideImagePrompt": "Visual description for slide 1 image generation"
    }
  ]
}`;
  } else if (post.format === "reel" || post.format === "story") {
    schemaInstruct = `
Output strictly as JSON:
{
  "caption": "The caption for the video with a strong hook, CTA, and hashtags",
  "reelScript": "Audio/Visual structure with a 0-3 second hook. E.g. [0:00 - 0:05] Audio: Hello world. Visual: Face camera."
}`;
  } else {
    // Standard image post
    schemaInstruct = `
Output strictly as JSON:
{
  "caption": "A high-engagement social media caption. Use a punchy hook, body with value/benefit, and a clear call-to-action. Tone MUST match the persona.",
  "imagePrompt": "A world-class technical photography brief. Describe: 1. Subject action & emotion, 2. Specific camera angle (Dutch angle, low-shot, etc), 3. Material textures, 4. Lighting style (e.g. moody chiaroscuro or high-key airy sunlight), 5. Compositional focus. Avoid AI-generic descriptions."
}`;
  }

  const prompt = `${SOCIAL_MEDIA_SPECIALIST_ROLE}
You are executing one publish-ready piece as a senior content writer and social media copywriter.
Context:
${persona}
${postKnowledge}
Campaign Goals: ${post.contentPlan.goals || "Provide value and engagement"}

Task:
Write the content for a ${post.platform} post.
Pillar: ${post.pillar}
Topic: ${post.topic}
Format type: ${post.format}

Follow this exact JSON structure:
${schemaInstruct}

[CRITICAL INSTRUCTIONS]:
1. Language/Dialect: You MUST write ALL content (caption, slide text, scripts, etc.) strictly in the language specified in the "Voice" field above: ${profile.voice}.
2. Platform-Native Writing: Make the copy feel written by a real social media specialist for ${post.platform}. Use a strong opening hook, scannable value, and a natural CTA.
3. Audience Fit: Speak directly to the target audience's needs, motivations, objections, and desired outcome. Avoid generic advice that could fit any brand.
4. Copywriting Framework: Use AIDA, PAS, before/after/bridge, storytelling, or educational sequencing when it fits the topic. Do not mention the framework.
5. Fact-Checking: Use the provided "BUSINESS KNOWLEDGE" and persona details to include specific information about products, services, policies, or FAQs. Do not invent prices, guarantees, claims, locations, or statistics.
6. Visual Narrative: Your "imagePrompt" values are for a high-end Art Director. Be descriptive, technical, and artistic. Avoid words like "photorealistic" - instead, describe the lighting, lens, and texture.
7. Hashtags: Include a concise set of relevant hashtags in the caption, aligned with the language/dialect and audience.
8. Identity: Ensure the content perfectly matches the Brand Name, Voice, and Tone.
9. Output: Do NOT include any surrounding markdown. Just the raw JSON.`;

  console.log(
    `[ContentPlanService] Generating Post Execution for Post ${postId} (${post.format})...`,
  );

  const { text: responseText, usage } = await generateContent(
    prompt,
    "application/json",
    false,
  );

  // Log post execution usage
  recordAiUsage({
    userId: profile.userId,
    businessProfileId: profile.id,
    ...usage,
    operation: "content_plan_post_execution",
  }).catch(console.error);

  if (!responseText) {
    throw new AppError(
      "Failed to generate post execution: No text returned from Gemini. This may be due to safety filters.",
      502
    );
  }

  try {
    const cleanText = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const result = JSON.parse(cleanText);

    // Save back to DB
    const updatedPost = await prisma.contentPlanPost.update({
      where: { id: postId },
      data: {
        caption: result.caption,
        imagePrompt: result.imagePrompt || null,
        reelScript: result.reelScript || null,
        carouselSlides: result.carouselSlides || null,
        status: "generated", // Ready for user review / visual request
      },
    });

    return updatedPost;
  } catch (err) {
    // Reset status on error so user can retry
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: { status: "pending" },
    });
    console.error("Gemini JSON Parsing error for Post Execution", err);
    throw new AppError("Failed to parse the generated content from AI.", 502);
  }
} catch (outerErr: any) {
  // Global catch for the entire generation process
  await prisma.contentPlanPost.update({
    where: { id: postId },
    data: { status: "pending" },
  });
  logger.error("generatePostExecution.global_failure", { postId, error: outerErr.message });
  throw outerErr;
}
}




