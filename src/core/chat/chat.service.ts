import { db } from "../../db.js";
import { emitToOrder } from "../sockets/socket.service.js";

export interface SendChatMessageParams {
  orderId: string;
  senderId: string;
  body: string;
}

export async function sendMessage(params: SendChatMessageParams) {
  const message = await db.chatMessage.create({
    data: {
      orderId: params.orderId,
      senderId: params.senderId,
      body: params.body,
    },
    include: {
      sender: {
        select: { id: true, name: true, role: true },
      },
    },
  });

  emitToOrder(params.orderId, "chat:message", message);
  return message;
}

export async function getOrderMessages(orderId: string) {
  return db.chatMessage.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    include: {
      sender: {
        select: { id: true, name: true, role: true },
      },
    },
  });
}
