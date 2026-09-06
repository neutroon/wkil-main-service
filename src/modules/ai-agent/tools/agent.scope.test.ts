import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const member = vi.hoisted(() => vi.fn(async () => ({ workspaceId: 11, role: "owner" })));
const conversation = vi.hoisted(() => vi.fn(async ({ where }) => where.id === 1 && where.businessProfileId === 5 ? { id: 1 } : null));
vi.mock("@modules/workspace/workspace.service", () => ({ requireWorkspaceProfileAccess: member }));
vi.mock("@config/prisma", () => ({ default: { conversation: { findFirst: conversation } } }));
import { authorizeAgentScope } from "./agent.scope";

function app() {
  const server = express(); server.use(express.json()); server.use(authorizeAgentScope);
  server.all("/conversations/:id/messages", (_req, res) => res.json({ ok: true }));
  server.get("/customers", (req, res) => res.json(req.query));
  server.post("/onboarding/analyze", (_req, res) => res.json({ ok: true }));
  server.post("/onboarding/apply", (_req, res) => res.json({ ok: true }));
  server.post("/tools/run", (_req, res) => res.json({ ok: true }));
  return server;
}
describe("active business authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    member.mockResolvedValue({ workspaceId: 11, role: "owner" });
  });
  it("denies an otherwise accessible resource in another business", async () => {
    const res = await request(app()).get("/conversations/2/messages?userId=3&businessProfileId=5");
    expect(res.status).toBe(404);
    expect(conversation).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 2, businessProfileId: 5 } }));
  });
  it("allows the selected business resource", async () => {
    expect((await request(app()).get("/conversations/1/messages?userId=3&businessProfileId=5")).status).toBe(200);
  });
  it.each(["2e0", "0x2", "%202%20"])("does not skip ownership for alternate numeric syntax %s", async (id) => {
    expect((await request(app()).get(`/conversations/${id}/messages?userId=3&businessProfileId=5`)).status).toBe(404);
  });
  it("fails closed when the caller omits business scope", async () => {
    expect((await request(app()).get("/customers?userId=3")).status).toBe(403);
  });
  it("revalidates active membership before writes", async () => {
    member.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    expect((await request(app()).post("/conversations/1/messages").send({ userId: 3, businessProfileId: 5 })).status).toBe(403);
  });

  it("allows profile-less onboarding with a trusted user identity", async () => {
    expect((await request(app()).post("/onboarding/analyze").send({ userId: 3 })).status).toBe(200);
    expect(member).not.toHaveBeenCalled();
  });

  it("still authorizes an existing profile when onboarding supplies one", async () => {
    expect((await request(app()).post("/onboarding/apply").send({ userId: 3, businessProfileId: 5 })).status).toBe(200);
    expect(member).toHaveBeenCalledWith(3, 5, { manage: true });
  });

  it("authorizes the legacy tools contract when business scope is nested in args", async () => {
    expect((await request(app()).post("/tools/run").send({ userId: 3, args: { businessProfileId: 5 } })).status).toBe(200);
    expect(member).toHaveBeenCalledWith(3, 5, { manage: true });
  });
});
