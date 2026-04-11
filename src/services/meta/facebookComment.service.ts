import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { 
  getFacebookUserProfile, 
  replyToComment, 
  sendPrivateReply,
  getPageAccessToken
} from "./facebook.service";
import { computeBusinessChatReply, AiRoutingDecision } from "../ai/aiEngine.service";
import { saveMessage, getOrCreateConversation } from "./conversation.service";
import { emitToBusiness, emitToConversation } from "../../utils/socket";

export interface FacebookCommentJob {
  pageId: string;
  senderId: string;
  commentId: string;
  postId: string;
  messageText: string;
  senderName?: string;
}

/**
 * Helper to retry an operation with exponential backoff
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 1) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

export async function handleFacebookComment(job: FacebookCommentJob) {
  const { pageId, senderId, commentId, postId, messageText } = job;

  // 1. Idempotency Check & DB Record Creation (Write-Ahead)
  // We use the commentId as externalId to ensure we only process this comment once.
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: { businessProfile: true }
  });

  if (!page || !page.businessProfileId || !page.businessProfile) {
    logger.error("facebook.comment.page_not_found_or_not_linked", { pageId });
    return;
  }

  const businessProfile = page.businessProfile;

  let conversation: any;
  try {
    // Check if already processed
    const existing = await prisma.conversation.findUnique({
      where: { externalId: commentId }
    });

    if (existing) {
      logger.debug("facebook.comment.already_processed", { commentId });
      return;
    }

    // Create the conversation first (idempotency guard)
    conversation = await prisma.conversation.create({
      data: {
        pageId,
        senderId,
        businessProfileId: page.businessProfileId,
        channel: "facebook_comment",
        externalId: commentId,
        postId: postId,
        processingStatus: "PENDING",
        status: "OPEN"
      }
    });
  } catch (error: any) {
    // Handle race condition if two webhooks arrive at the same time
    if (error.code === "P2002") {
      logger.debug("facebook.comment.race_condition_prevented", { commentId });
      return;
    }
    throw error;
  }

  try {
    // 2. Fetch Sender Name if missing
    let senderName = job.senderName;
    if (!senderName) {
       const profile = await getFacebookUserProfile(senderId, pageId);
       senderName = profile?.name || "there";
    }

    // 3. Parallel AI Response Generation
    const [privateReply, publicGreeting] = await Promise.all([
      // A. The Detailed Private Reply
      computeBusinessChatReply({
        businessProfile,
        messageText,
        historyTurns: [], // Fresh comment start
        channel: "messenger", // DM is messenger channel
      }),
      // B. The Short Public Greeting
      generatePublicGreeting(businessProfile, senderName || "there")
    ]);

    // 4. Save to Database
    const userMsg = await saveMessage(conversation.id, "user", messageText);
    
    // Save Public Greeting
    await saveMessage(conversation.id, "model", publicGreeting, {
      status: "SENT",
      aiReasoning: "Generated public greeting to direct user to inbox",
      handoffCategory: "PUBLIC_COMMENT_REPLY"
    });

    // Save Private DM
    const modelMsg = await saveMessage(conversation.id, "model", privateReply.content || "", {
      status: businessProfile.responseMode === "AUTO" ? "SENT" : "PENDING_REVIEW",
      aiReasoning: privateReply.reasoning,
      handoffCategory: privateReply.handoffCategory
    });

    // Emit real-time events
    emitToBusiness(page.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: userMsg,
    });
    
    // 5. Execute API Calls (Public & Private)
    const pageAccessToken = await getPageAccessToken(pageId);

    // Call Public Reply
    await withRetry(async () => {
      await replyToComment({
        commentId,
        message: publicGreeting,
        accessToken: pageAccessToken
      });
    });

    // Call Private Reply (if auto mode)
    if (businessProfile.responseMode === "AUTO" && privateReply.content) {
      await withRetry(async () => {
        await sendPrivateReply({
          commentId,
          message: privateReply.content!,
          accessToken: pageAccessToken
        });
      });
    }

    // 6. Final Status Update
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { processingStatus: "COMPLETED" }
    });

    // Emit the draft or the sent message
    emitToBusiness(page.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: modelMsg,
    });

    logger.info("facebook.comment.processed_successfully", { commentId, senderId });

  } catch (error: any) {
    logger.error("facebook.comment.processing_failed", { 
      commentId, 
      error: error.message 
    });
    
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { processingStatus: "FAILED" }
    }).catch(() => {});
  }
}

/**
 * Generates a short public greeting either via AI or Template
 */
async function generatePublicGreeting(profile: any, name: string): Promise<string> {
  if (profile.facebookGreetingMode === "TEMPLATE") {
    return profile.facebookGreetingTemplate.replace("{{name}}", name);
  }

  // AI Generation for Brand-Aware Greeting
  const instruction = `
    You are the AI for ${profile.name}.
    A customer named ${name} just commented on your post.
    You must provide ONLY a single, short, one-sentence public reply acknowledging them 
    and letting them know you've sent the full details to their Private Message (DM).
    Tone: ${profile.tone}.
    Example: "Thanks ${name}! I've just sent the full details to your inbox."
    Language: Match the brand's voice (${profile.voice}).
    Return ONLY the text of the reply.
  `;

  try {
     const decision = await computeBusinessChatReply({
       businessProfile: profile,
       messageText: `Internal: Generate public greeting for ${name}`,
       historyTurns: [{ role: "user", text: instruction }],
       channel: "messenger"
     });
     return decision.content || `Thanks ${name}! Checking your inbox for details.`;
  } catch {
     return profile.facebookGreetingTemplate.replace("{{name}}", name);
  }
}
