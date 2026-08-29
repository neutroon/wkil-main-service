import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import shellRoutes from "./shell.routes";

describe("shell routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/v1/shell", shellRoutes);

  it("GET /chat-first returns enabled boolean", async () => {
    const res = await request(app).get("/v1/shell/chat-first");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("enabled");
    expect(typeof res.body.data.enabled).toBe("boolean");
  });
});
