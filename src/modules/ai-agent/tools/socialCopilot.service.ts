import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  createPost,
  schedulePost,
  getPagePosts,
  getPostComments,
  deleteFacebookPost,
  replyToComment,
} from "@modules/meta/facebook/facebook.service";

// ---------------------------------------------------------------------------
// Social copilot wrapper. EVERY operation first asserts that the target
// Facebook page belongs to the caller (via facebookAccount.userId) before
// delegating to facebook.service — an approved-but-foreign resource is a 404.
// ---------------------------------------------------------------------------

async function assertPageOwnership(userId: number, pageId: string) {
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, facebookAccount: { userId }, isActive: true },
  });
  if (!page) throw new AppError("Facebook page not found.", 404);
  return page;
}

function pageIdFromScopedId(scopedId: string): string {
  const prefix = scopedId.split("_")[0];
  if (!prefix || !scopedId.includes("_")) {
    throw new AppError("A scoped Facebook id (page_post or post_comment) is required.", 400);
  }
  return prefix;
}

export async function listCopilotFacebookPages(userId: number) {
  const pages = await prisma.facebookPage.findMany({
    where: { facebookAccount: { userId }, isActive: true },
    select: {
      pageId: true,
      pageName: true,
      businessProfileId: true,
      isActive: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  return { pages };
}

export async function listCopilotPagePosts(params: { userId: number; pageId: string }) {
  await assertPageOwnership(params.userId, params.pageId);
  const data = await getPagePosts(params.pageId);
  return { pageId: params.pageId, posts: (data as any)?.data ?? data };
}

export async function listCopilotPostComments(params: { userId: number; postId: string }) {
  const pageId = pageIdFromScopedId(params.postId);
  await assertPageOwnership(params.userId, pageId);
  const data = await getPostComments(params.postId);
  return { postId: params.postId, comments: (data as any)?.data ?? data };
}

export async function createCopilotPost(params: {
  userId: number;
  pageId: string;
  text: string;
  imageUrl?: string;
  scheduledAt?: string;
}) {
  const page = await assertPageOwnership(params.userId, params.pageId);
  const text = params.text.trim();
  if (!text) throw new AppError("text_required", 400);

  if (params.scheduledAt) {
    const when = new Date(params.scheduledAt);
    if (Number.isNaN(when.getTime())) throw new AppError("invalid_scheduledAt", 400);
    const data = await schedulePost({
      pageId: page.pageId,
      message: text,
      scheduleTime: Math.floor(when.getTime() / 1000),
    });
    return { ok: true as const, scheduled: true as const, post: (data as any)?.data ?? data };
  }

  const data = await createPost({
    pageId: page.pageId,
    message: text,
    ...(params.imageUrl ? { imageUrl: params.imageUrl } : {}),
  });
  return { ok: true as const, scheduled: false as const, post: data };
}

export async function deleteCopilotPost(params: { userId: number; postId: string }) {
  const pageId = pageIdFromScopedId(params.postId);
  await assertPageOwnership(params.userId, pageId);
  const deleted = await deleteFacebookPost(params.postId);
  if (!deleted) throw new AppError("Failed to delete the Facebook post.", 502);
  return { ok: true as const };
}

export async function replyCopilotComment(params: { userId: number; commentId: string; text: string }) {
  const pageId = pageIdFromScopedId(params.commentId);
  const page = await assertPageOwnership(params.userId, pageId);
  const text = params.text.trim();
  if (!text) throw new AppError("text_required", 400);
  const reply = await replyToComment({
    commentId: params.commentId,
    message: text,
    pageId,
    ...(page.businessProfileId ? { businessProfileId: page.businessProfileId } : {}),
  });
  return { ok: true as const, reply };
}
