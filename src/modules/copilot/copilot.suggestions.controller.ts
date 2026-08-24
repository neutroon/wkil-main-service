import { Request, Response } from "express";
import { getCopilotSuggestions, isUx2Enabled } from "./copilot.suggestions.service";
import { detectLocale } from "./copilot.controller";

export const getSuggestionsController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const locale = (req.query.locale as "ar" | "en") ?? detectLocale(req);
  const conversationKind = ((req.query.conversationKind as string) === "ONBOARDING" ? "ONBOARDING" : "GENERAL") as "ONBOARDING" | "GENERAL";
  const hour = Number(req.query.hour ?? new Date().getHours());
  const recentTitlesRaw = (req.query.recentTitles as string | undefined) ?? "";
  const recentTitles = recentTitlesRaw ? recentTitlesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const out = await getCopilotSuggestions({ userId, locale, conversationKind, hour, recentTitles });
  res.status(200).json({ data: out });
};

export const getUx2FlagController = async (_req: Request, res: Response) => {
  res.status(200).json({ data: { enabled: isUx2Enabled() } });
};
