import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";

export async function executeExternalQuery(
  sourceId: number,
  args: Record<string, any>
): Promise<any> {
  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId },
  });

  if (!source) {
    throw new Error(`Data source with id ${sourceId} not found`);
  }

  try {
    let finalUrl = source.apiUrl;
    let options: RequestInit = {
      method: source.method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (source.headers) {
      options.headers = { ...options.headers, ...(source.headers as Record<string, string>) };
    }

    if (source.method === "GET") {
      const url = new URL(source.apiUrl);
      const allParams = { ...(source.queryParams as object || {}), ...args };
      for (const [key, val] of Object.entries(allParams)) {
        if (val !== undefined && val !== null) {
          url.searchParams.append(key, String(val));
        }
      }
      finalUrl = url.toString();
    } else {
      options.body = JSON.stringify({ ...(source.queryParams as object || {}), ...args });
    }

    // Set a strict timeout so AI doesn't hang forever. Better scalability setup.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 seconds limit
    options.signal = controller.signal;

    const response = await fetch(finalUrl, options);
    clearTimeout(timeoutId);

    if (!response.ok) {
        logger.warn("external_api_failed", { url: finalUrl, status: response.status });
        return { error: `External API returned status ${response.status}`, success: false };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    logger.error("external_api_error", { errorMessage: String(error) });
    return { error: String(error), success: false };
  }
}
