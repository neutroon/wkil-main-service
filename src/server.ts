import "dotenv/config";
import { createServer } from "http";
import app from "./app";
import { initSocket } from "./utils/socket";

import { 
  startMetaQueue, 
  expressWorker, 
  productionWorker 
} from "./queues/meta.queue";
import { startMediaRefreshJob } from "./jobs/mediaRefresh.job";
import { socialWorker } from "./workers/social.worker"; // Initialize BullMQ Worker
import { logger } from "./utils/logger";
import prisma from "./config/prisma";

const PORT = Number(process.env.PORT) || 8080;

const httpServer = createServer(app);
initSocket(httpServer);

const server = httpServer.listen(PORT, "0.0.0.0", async () => {
  logger.info(`Server running on port ${PORT}`);
  
  // Start the background queue loop for delayed/scheduled jobs
  startMetaQueue();
  // Daily WhatsApp media ID refresh (expires after 30 days)
  startMediaRefreshJob();
});

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutdown signal received. Starting graceful shutdown...");
  
  server.close(async () => {
    logger.info("HTTP server closed.");
    
    try {
      await prisma.$disconnect();
      logger.info("Database connection closed.");
      process.exit(0);
    } catch (err) {
      logger.error("Error during database disconnection:", { error: err });
      process.exit(1);
    }
  });

  // Force close after 10s
  setTimeout(() => {
    logger.error("Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Handle unhandled rejections and uncaught exceptions
process.on("unhandledRejection", (err: any) => {
  logger.error("UNHANDLED REJECTION! 💥 Shutting down...", {
    error: err.message,
    stack: err.stack,
  });
  shutdown();
});

process.on("uncaughtException", (err: any) => {
  logger.error("UNCAUGHT EXCEPTION! 💥 Shutting down...", {
    error: err.message,
    stack: err.stack,
  });
  shutdown();
});
