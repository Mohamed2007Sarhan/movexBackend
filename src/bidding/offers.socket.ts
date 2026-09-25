import { Socket } from "socket.io";
import { getIo } from "../core/sockets/index.js";

/**
 * Realtime bidding negotiation room setup
 */
export function registerBiddingSocketHandlers(socket: Socket) {
  // Join negotiation room for a specific request
  socket.on("bidding:join_request", (requestId: string) => {
    socket.join(`bidding:${requestId}`);
  });

  socket.on("bidding:leave_request", (requestId: string) => {
    socket.leave(`bidding:${requestId}`);
  });

  // Client heartbeat in room
  socket.on("bidding:typing_offer", ({ requestId, providerName }: { requestId: string; providerName: string }) => {
    socket.to(`bidding:${requestId}`).emit("bidding:provider_typing", { providerName });
  });
}
