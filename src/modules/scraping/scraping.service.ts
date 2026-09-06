import { internalClient } from "@utils/apiClient";
import { env } from "@config/env";
import prisma from "@config/prisma";
import {
  discoverStrategicLinks,
  extractBusinessIdentity,
} from "@modules/business/profile/ai.service";

const SCRAPING_SERVICE_URL = env.SCRAPING_SERVICE_URL || "https://scraper.wkil.app/api/scrape";

export async function analyzeWebsiteForUser(userId: number, url: string, businessProfileId?: number) {
  const profile = businessProfileId
    ? await prisma.businessProfile.findFirst({ where: { id: businessProfileId, userId }, select: { id: true } })
    : await prisma.businessProfile.findFirst({ where: { userId }, orderBy: { id: "asc" }, select: { id: true } });
  if (!profile) throw new Error("A business profile is required before website analysis");
  // 1. scrape the main page
  const homeScrapeRes = await internalClient.post(SCRAPING_SERVICE_URL, { url });
  const homeMarkdown = homeScrapeRes.data.content.markdown;

  // 2. AI choose the important links
  const strategicLinks = await discoverStrategicLinks(userId, profile.id, url, homeMarkdown);

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
    profile.id,
    finalCombinedMarkdown,
  );

  return {
    ...businessProfile,
    websiteDocument: { kind: "website", title: "Website", content: url },
  };
}
