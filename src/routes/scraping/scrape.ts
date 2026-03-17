import { Router, Request, Response } from "express";
import axios from "axios";
import {
  discoverStrategicLinks,
  extractBusinessIdentity,
} from "../../services/ai.service";

const SCRAPING_SERVICE_URL =
  process.env.SCRAPING_SERVICE_URL ||
  "https://scraper.pagespilot.com/api/scrape";

const OnboardingRouter = Router();

OnboardingRouter.post(
  "/analyze-website",
  async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "الرابط مطلوب لبدء التحليل" });
    }

    try {
      // 1.scrape the main page
      const homeScrapeRes = await axios.post(SCRAPING_SERVICE_URL, { url });
      const homeMarkdown = homeScrapeRes.data.content.markdown;

      // 2. AI choose the important links
      const strategicLinks = await discoverStrategicLinks(url, homeMarkdown);

      let finalCombinedMarkdown = homeMarkdown;

      // 3. if we found links, we will do Batch Scrape
      if (strategicLinks && strategicLinks.length > 0) {
        const batchScrapeRes = await axios.post(
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
        finalCombinedMarkdown,
      );

      // 5. send the final result to the client
      res.json({
        success: true,
        data: businessProfile,
      });
    } catch (error: any) {
      console.error("Onboarding Flow Error:", error.message);
      res
        .status(500)
        .json({ error: "حدث خطأ أثناء تحليل الموقع وبناء الهوية." });
    }
  },
);

export default OnboardingRouter;
