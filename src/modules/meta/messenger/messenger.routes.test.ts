import express, { type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  body: undefined as unknown,
  idempotencyKey: undefined as string | undefined,
}));

vi.mock("@modules/auth/core/auth.middleware", () => ({
  authenticateToken: (req: Request, _res: Response, next: () => void) => {
    (req as any).user = { id: 7 };
    next();
  },
}));

vi.mock("./messenger.controller", () => ({
  messengerController: {
    verifyWebhook: vi.fn(),
    handleWebhook: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    uploadAndSendMedia: vi.fn(),
    sendManualReply: (req: Request, res: Response) => {
      routeMocks.body = req.body;
      routeMocks.idempotencyKey = req.get("Idempotency-Key");
      res.status(201).json({ ok: true });
    },
  },
}));

import messengerRoutes from "./messenger.routes";
import { errorHandler } from "@middlewares/errorHandler.middleware";

describe("Messenger manual-reply route contract", () => {
  const app = express()
    .use(express.json())
    .use("/v1/messenger", messengerRoutes)
    .use(errorHandler);

  beforeEach(() => {
    routeMocks.body = undefined;
    routeMocks.idempotencyKey = undefined;
  });

  it("preserves private-comment routing through the real validation chain", async () => {
    const response = await request(app)
      .post("/v1/messenger/conversations/46/messages")
      .set("Idempotency-Key", "manual-reply-key-0001")
      .send({ message: "Private answer", isPrivate: true });

    expect(response.status).toBe(201);
    expect(routeMocks.body).toMatchObject({ message: "Private answer", isPrivate: true });
    expect(routeMocks.idempotencyKey).toBe("manual-reply-key-0001");
  });

  it("requires a client idempotency key before invoking the controller", async () => {
    const response = await request(app)
      .post("/v1/messenger/conversations/46/messages")
      .send({ message: "Private answer", isPrivate: true });

    expect(response.status).toBe(400);
    expect(routeMocks.body).toBeUndefined();
  });
});
