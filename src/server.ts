import { createServer } from "http";
import app from "./app";
import dotenv from "dotenv";
import { initSocket } from "./utils/socket";

import { bootstrapMetaQueue } from "./queues/meta.queue";
import { startMediaRefreshJob } from "./jobs/mediaRefresh.job";

dotenv.config();

const PORT = Number(process.env.PORT) || 8080;

const httpServer = createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  
  // High-Resilience Recovery: Pick up where we left off
  void bootstrapMetaQueue();
  // Daily WhatsApp media ID refresh (expires after 30 days)
  startMediaRefreshJob();
});
