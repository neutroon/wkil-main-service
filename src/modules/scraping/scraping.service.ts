import { internalClient } from "@utils/apiClient";
import { env } from "@config/env";
import {
  discoverStrategicLinks,
  extractBusinessIdentity,
} from "@modules/business/profile/ai.service";

const SCRAPING_SERVICE_URL = env.SCRAPING_SERVICE_URL || "https://scraper.wkil.app/api/scrape";

export async function analyzeWebsiteForUser(userId: number, url: string) {
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

  return {
    ...businessProfile,
    websiteDocument: { kind: "website", title: "Website", content: url },
  };
}
