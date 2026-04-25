import { Router, Request, Response } from "express";
import { internalClient } from "../../utils/apiClient";
import {
  discoverStrategicLinks,
  extractBusinessIdentity,
} from "../../services/ai.service";
import { validate } from "../../middlewares/validate.middleware";
import { websiteAnalysisSchema } from "../../validations/scraping.validation";

import { env } from "../../config/env";

const SCRAPING_SERVICE_URL = env.SCRAPING_SERVICE_URL || "https://scraper.pagespilot.com/api/scrape";

const OnboardingRouter = Router();

OnboardingRouter.post(
  "/analyze-website",
  validate(websiteAnalysisSchema),
  async (req: Request, res: Response) => {
    const { url } = req.body;
    const userId = (req as any).user.id;

    // 1. scrape the main page
    const homeScrapeRes = await internalClient.post(SCRAPING_SERVICE_URL, { url });
    const homeMarkdown = homeScrapeRes.data.content.markdown;

    // 2. AI choose the important links
    const strategicLinks = await discoverStrategicLinks(userId, null, url, homeMarkdown);

    let finalCombinedMarkdown = homeMarkdown;

    // 3. if we found links, we will do Batch Scrape
    if (strategicLinks && strategicLinks.length > 0) {
      const batchScrapeRes = await internalClient.post(
        `${SCRAPING_SERVICE_URL}/batch`,
        { urls: strategicLinks },
      );

      // merge the secondary pages markdown with the main page
      const secondaryPagesMarkdown = batchScrapeRes.data.results
        .map((result: any) => result.content.markdown)
        .join("\n\n--- صفحة جديدة ---\n\n");
      finalCombinedMarkdown += `\n\n${secondaryPagesMarkdown}`;
    }

    // 4. AI extract the final business identity
    const businessProfile = await extractBusinessIdentity(
      userId,
      null,
      finalCombinedMarkdown,
    );

    // 5. send the final result to the client
    return res.json({
      success: true,
      data: businessProfile,
    });
  }
);

export default OnboardingRouter;
