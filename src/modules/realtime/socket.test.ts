import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    businessProfile: {
      findUnique: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
    userManagement: {
      findFirst: vi.fn(),
    },
    widgetInstall: {
      findFirst: vi.fn(),
    },
  },
}));

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
    mockedPrisma.businessProfile.findUnique.mockResolvedValue({
      userId: 10,
    } as any);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 10, role: "user" } }, 20),
    ).resolves.toBe(true);
  });

  it("allows managers to join assigned users' business rooms", async () => {
    mockedPrisma.businessProfile.findUnique.mockResolvedValue({
      userId: 15,
    } as any);
    mockedPrisma.userManagement.findFirst.mockResolvedValue({ id: 7 } as any);

    await expect(
      authorizeBusinessRoomJoin({ user: { id: 10, role: "manager" } }, 20),
    ).resolves.toBe(true);
  });

  it("blocks dashboard users from unrelated conversations", async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      businessProfileId: 20,
      channel: "web",
      pageId: "widget:1",
      senderId: "visitor-123",
    } as any);
    mockedPrisma.businessProfile.findUnique.mockResolvedValue({
      userId: 99,
    } as any);
    mockedPrisma.userManagement.findFirst.mockResolvedValue(null);

    await expect(
      authorizeConversationRoomJoin({ user: { id: 10, role: "user" } }, 55),
    ).resolves.toBe(false);
  });
});
