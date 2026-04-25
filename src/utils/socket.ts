import { env } from "../config/env";
import { Server as SocketIOServer } from "socket.io";
import { Server as HTTPServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { logger } from "./logger";
import { AppError } from "../middlewares/errorHandler.middleware";

let io: SocketIOServer | null = null;

export function initSocket(server: HTTPServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: {
      origin: "*", 
      methods: ["GET", "POST"]
    }
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
      logger.info("socket.redis_adapter_ready", { url: redisUrl.split("@")[1] }); // Log host only for security
    } catch (err: any) {
      logger.error("socket.redis_adapter_failed", { error: err.message });
    }
  }

  io.on("connection", (socket) => {
    logger.info("socket.connected", { id: socket.id });

    // Join room for a specific conversation
    socket.on("join_conversation", (conversationId: string | number) => {
      const room = `conversation:${conversationId}`;
      socket.join(room);
      logger.info("socket.join_room", { socketId: socket.id, room });
    });

    // Leave room for a specific conversation
    socket.on("leave_conversation", (conversationId: string | number) => {
      const room = `conversation:${conversationId}`;
      socket.leave(room);
      logger.info("socket.leave_room", { socketId: socket.id, room });
    });

    // Join room for a business admin
    socket.on("join_business", (businessProfileId: string | number) => {
      const room = `business:${businessProfileId}`;
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
