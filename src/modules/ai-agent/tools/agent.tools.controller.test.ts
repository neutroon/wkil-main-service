import request from "supertest";
import express from "express";
import router from "./agent.tools.controller";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/internal/agent", router);
  return app;
}

describe("agent tools controller", () => {
  it("rejects missing service token", async () => {
    const app = makeApp();
    const res = await request(app).post("/internal/agent/tools/run")
      .send({ tool: "send_message", tool_call_id: "c1", args: {} });
    expect(res.status).toBe(401);
  });
  it("accepts a valid token", async () => {
    process.env.MONOLITH_SERVICE_TOKEN = "test-token";
    const app = makeApp();
    const res = await request(app).post("/internal/agent/tools/run")
      .set("x-service-token", "test-token")
      .send({ tool: "noop", tool_call_id: "c1", args: {} });
    expect([200, 500]).toContain(res.status); // 200 if tool exists, 500 if unknown tool — either way auth passed
  });
});
