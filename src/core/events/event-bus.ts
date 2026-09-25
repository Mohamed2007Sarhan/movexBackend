import EventEmitter from "events";
import { emitToOrder, emitToUser, emitToProvider, emitToBidding } from "../sockets/index.js";
import { sendNotification } from "../notifications/index.js";

export interface DomainEventMap {
  "order:created": { orderId: string; customerId: string; serviceType: string; price: number };
  "order:status_changed": { orderId: string; previousStatus: string; currentStatus: string; customerId: string; providerId?: string };
  "order:completed": { orderId: string; customerId: string; providerId?: string; finalPrice: number };
  "bidding:request_created": { requestId: string; customerId: string; serviceType: string; categoryName: string };
  "bidding:offer_submitted": { offerId: string; requestId: string; providerId: string; amount: number };
  "bidding:offer_accepted": { offerId: string; requestId: string; orderId: string; providerId: string; customerId: string; agreedPrice: number };
  "wallet:transaction": { walletAccountId: string; orderId?: string; amount: number; type: string };
  "provider:location_updated": { providerId: string; lat: number; lng: number };
}

class MoveXEventBus extends EventEmitter {
  public publish<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): boolean {
    return this.emit(event, payload);
  }

  public subscribe<K extends keyof DomainEventMap>(event: K, listener: (payload: DomainEventMap[K]) => void): this {
    return this.on(event, listener);
  }
}

export const eventBus = new MoveXEventBus();

// Built-in reactive subscribers for real-time decoupling
eventBus.subscribe("order:status_changed", async ({ orderId, currentStatus, customerId, providerId }) => {
  emitToOrder(orderId, "order:status_update", { orderId, currentStatus });
  
  // Realtime notification to customer
  await sendNotification({
    userId: customerId,
    title: "Order Status Update",
    body: `Your order #${orderId.slice(-6)} is now ${currentStatus.replace("_", " ")}`,
  });

  if (providerId) {
    emitToUser(providerId, "order:status_update", { orderId, currentStatus });
  }
});

eventBus.subscribe("bidding:offer_accepted", async ({ offerId, orderId, providerId, customerId, agreedPrice }) => {
  await sendNotification({
    userId: providerId,
    title: "Offer Accepted! 🎉",
    body: `Your bid of $${agreedPrice.toFixed(2)} was accepted! Order #${orderId.slice(-6)} is confirmed.`,
  });
});
