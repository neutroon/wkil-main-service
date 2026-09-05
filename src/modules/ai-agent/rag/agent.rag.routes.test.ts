import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  beginRagRefresh: vi.fn(),
  commitRagRefresh: vi.fn(),
  getActiveRagRevision: vi.fn(),
}));
vi.mock("./agent.rag.service", () => service);

import agentRagRoutes from "./agent.rag.routes";

const app = express();
app.use(express.json());
app.use("/internal/agent/rag", agentRagRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONOLITH_SERVICE_TOKEN = "test-service-token";
});

describe("agent RAG internal routes", () => {
  it("rejects requests without the backend service token", async () => {
    const response = await request(app).post("/internal/agent/rag/3/revisions");
    expect(response.status).toBe(401);
    expect(service.beginRagRefresh).not.toHaveBeenCalled();
  });

  it("returns the canonical reserved snapshot", async () => {
    service.beginRagRefresh.mockResolvedValue({ revision: 2, documents: [] });
    const response = await request(app)
      .post("/internal/agent/rag/3/revisions")
      .set("x-service-token", "test-service-token");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ revision: 2, documents: [] });
    expect(service.beginRagRefresh).toHaveBeenCalledWith(3);
  });

  it("rejects malformed profile and revision identifiers", async () => {
    const response = await request(app)
      .post("/internal/agent/rag/3/revisions/old/commit")
      .set("x-service-token", "test-service-token");
    expect(response.status).toBe(400);
    expect(service.commitRagRefresh).not.toHaveBeenCalled();
  });
});
