import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Router } from "express";
import { socialQueue } from "../../queues/social.queue";
import { metaExpressQueue, metaProductionQueue } from "../../queues/meta.queue";
import { authenticateToken, requireAdmin } from "../../middlewares/auth.middleware";

/**
 * ELITE MISSION CONTROL: Visual Dashboard for Background Jobs.
 * Uses BullBoard to provide real-time monitoring of all production queues.
 */

const serverAdapter = new ExpressAdapter();

// Initialize BullBoard with all production queues and manual management enabled
createBullBoard({
  queues: [
    new BullMQAdapter(socialQueue, { readOnlyMode: false }),
    new BullMQAdapter(metaExpressQueue, { readOnlyMode: false }),
    new BullMQAdapter(metaProductionQueue, { readOnlyMode: false }),
  ],
  serverAdapter: serverAdapter,
});

// Set the base path for the UI
serverAdapter.setBasePath("/v1/admin/mission-control");

const missionControlRouter = Router();

// Secure the Mission Control UI: Only high-level admins can access
missionControlRouter.use(authenticateToken, requireAdmin);

// Mount the BullBoard UI middleware
missionControlRouter.use("/", serverAdapter.getRouter());

export default missionControlRouter;
