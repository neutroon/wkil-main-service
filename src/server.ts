import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

// Initialize Sentry before anything else
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    nodeProfilingIntegration(),
    Sentry.prismaIntegration(),
  ],
  // Performance Monitoring
  tracesSampleRate: 1.0, 
  // Set sampling rate for profiling
  profilesSampleRate: 1.0,
});

import { env } from "@config/env";
import { createServer } from "http";
import app from "./app";
import { initSocket } from "@modules/realtime/socket";

import { 
  startMetaQueue, 
  expressWorker, 
  productionWorker 
} from "@modules/meta/core/meta.queue";
import { startMediaRefreshJob } from "@modules/media/mediaRefresh.job";
import { socialWorker } from "@modules/content/social.worker"; 
import { startBillingQueue, billingWorker } from "@modules/billing/billing.queue";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import { startCacheBusSubscriber, stopCacheBusSubscriber } from "@config/cache-bus";

const { PORT } = env;

const httpServer = createServer(app);
initSocket(httpServer);

// `server` is captured by the IIFE below and by gracefulShutdown. Declared
// here so the shutdown handler can call server.close().
let server: ReturnType<typeof httpServer.listen> | undefined;

// Start the cross-instance cache-invalidation subscriber BEFORE accepting
// traffic — otherwise the first admin write after boot would miss its peers.
// Best-effort: if Redis is unreachable, the subscriber no-ops and caches
// expire on their TTL. Chained off an async IIFE so the listener only opens
// after SUBSCRIBE (tsconfig is CommonJS, so no top-level await).
void (async () => {
  await startCacheBusSubscriber();
  server = httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on port ${PORT}`);

    // Start the background queue loop for delayed/scheduled jobs
    startMetaQueue();
    startBillingQueue();
    // Daily WhatsApp media ID refresh (expires after 30 days)
    startMediaRefreshJob();
  });
})();

// Graceful shutdown engine
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting professional graceful shutdown...`);

  // 1. Force exit fallback (Safety Net)
  const forceExitTimeout = setTimeout(() => {
    logger.error("SHUTDOWN TIMEOUT: Forcefully terminating process.");
    process.exit(1);
  }, 15000);

  try {
    // 2. Stop accepting new HTTP/Socket requests
    if (server) {
      server.close(() => {
        logger.info("HTTP & Socket.io server closed.");
      });
    }

    // 3. Gracefully close BullMQ Workers to prevent job corruption
    const workers = [expressWorker, productionWorker, socialWorker, billingWorker];
    for (const worker of workers) {
      if (worker && typeof worker.close === "function") {
        await worker.close();
        logger.info(`Worker ${worker.name || "unnamed"} closed.`);
      }
    }

    // 4. Final Disconnect: Database
    await prisma.$disconnect();
    logger.info("Database connection closed cleanly.");

    // 5. Stop the cross-instance cache-invalidation subscriber (closes the
    //    dedicated Redis pub/sub connection so the process can exit cleanly).
    await stopCacheBusSubscriber();

    clearTimeout(forceExitTimeout);
    logger.info("--- Graceful Shutdown Complete ---");
    process.exit(0);
  } catch (err: any) {
    logger.error("CRITICAL SHUTDOWN FAILURE:", { error: err.message });
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (err: any) => {
  logger.error("UNHANDLED REJECTION! 💥", {
    error: err?.message,
    stack: err?.stack,
  });
});

process.on("uncaughtException", (err: any) => {
  logger.error("UNCAUGHT EXCEPTION! 💥", {
    error: err?.message,
    stack: err?.stack,
  });
});




