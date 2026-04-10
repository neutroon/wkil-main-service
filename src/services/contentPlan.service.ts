import prisma from "../config/prisma";
import generateContent from "../config/gemini";

export interface BriefingInput {
  businessProfileId: number;
  userId: number;
  startDate: string; // ISO format
  endDate: string; // ISO format
  goals?: string;
  currentTrends?: string;
}

export async function generateContentStrategy(briefing: BriefingInput) {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: briefing.businessProfileId },
    include: {
      faqs: true,
      crmIntegrations: true,
    },
  });

  if (!profile) {
    throw new Error("Business profile not found");
  }

  // 1. Build the persona and context
  const persona = `
Business Persona Details:
- Name: ${profile.name}
- Identity: ${profile.identity}
- Target Audience: ${profile.targetAudience}
- Tone: ${profile.tone}
- Products/Services: ${profile.productsServices.join(", ")}
${briefing.goals ? `- Primary Campaign Goals: ${briefing.goals}` : ""}
${briefing.currentTrends ? `- Specific Topic/Trends to Focus On: ${briefing.currentTrends}` : ""}
  `.trim();

  // 2. Prompt Gemini for the strategy with Google Search Grounding to check trends
  const prompt = `You are an expert Social Media & Marketing Agency Director.
Your task is to build an optimal Content Marketing Strategy Calendar between ${briefing.startDate} and ${briefing.endDate}.
You have access to Google Search to look up current live trends, upcoming holidays, and industry movements relevant to this business.

${persona}

Instructions:
1. Calculate the optimal frequency of posts (how many posts per week).
2. Distribute the posts evenly throughout the specified date range.
3. For each post, determine the optimal 'platform' (facebook, instagram, linkedin), 'pillar' (e.g. Educational, Promotional, Behind the Scenes), 'topic', and 'format' (image_post, carousel, reel, story).
4. Do NOT generate the actual deep content (no captions or scripts yet). Just high-level topics and formats.
5. Provide your output strictly as a JSON array of objects representing the calendar, with NO markdown wrapping.

Schema:
[
  {
    "scheduledAt": "ISO String (e.g. 2026-05-01T10:00:00Z)",
    "platform": "facebook",
    "pillar": "Educational",
    "topic": "5 ways our service saves you time",
    "format": "carousel"
  }
]
`;

  console.log(`[ContentPlanService] Submitting Strategy Gen to Gemini for Profile ${profile.id}...`);

  // We pass `true` to enableSearch for live grounding
  const responseText = await generateContent(prompt, "application/json", true);
  
  if (!responseText) {
    throw new Error("Failed to generate strategy from Gemini");
  }

  let parsedCalendar: Array<{
    scheduledAt: string;
    platform: string;
    pillar: string;
    topic: string;
    format: string;
  }> = [];

  try {
    const cleanText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    parsedCalendar = JSON.parse(cleanText);
  } catch (err) {
    console.error("Gemini failed to output valid JSON", err);
    throw new Error("Invalid format received from AI. Try again.");
  }

  // 3. Save the strategy to Database
  const plan = await prisma.contentPlan.create({
    data: {
      businessProfileId: profile.id,
      userId: briefing.userId,
      startDate: new Date(briefing.startDate),
      endDate: new Date(briefing.endDate),
      goals: briefing.goals,
      currentTrends: briefing.currentTrends,
      status: "draft",
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
          businessProfile: true,
        },
      },
    },
  });

  if (!post) {
    throw new Error("Post not found");
  }

  if (post.contentPlan.userId !== userId) {
    throw new Error("Unauthorized");
  }

  const profile = post.contentPlan.businessProfile;

  // 2. Build targeted prompt depending on the format
  const persona = `
- Brand Name: ${profile.name}
- Tone: ${profile.tone}
- Target Audience: ${profile.targetAudience}
- Products: ${profile.productsServices.join(", ")}
  `.trim();

  let schemaInstruct = "";
  if (post.format === "carousel") {
    schemaInstruct = `
Output strictly as JSON:
{
  "caption": "The main text status update that introduces the carousel including hashtags",
  "carouselSlides": [
    {
      "slideText": "Short punchy text for slide 1",
      "slideImagePrompt": "Visual description for slide 1 image generation"
    }
  ]
}`;
  } else if (post.format === "reel" || post.format === "story") {
    schemaInstruct = `
Output strictly as JSON:
{
  "caption": "The caption for the video including hashtags",
  "reelScript": "Audio/Visual structure. E.g. [0:00 - 0:05] Audio: Hello world. Visual: Face camera."
}`;
  } else {
    // Standard image post
    schemaInstruct = `
Output strictly as JSON:
{
  "caption": "The main post text including emojis and hashtags",
  "imagePrompt": "Detailed visual description of the ideal AI-generated image for this post"
}`;
  }

  const prompt = `You are a creative copywriter executing a single piece of social media content.
Context:
${persona}
Campaign Goals: ${post.contentPlan.goals || "Provide value and engagement"}

Task:
Write the content for a ${post.platform} post.
Pillar: ${post.pillar}
Topic: ${post.topic}
Format type: ${post.format}

Follow this exact JSON structure:
${schemaInstruct}
Do NOT include any surrounding markdown. Just the raw JSON.`;

  console.log(`[ContentPlanService] Generating Post Execution for Post ${postId} (${post.format})...`);
  
  const responseText = await generateContent(prompt, "application/json", false);

  if (!responseText) {
    throw new Error("Failed to generate post execution: No text returned from Gemini. This may be due to safety filters.");
  }

  try {
    const cleanText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(cleanText);

    // Save back to DB
    const updatedPost = await prisma.contentPlanPost.update({
      where: { id: postId },
      data: {
        caption: result.caption,
        imagePrompt: result.imagePrompt || null,
        reelScript: result.reelScript || null,
        carouselSlides: result.carouselSlides || null,
        status: "generated", // Moved forward from pending
      },
    });

    return updatedPost;
  } catch (err) {
    console.error("Gemini JSON Parsing error for Post Execution", err);
    throw new Error("Failed to parse the generated content from AI.");
  }
}
