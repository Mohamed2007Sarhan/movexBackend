import { Server as HttpServer } from "http";
import { Server as SocketIoServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { JwtPayload } from "../auth/auth.service.js";

const secret = process.env.JWT_SECRET || "dev-secret";

let io: SocketIoServer | null = null;

export interface AuthenticatedSocket extends Socket {
  user?: JwtPayload;
}

export function initSockets(httpServer: HttpServer): SocketIoServer {
  if (io) return io;

  io = new SocketIoServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Authentication middleware for Sockets
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace("Bearer ", "");
    if (!token) {
      // Allow unauthenticated connection or reject:
      // In MoveX, we attach user if token present
      return next();
    }

    try {
      const decoded = jwt.verify(token, secret) as JwtPayload;
      socket.user = decoded;
      next();
    } catch (err) {
      next();
    }
  });

  io.on("connection", (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;
    if (userId) {
      // Auto-join user personal room
      socket.join(`user:${userId}`);
      socket.join(`provider:${userId}:incoming-jobs`);
    }

    // Dynamic room join/leave events
    socket.on("join:order", (orderId: string) => {
      socket.join(`order:${orderId}`);
    });

    socket.on("leave:order", (orderId: string) => {
      socket.leave(`order:${orderId}`);
    });

    socket.on("join:bidding", (requestId: string) => {
      socket.join(`bidding:${requestId}`);
    });

    socket.on("leave:bidding", (requestId: string) => {
      socket.leave(`bidding:${requestId}`);
    });

    socket.on("join:room", (roomName: string) => {
      socket.join(roomName);
    });

    socket.on("location:update", async (data: { lat: number; lng: number; speed?: number; heading?: number }) => {
      if (socket.user?.id && typeof data?.lat === "number" && typeof data?.lng === "number") {
        const { updateProviderLocation } = await import("../proximity/proximity.service.js");
        await updateProviderLocation(socket.user.id, data.lat, data.lng);
      }
    });

    socket.on("disconnect", () => {
      // Cleaned up automatically by Socket.io
    });
  });

  console.log("[Sockets] Unified MoveX Socket.io server initialized");
  return io;
}

export function getIo(): SocketIoServer {
  if (!io) {
    throw new Error("Socket.io has not been initialized. Call initSockets() first.");
  }
  return io;
}

export function emitToOrder(orderId: string, event: string, data: any) {
  if (io) {
    io.to(`order:${orderId}`).emit(event, data);
  }
}

export function emitToUser(userId: string, event: string, data: any) {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
}

export function emitToProvider(providerId: string, event: string, data: any) {
  if (io) {
    io.to(`provider:${providerId}:incoming-jobs`).emit(event, data);
  }
}

export function emitToBidding(requestId: string, event: string, data: any) {
  if (io) {
    io.to(`bidding:${requestId}`).emit(event, data);
  }
}

export function emitToRoom(room: string, event: string, data: any) {
  if (io) {
    io.to(room).emit(event, data);
  }
}
