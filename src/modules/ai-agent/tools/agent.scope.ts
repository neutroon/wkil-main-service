import type { RequestHandler } from "express";
import prisma from "@config/prisma";
import { requireWorkspaceProfileAccess } from "@modules/workspace/workspace.service";

// All resource checks include the active business, even when the same actor
// belongs to multiple workspaces. Run this before claiming a durable effect.
export const authorizeAgentScope: RequestHandler = async (req, res, next) => {
  const input = req.method === "GET" ? req.query : req.body;
  const userId = Number(input?.userId);
  // The legacy /tools/run contract nests the scope in `args`; normalize it at
  // the guard boundary so it receives the same tenant checks as copilot APIs.
  const requestedBusinessProfileId = input?.businessProfileId ?? input?.args?.businessProfileId;
  const businessProfileId = Number(requestedBusinessProfileId);
  const route = req.path.split("/").filter(Boolean);
  // Onboarding starts before a business profile is selected. It still carries
  // a trusted user identity (injected by agent-svc), and the domain service
  // resolves or creates the user's own pending profile. Every other copilot
  // operation must name an active business explicitly.
  const profilelessOnboarding = route[0] === "onboarding" &&
    (route[1] === "analyze" || route[1] === "apply");
  if (!Number.isSafeInteger(userId) || userId <= 0 ||
      (!profilelessOnboarding && (!Number.isSafeInteger(businessProfileId) || businessProfileId <= 0)) ||
    (profilelessOnboarding && requestedBusinessProfileId != null &&
       (!Number.isSafeInteger(businessProfileId) || businessProfileId <= 0))) {
    res.status(403).json({ error: "user_and_business_scope_required" }); return;
  }
  try {
    if (Number.isSafeInteger(businessProfileId) && businessProfileId > 0) {
      await requireWorkspaceProfileAccess(userId, businessProfileId, { manage: req.method !== "GET" });
    }
    const check = async (model: string, value: unknown, field = "id", relation = false) => {
      if (value == null) return;
      const id = field === "id" ? Number(value) : String(value);
      // Resource identifiers are intentionally indistinguishable from a
      // missing record. Returning 404 for malformed/alternate numeric forms
      // avoids turning this guard into an ownership oracle.
      if (field === "id" && (!Number.isSafeInteger(id) || Number(id) <= 0)) throw Object.assign(new Error("resource_not_in_active_business"), { statusCode: 404 });
      const where = { [field]: id, ...(relation ? { contentPlan: { businessProfileId } } : { businessProfileId }) };
      const delegate = prisma[model as keyof typeof prisma] as unknown as { findFirst(args: unknown): Promise<unknown> };
      if (!await delegate.findFirst({ where, select: { id: true } })) throw Object.assign(new Error("resource_not_in_active_business"), { statusCode: 404 });
    };
    const parts = route;
    const pathModels: Record<string, string> = {
      conversations: "conversation", customers: "customer", knowledge: "knowledgeDocument", media: "businessProfileMedia",
    };
    if (pathModels[parts[0]] && parts[1] && !(parts[0] === "media" && parts[1] === "ai")) await check(pathModels[parts[0]], parts[1]);
    if (parts[0] === "customer") await check("customer", input.customerId);
    if (parts[0] === "content" && parts[2] && parts[2] !== "generate") await check(parts[1] === "plans" ? "contentPlan" : "contentPlanPost", parts[2], "id", parts[1] === "posts");
    if (parts[0] === "orders") {
      const models: Record<string, string> = { "by-id": "order", integrations: "orderIntegration", "template-configs": "orderTemplateConfig", suppressions: "whatsAppSuppression", notifications: "orderNotification", sync: "orderStoreSync" };
      if (models[parts[1]] && parts[2]) await check(models[parts[1]], parts[2]);
      await check("orderIntegration", input.integrationId);
      await check("whatsAppAccount", input.whatsappAccountId);
    }
    if (parts[0] === "social") {
      if (parts[1] === "pages" && parts[2]) await check("facebookPage", parts[2], "pageId");
      if (["posts", "comments"].includes(parts[1]) && parts[2]) await check("facebookPage", parts[2].split("_")[0], "pageId");
      await check("facebookPage", input.pageId, "pageId");
    }
    if (parts[0] === "media" && parts[1] === "ai") {
      await check("businessProfileMedia", input.assetId);
      await check("contentPlanPost", input.postId, "id", true);
    }
    if (parts[0] === "channels") {
      // Linking an unassigned channel is separately authorized by the domain
      // service; existing assignments may only be managed in this business.
      if (parts[1] === "whatsapp" && parts[2] && input.action !== "link") await check("whatsAppAccount", parts[2]);
      if (parts[1] === "facebook" && parts[2] && input.action !== "link") await check("facebookPage", parts[2], "pageId");
      if (parts[1] === "widgets") await check("widgetInstall", input.installId);
    }
    next();
  } catch (error: any) {
    res.status(error?.statusCode ?? 403).json({ error: error?.message ?? "scope_denied" });
  }
};
