import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  knowledgeDocument: { createMany: vi.fn(), findMany: vi.fn() },
  user: { update: vi.fn() },
  workspace: { create: vi.fn() },
  workspaceMember: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

const agentClient = vi.hoisted(() => ({ ingestRag: vi.fn() }));
vi.mock("@modules/ai-agent/client/agent.client", () => ({ AgentClient: agentClient }));

vi.mock("@modules/media/services/r2Storage.service", () => ({
  uploadToR2: vi.fn(),
}));

import { createBusinessProfile } from "./business.controller";

beforeEach(() => vi.clearAllMocks());

const makeRes = () => {
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return res;
};

describe("createBusinessProfile", () => {
  it("completes the skeleton profile instead of creating a duplicate", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({ id: 7, userId: 3 });
    prismaMock.businessProfile.update.mockResolvedValue({ id: 7, name: "Nile Coffee" });
    prismaMock.knowledgeDocument.createMany.mockResolvedValue({ count: 1 });
    prismaMock.user.update.mockResolvedValue({});
    agentClient.ingestRag.mockResolvedValue({});

    const req: any = {
      body: { name: "Nile Coffee", voice: "Warm", tone: "Casual", expectedUserIntents: [] },
      user: { id: 3 },
    };
    const res = makeRes();
    await createBusinessProfile(req, res);

    expect(prismaMock.businessProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 3 }) }),
    );
    expect(prismaMock.businessProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          name: "Nile Coffee",
          setupCompletedAt: expect.any(Date),
        }),
      }),
    );
    // isBusinessProfileCreated lives on User, not BusinessProfile (schema line 132)
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 3 },
        data: expect.objectContaining({ isBusinessProfileCreated: true }),
      }),
    );
  });

  it("provisions the workspace trio when no profile exists, then completes it", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
    prismaMock.workspace.create.mockResolvedValue({ id: 11 });
    prismaMock.businessProfile.create.mockResolvedValue({ id: 12 });
    prismaMock.workspaceMember.create.mockResolvedValue({});
    prismaMock.businessProfile.update.mockResolvedValue({ id: 12 });
    prismaMock.user.update.mockResolvedValue({});
    agentClient.ingestRag.mockResolvedValue({});

    const req: any = {
      body: { name: "Fresh Biz", voice: "Warm", tone: "Casual", expectedUserIntents: [] },
      user: { id: 5 },
    };
    const res = makeRes();
    await createBusinessProfile(req, res);

    expect(prismaMock.workspace.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.businessProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 12 },
        data: expect.objectContaining({
          name: "Fresh Biz",
          setupCompletedAt: expect.any(Date),
        }),
      }),
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ isBusinessProfileCreated: true }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
