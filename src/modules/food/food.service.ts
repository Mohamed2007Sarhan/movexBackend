import { ServiceType, OrderStatus } from "@prisma/client";
import { db } from "../../db.js";
import { createOrder, assignProvider } from "../../core/order-engine/index.js";

export interface CartItemInput {
  menuItemId?: string;
  productId?: string;
  quantity: number;
}

export interface FoodCheckoutInput {
  customerId: string;
  items: CartItemInput[];
  address: string;
  phone: string;
}

export async function listVendors() {
  return db.vendor.findMany({
    where: { isOpen: true },
    include: {
      category: true,
      menuItems: { where: { isAvailable: true } },
    },
  });
}

export async function getVendor(vendorId: string) {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    include: {
      category: true,
      menuItems: true,
    },
  });
  if (!vendor) throw new Error(`Vendor not found: ${vendorId}`);
  return vendor;
}

export async function calculateCart(items: CartItemInput[]) {
  if (!items || !items.length) {
    throw new Error("Cart is empty");
  }

  let total = 0;
  const resolvedItems: { productId: string; name: string; quantity: number; unitPrice: number }[] = [];

  for (const item of items) {
    const qty = Math.max(1, item.quantity || 1);
    let name = "";
    let price = 0;
    let itemId = item.menuItemId || item.productId;

    if (item.menuItemId) {
      const mi = await db.menuItem.findUnique({ where: { id: item.menuItemId } });
      if (!mi || !mi.isAvailable) throw new Error(`Menu item unavailable: ${item.menuItemId}`);
      name = mi.name;
      price = Number(mi.price);
      itemId = mi.id;
    } else if (item.productId) {
      const p = await db.product.findUnique({ where: { id: item.productId } });
      if (!p || !p.active) throw new Error(`Product unavailable: ${item.productId}`);
      name = p.name;
      price = Number(p.price);
      itemId = p.id;
    } else {
      throw new Error("Each cart item must have menuItemId or productId");
    }

    total += price * qty;
    resolvedItems.push({
      productId: itemId!,
      name,
      quantity: qty,
      unitPrice: price,
    });
  }

  return { total: Math.round(total * 100) / 100, items: resolvedItems };
}

export interface FoodCheckoutInput {
  customerId: string;
  items: CartItemInput[];
  address: string;
  phone: string;
  deliveryUrgency?: "express" | "standard" | "relaxed";
  pickupLat?: number;
  pickupLng?: number;
  dropoffLat?: number;
  dropoffLng?: number;
  autoAssignCourier?: boolean;
}

export async function checkout(input: FoodCheckoutInput) {
  const { total, items } = await calculateCart(input.items);
  const urgency = input.deliveryUrgency || "standard";

  // Find food category
  const foodCategory = await db.serviceCategory.findFirst({
    where: {
      OR: [
        { id: "cat-food" },
        { name: { equals: "Food", mode: "insensitive" } },
      ],
    },
  });

  // Call Core Order Engine to create order (NO direct writes to Order table)
  const order = await createOrder({
    customerId: input.customerId,
    serviceType: ServiceType.food,
    serviceCategoryId: foodCategory?.id,
    priceFinal: total,
    total,
    address: input.address,
    phone: input.phone,
    pickupLat: input.pickupLat || 30.0444, // Default Cairo vendor lat
    pickupLng: input.pickupLng || 31.2357, // Default Cairo vendor lng
    dropoffLat: input.dropoffLat,
    dropoffLng: input.dropoffLng,
    payload: {
      items,
      notes: "Food delivery order",
      deliveryUrgency: urgency,
    },
    initialStatus: OrderStatus.matching,
  });

  // Update order with staged lifecycle fields
  await db.order.update({
    where: { id: order.id },
    data: {
      deliveryUrgency: urgency,
      vendorStatus: "preparing",
    },
  });

  // If auto-assign courier is requested (e.g. instant flow), find courier immediately
  const courier = await dispatchDeliveryCourier(order.id, urgency);
  if (courier) {
    return db.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { user: true, provider: true, serviceCategory: true },
    });
  }

  return order;
}

/**
 * Intelligent Courier Dispatching Engine based on Location and Speed/Urgency Preference:
 * - "express": Selects motorcycle / sedan couriers for maximum speed.
 * - "standard" / "relaxed": Matches walking couriers, bicycles, or motorcycles.
 */
export async function dispatchDeliveryCourier(orderId: string, overrideUrgency?: string) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error(`Order not found: ${orderId}`);

  const urgency = overrideUrgency || order.deliveryUrgency || "standard";

  // 1. Determine vehicle criteria based on urgency
  let vehicleFilter: any;
  if (urgency === "express") {
    // Fast delivery requires motorized vehicle (motorcycle, sedan, pickup)
    vehicleFilter = { in: ["motorcycle", "sedan", "pickup"] };
  } else {
    // Standard / relaxed delivery can utilize foot couriers (walking), bicycles, or motorcycles
    vehicleFilter = { in: ["walking", "bicycle", "motorcycle", "sedan", "pickup"] };
  }

  // 2. Query available couriers from database
  let candidateProfiles = await db.providerProfile.findMany({
    where: {
      isAvailable: true,
      OR: [
        { vehicleType: vehicleFilter },
        urgency !== "express" ? { vehicleType: null } : {},
      ],
      user: {
        roles: {
          some: {
            role: { name: "driver" },
          },
        },
      },
    },
    include: { user: true },
  });

  // Plan B fallback: if no specific mode found, pick any available driver
  if (!candidateProfiles.length) {
    candidateProfiles = await db.providerProfile.findMany({
      where: {
        isAvailable: true,
        user: {
          roles: {
            some: {
              role: { name: "driver" },
            },
          },
        },
      },
      include: { user: true },
    });
  }

  if (!candidateProfiles.length) {
    return null;
  }

  // 3. Rank by Haversine distance from vendor pickup location
  const pLat = order.pickupLat ?? 30.0444;
  const pLng = order.pickupLng ?? 31.2357;

  const ranked = candidateProfiles.map((p) => {
    const lat = p.currentLat ?? pLat;
    const lng = p.currentLng ?? pLng;
    const dLat = (lat - pLat) * (Math.PI / 180);
    const dLng = (lng - pLng) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(pLat * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
    const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return { profile: p, distKm };
  });

  ranked.sort((a, b) => a.distKm - b.distKm);
  const bestMatch = ranked[0].profile;

  // 4. Assign courier to order
  const updatedOrder = await db.order.update({
    where: { id: orderId },
    data: {
      providerId: bestMatch.userId,
      courierId: bestMatch.userId,
      status: OrderStatus.accepted,
    },
    include: { user: true, provider: true },
  });

  return {
    order: updatedOrder,
    courier: {
      id: bestMatch.user.id,
      name: bestMatch.user.name,
      phone: bestMatch.user.phone,
      vehicleType: bestMatch.vehicleType || "walking",
      distanceKm: Math.round(ranked[0].distKm * 100) / 100,
    },
  };
}

/**
 * Step 1: Restaurant/Vendor marks food ready.
 * Platform automatically finds & dispatches the nearest courier based on speed/urgency.
 */
export async function markFoodReady(orderId: string) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error(`Order not found: ${orderId}`);

  await db.order.update({
    where: { id: orderId },
    data: {
      vendorStatus: "ready_for_pickup",
      vendorPreparedAt: new Date(),
    },
  });

  const dispatchResult = await dispatchDeliveryCourier(orderId, order.deliveryUrgency || "standard");
  return {
    orderId,
    vendorStatus: "ready_for_pickup",
    dispatchedCourier: dispatchResult?.courier || null,
  };
}

/**
 * Step 2: Courier arrives at restaurant and marks food picked up.
 */
export async function courierPickup(orderId: string, courierUserId?: string) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error(`Order not found: ${orderId}`);

  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      vendorStatus: "picked_up",
      courierPickedUpAt: new Date(),
      status: OrderStatus.in_progress,
    },
    include: { user: true, provider: true },
  });

  return {
    orderId,
    status: updated.status,
    vendorStatus: "picked_up",
    courierPickedUpAt: updated.courierPickedUpAt,
  };
}

/**
 * Step 3: Two-Party Delivery Confirmation Handshake
 * - Courier marks delivered
 * - Customer confirms receipt
 * - When both confirm -> order completes & settles automatically!
 */
export async function confirmFoodDelivered(orderId: string, confirmedByRole: "courier" | "customer") {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error(`Order not found: ${orderId}`);

  const now = new Date();
  const updateData: any = {};

  if (confirmedByRole === "courier") {
    updateData.courierDeliveredAt = now;
  } else if (confirmedByRole === "customer") {
    updateData.customerReceivedAt = now;
  }

  // If customer confirmed or both confirmed, advance order to completed & settle
  const willComplete =
    confirmedByRole === "customer" || (order.customerReceivedAt !== null && confirmedByRole === "courier");

  if (willComplete) {
    updateData.status = OrderStatus.completed;
    updateData.completedAt = now;
  }

  const updated = await db.order.update({
    where: { id: orderId },
    data: updateData,
    include: { user: true, provider: true },
  });

  if (willComplete) {
    const { settleOrder } = await import("../../core/wallet/wallet.service.js");
    await settleOrder(orderId);
  }

  return {
    orderId,
    status: updated.status,
    courierDeliveredAt: updated.courierDeliveredAt,
    customerReceivedAt: updated.customerReceivedAt,
    isFullyCompleted: willComplete,
  };
}
