import { describe, it, expect, vi, beforeEach } from "vitest";

const userServiceMocks = vi.hoisted(() => ({
  getAccessibleProfileIds: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    conversation: {
      findUnique: vi.fn(),
    },
    widgetInstall: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@modules/auth/user/user.service", () => userServiceMocks);

import prisma from "@config/prisma";
import {
  authorizeBusinessRoomJoin,
  authorizeConversationRoomJoin,
  type SocketIdentity,
} from "./socket";

const mockedPrisma = prisma as any;

describe("socket room authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a widget visitor to join only its own web conversation", async () => {
    const identity: SocketIdentity = {
      widget: {
        installId: 1,
        businessProfileId: 20,
        visitorId: "visitor-123",
      },
    };
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      businessProfileId: 20,
      channel: "web",
      pageId: "widget:1",
      senderId: "visitor-123",
    } as any);

    await expect(authorizeConversationRoomJoin(identity, 55)).resolves.toBe(true);

    mockedPrisma.conversation.findUnique.mockResolvedValue({
      businessProfileId: 20,
      channel: "web",
      pageId: "widget:1",
      senderId: "someone-else",
    } as any);

    await expect(authorizeConversationRoomJoin(identity, 55)).resolves.toBe(false);
  });

  it("does not allow widget identities to join business rooms", async () => {
    await expect(
      authorizeBusinessRoomJoin(
        {
          widget: {
            installId: 1,
            businessProfileId: 20,
            visitorId: "visitor-123",
          },
        },
        20,
      ),
    ).resolves.toBe(false);
  });

  it("allows dashboard users to join their own business profile room", async () => {
    userServiceMocks.getAccessibleProfileIds.mockResolvedValue([20]);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 10, role: "user" } }, 20),
    ).resolves.toBe(true);
    expect(userServiceMocks.getAccessibleProfileIds).toHaveBeenCalledWith(10);
  });

  it("allows managers to join assigned users' business rooms", async () => {
    userServiceMocks.getAccessibleProfileIds.mockResolvedValue([20]);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 10, role: "manager" } }, 20),
    ).resolves.toBe(true);
    expect(userServiceMocks.getAccessibleProfileIds).toHaveBeenCalledWith(10);
  });

  it("allows active workspace collaborators using the same access policy as order REST", async () => {
    userServiceMocks.getAccessibleProfileIds.mockResolvedValue([20, 21]);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 17, role: "user" } }, 20),
    ).resolves.toBe(true);
  });

  it("blocks collaborators who are not in the accessible profile set", async () => {
    userServiceMocks.getAccessibleProfileIds.mockResolvedValue([21]);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 17, role: "user" } }, 20),
    ).resolves.toBe(false);
  });

  it("preserves administrator access as defined by the shared policy", async () => {
    userServiceMocks.getAccessibleProfileIds.mockResolvedValue([20, 21, 22]);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 1, role: "admin" } }, 22),
    ).resolves.toBe(true);
  });

  it("blocks dashboard users from unrelated conversations", async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      businessProfileId: 20,
      channel: "web",
      pageId: "widget:1",
      senderId: "visitor-123",
    } as any);
    userServiceMocks.getAccessibleProfileIds.mockResolvedValue([]);

    await expect(
      authorizeConversationRoomJoin({ user: { id: 10, role: "user" } }, 55),
    ).resolves.toBe(false);
  });
});
