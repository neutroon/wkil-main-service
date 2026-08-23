import { Router, Request, Response } from "express";
import { internalClient } from "@utils/apiClient";
import {
  discoverStrategicLinks,
  extractBusinessIdentity,
} from "@modules/business/profile/ai.service";
import { validate } from "@middlewares/validate.middleware";
import { websiteAnalysisSchema } from "../scraping/scraping.validation";
import { analyzeWebsiteForUser } from "./scraping.service";

import { env } from "@config/env";

const SCRAPING_SERVICE_URL = env.SCRAPING_SERVICE_URL || "https://scraper.wkil.app/api/scrape";

const OnboardingRouter = Router();

OnboardingRouter.post(
  "/analyze-website",
  validate(websiteAnalysisSchema),
  async (req: Request, res: Response) => {
    const { url } = req.body;
    const result = await analyzeWebsiteForUser((req as any).user.id, url);
    res.status(200).json({ data: result });
  }
);

export default OnboardingRouter;





