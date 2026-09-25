import { NotificationChannel } from "@prisma/client";
import { db } from "../../db.js";
import { emitToUser } from "../sockets/socket.service.js";

export interface SendNotificationOptions {
  userId: string;
  title: string;
  body: string;
  channel?: NotificationChannel;
}

export interface NotificationProvider {
  name: string;
  send(userId: string, title: string, body: string): Promise<boolean>;
}

class ConsoleNotificationProvider implements NotificationProvider {
  name = "console";
  async send(userId: string, title: string, body: string): Promise<boolean> {
    console.log(`[Notification][${this.name}] To User ${userId} -> "${title}": ${body}`);
    return true;
  }
}

const defaultProvider: NotificationProvider = new ConsoleNotificationProvider();

/**
 * Dispatches notification across designated channel and persists in database.
 */
export async function sendNotification(options: SendNotificationOptions) {
  const channel = options.channel || NotificationChannel.push;

  // 1. Send via provider
  await defaultProvider.send(options.userId, options.title, options.body);

  // 2. Persist in database
  const notification = await db.notification.create({
    data: {
      userId: options.userId,
      title: options.title,
      body: options.body,
      channel,
      status: "sent",
    },
  });

  // 3. Emit realtime socket notification to user's room
  emitToUser(options.userId, "notification:new", notification);

  return notification;
}
