import { env } from "@config/env";
import prisma from "@config/prisma";
import jwt from "jsonwebtoken";
import { Server as SocketIOServer, Socket } from "socket.io";
import { Server as HTTPServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

let io: SocketIOServer | null = null;

type SocketUser = {
  id: number;
  role: string;
};

export type SocketIdentity = {
  user?: SocketUser;
  widget?: {
    installId: number;
    businessProfileId: number;
    visitorId: string;
  };
};

type AppSocket = Socket & {
  data: {
    identity?: SocketIdentity;
  };
};

function parseCookies(cookieHeader: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader || "";
  return raw.split(";").reduce<Record<string, string>>((acc, part) => {
    const index = part.indexOf("=");
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function stringFromHandshakeValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseAllowedOrigins(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function isLocalOrigin(origin: string | undefined): boolean {
  return Boolean(origin && (origin.includes("localhost") || origin.includes("127.0.0.1")));
}

function normalizeOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function isDashboardOriginAllowed(origin: string | undefined): boolean {
  if (isLocalOrigin(origin)) return true;
  if (!origin) return env.NODE_ENV !== "production";

  const normalizedOrigin = normalizeOrigin(origin);
  const allowedOrigins = new Set(
    [
      env.FRONTEND_URL,
      "https://wkil.app",
      "https://www.wkil.app",
      "https://go.wkil.app",
      "https://app.wkil.app",
      "https://wkil.vercel.app",
      "https://wkil.netlify.app",
    ].map(normalizeOrigin),
  );

  return (
    allowedOrigins.has(normalizedOrigin) ||
    normalizedOrigin.endsWith(".wkil.app") ||
    normalizedOrigin.endsWith(".vercel.app")
  );
}

function isWidgetOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (allowedOrigins.includes("*")) return true;
  if (isLocalOrigin(origin)) return true;
  if (!origin) return env.NODE_ENV !== "production";
  return allowedOrigins.includes(origin);
}

async function authenticateDashboardSocket(socket: Socket): Promise<SocketUser | null> {
  const origin = stringFromHandshakeValue(socket.handshake.headers.origin);
  if (!isDashboardOriginAllowed(origin)) return null;

  const authToken = stringFromHandshakeValue(socket.handshake.auth?.token);
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const token = authToken || cookies.accessToken;
  if (!token || token === "undefined" || token === "null") return null;

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { id?: unknown };
    const userId = parsePositiveInt(decoded.id);
    if (!userId) return null;

    const user = await prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, role: true },
    });

    return user ? { id: user.id, role: user.role } : null;
  } catch {
    return null;
  }
}

async function authenticateWidgetSocket(socket: Socket): Promise<SocketIdentity["widget"] | null> {
  const siteKey =
    stringFromHandshakeValue(socket.handshake.auth?.siteKey) ||
    stringFromHandshakeValue(socket.handshake.query?.siteKey);
  const visitorId =
    stringFromHandshakeValue(socket.handshake.auth?.visitorId) ||
    stringFromHandshakeValue(socket.handshake.query?.visitorId);

  if (!siteKey || visitorId.length < 8 || visitorId.length > 128) return null;

  const install = await prisma.widgetInstall.findFirst({
    where: { publicSiteKey: siteKey, isActive: true },
    select: {
      id: true,
      businessProfileId: true,
      allowedOrigins: true,
    },
  });
  if (!install) return null;

  const origin = stringFromHandshakeValue(socket.handshake.headers.origin);
  if (!isWidgetOriginAllowed(origin, parseAllowedOrigins(install.allowedOrigins))) {
    return null;
  }

  return {
    installId: install.id,
    businessProfileId: install.businessProfileId,
    visitorId,
  };
}

async function resolveSocketIdentity(socket: Socket): Promise<SocketIdentity | null> {
  const [user, widget] = await Promise.all([
    authenticateDashboardSocket(socket),
    authenticateWidgetSocket(socket),
  ]);

  if (!user && !widget) return null;
  return { ...(user ? { user } : {}), ...(widget ? { widget } : {}) };
}

export async function canAccessBusinessProfile(
  identity: SocketIdentity | undefined,
  businessProfileId: number,
): Promise<boolean> {
  const user = identity?.user;
  if (!user) return false;
  if (["super_admin", "admin"].includes(user.role)) return true;

  const profile = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { userId: true },
  });
  if (!profile) return false;
  if (profile.userId === user.id) return true;

  if (user.role !== "manager") return false;
  const assignment = await prisma.userManagement.findFirst({
    where: {
      managerId: user.id,
      userId: profile.userId,
      isActive: true,
      manager: { role: "manager" },
      user: { role: "user" },
    },
    select: { id: true },
  });

  return Boolean(assignment);
}

export async function authorizeBusinessRoomJoin(
  identity: SocketIdentity | undefined,
  businessProfileId: number,
): Promise<boolean> {
  if (!parsePositiveInt(businessProfileId)) return false;
  return canAccessBusinessProfile(identity, businessProfileId);
}

export async function authorizeConversationRoomJoin(
  identity: SocketIdentity | undefined,
  conversationId: number,
): Promise<boolean> {
  if (!parsePositiveInt(conversationId)) return false;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      businessProfileId: true,
      channel: true,
      pageId: true,
      senderId: true,
    },
  });
  if (!conversation) return false;

  if (identity?.widget) {
    return (
      conversation.channel === "web" &&
      conversation.businessProfileId === identity.widget.businessProfileId &&
      conversation.pageId === `widget:${identity.widget.installId}` &&
      conversation.senderId === identity.widget.visitorId
    );
  }

  return canAccessBusinessProfile(identity, conversation.businessProfileId);
}

export function initSocket(server: HTTPServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: {
      origin: (_origin, callback) => callback(null, true),
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  // PRODUCTION-GRADE: Multi-Instance Synchronization via Redis
  const redisUrl = env.REDIS_URL;
  if (redisUrl) {
    try {
      const pubClient = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const subClient = pubClient.duplicate();
      
      io.adapter(createAdapter(pubClient, subClient));
      logger.info("socket.redis_adapter_ready", { url: redisUrl.split("@")[1] });
    } catch (err: any) {
      logger.error("socket.redis_adapter_failed", { error: err.message });
    }
  }

  io.use((socket, next) => {
    resolveSocketIdentity(socket)
      .then((identity) => {
        if (!identity) {
          next(new Error("Unauthorized socket"));
          return;
        }
        (socket as AppSocket).data.identity = identity;
        next();
      })
      .catch(next);
  });

  io.on("connection", (socket: AppSocket) => {
    logger.info("socket.connected", { id: socket.id });

    socket.on("join_conversation", async (conversationId: string | number) => {
      const id = parsePositiveInt(conversationId);
      if (!id || !(await authorizeConversationRoomJoin(socket.data.identity, id))) {
        logger.warn("socket.join_conversation_denied", {
          socketId: socket.id,
          conversationId,
        });
        return;
      }
      const room = `conversation:${id}`;
      socket.join(room);
      logger.info("socket.join_room", { socketId: socket.id, room });
    });

    socket.on("leave_conversation", (conversationId: string | number) => {
      const id = parsePositiveInt(conversationId);
      if (!id) return;
      const room = `conversation:${id}`;
      socket.leave(room);
      logger.info("socket.leave_room", { socketId: socket.id, room });
    });

    socket.on("join_business", async (businessProfileId: string | number) => {
      const id = parsePositiveInt(businessProfileId);
      if (!id || !(await authorizeBusinessRoomJoin(socket.data.identity, id))) {
        logger.warn("socket.join_business_denied", {
          socketId: socket.id,
          businessProfileId,
        });
        return;
      }
      const room = `business:${id}`;
      socket.join(room);
      logger.info("socket.join_room", { socketId: socket.id, room });
    });

    socket.on("disconnect", (reason) => {
      logger.info("socket.disconnected", { id: socket.id, reason });
    });
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new AppError("Socket.io has not been initialized. Call initSocket(server) first.", 500);
  }
  return io;
}

/**
 * Utility to emit a message to a specific conversation room.
 * This will notify the visitor (web widget).
 */
export function emitToConversation(conversationId: number, event: string, data: any) {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit(event, data);
}

/**
 * Utility to emit a message to a specific business room.
 * This will notify the dashboard admin.
 */
export function emitToBusiness(businessProfileId: number, event: string, data: any) {
  if (!io) return;
  io.to(`business:${businessProfileId}`).emit(event, data);
}


