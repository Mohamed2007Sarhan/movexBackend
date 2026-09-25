import { OrderStatus, ServiceType, VehicleType, Prisma } from "@prisma/client";
import { db } from "../../db.js";
import { settleOrder } from "../wallet/wallet.service.js";

export interface CreateOrderParams {
  customerId: string;
  serviceType: ServiceType;
  serviceCategoryId?: string;
  pickupLat?: number;
  pickupLng?: number;
  dropoffLat?: number;
  dropoffLng?: number;
  requiredVehicleType?: VehicleType;
  priceFinal: number;
  total?: number;
  address?: string;
  phone?: string;
  payload?: any;
  items?: { productId: string; quantity: number; unitPrice: number }[];
  initialStatus?: OrderStatus;
  providerId?: string;
}

// Explicit allowed state machine transitions
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.pending]: [OrderStatus.matching, OrderStatus.accepted, OrderStatus.cancelled],
  [OrderStatus.matching]: [OrderStatus.accepted, OrderStatus.cancelled],
  [OrderStatus.accepted]: [OrderStatus.in_progress, OrderStatus.cancelled],
  [OrderStatus.in_progress]: [OrderStatus.completed, OrderStatus.cancelled, OrderStatus.disputed],
  [OrderStatus.completed]: [OrderStatus.disputed],
  [OrderStatus.cancelled]: [],
  [OrderStatus.disputed]: [OrderStatus.completed, OrderStatus.cancelled],

  // Legacy mappings
  [OrderStatus.PENDING]: [OrderStatus.matching, OrderStatus.accepted, OrderStatus.CONFIRMED, OrderStatus.cancelled, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.in_progress, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.in_progress, OrderStatus.CANCELLED],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED, OrderStatus.completed, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

export class OrderEngineError extends Error {
  constructor(message: string, public code: string = "ORDER_ENGINE_ERROR") {
    super(message);
    this.name = "OrderEngineError";
  }
}

/**
 * Creates an order through the unified Order Engine.
 * Modules must call this instead of directly touching the Order table.
 */
export async function createOrder(params: CreateOrderParams) {
  const initialStatus = params.initialStatus || OrderStatus.pending;
  const price = params.priceFinal;

  let serviceCategoryId = params.serviceCategoryId;
  if (!serviceCategoryId) {
    // Resolve fallback category for serviceType if not specified
    const cat = await db.serviceCategory.findFirst({
      where: {
        OR: [
          { id: `cat-${params.serviceType}` },
          { name: { equals: params.serviceType, mode: "insensitive" } },
        ],
      },
    });
    serviceCategoryId = cat?.id;
  }

  const orderData: Prisma.OrderCreateInput = {
    user: { connect: { id: params.customerId } },
    serviceType: params.serviceType,
    status: initialStatus,
    priceFinal: price,
    total: params.total !== undefined ? params.total : price,
    pickupLat: params.pickupLat,
    pickupLng: params.pickupLng,
    dropoffLat: params.dropoffLat,
    dropoffLng: params.dropoffLng,
    requiredVehicleType: params.requiredVehicleType,
    address: params.address,
    phone: params.phone,
    payload: params.payload ?? undefined,
  };

  if (serviceCategoryId) {
    orderData.serviceCategory = { connect: { id: serviceCategoryId } };
  }

  if (params.providerId) {
    orderData.provider = { connect: { id: params.providerId } };
  }

  if (params.items && params.items.length) {
    orderData.items = {
      create: params.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    };
  }

  const order = await db.order.create({
    data: orderData,
    include: {
      items: { include: { product: true } },
      serviceCategory: true,
      user: true,
      provider: true,
    },
  });

  return order;
}

/**
 * Assigns an eligible provider to an order and updates status to accepted.
 */
export async function assignProvider(orderId: string, providerId: string) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderEngineError(`Order not found: ${orderId}`, "NOT_FOUND");

  if (order.status !== OrderStatus.pending && order.status !== OrderStatus.matching) {
    throw new OrderEngineError(
      `Cannot assign provider to order in status '${order.status}'`,
      "INVALID_STATE"
    );
  }

  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      providerId,
      status: OrderStatus.accepted,
    },
    include: {
      user: true,
      provider: true,
      serviceCategory: true,
      items: { include: { product: true } },
    },
  });

  return updated;
}

/**
 * Advances the order status according to the state machine rules.
 */
export async function advanceStatus(orderId: string, nextStatus: OrderStatus) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderEngineError(`Order not found: ${orderId}`, "NOT_FOUND");

  const currentStatus = order.status;
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];

  if (!allowed.includes(nextStatus)) {
    throw new OrderEngineError(
      `Invalid state transition: '${currentStatus}' -> '${nextStatus}'. Allowed next states: [${allowed.join(", ")}]`,
      "ILLEGAL_TRANSITION"
    );
  }

  const isCompleting = nextStatus === OrderStatus.completed || nextStatus === OrderStatus.DELIVERED;

  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      status: nextStatus,
      completedAt: isCompleting ? new Date() : undefined,
    },
    include: {
      user: true,
      provider: true,
      serviceCategory: true,
      items: { include: { product: true } },
    },
  });

  // When order completes, settle money automatically via wallet service
  if (isCompleting) {
    try {
      await settleOrder(orderId);
    } catch (settleErr: any) {
      console.error(`[OrderEngine] Error auto-settling order ${orderId}:`, settleErr);
    }
  }

  return updated;
}

/**
 * Cancels an order if in a cancellable state.
 */
export async function cancelOrder(orderId: string, reason?: string) {
  return advanceStatus(orderId, OrderStatus.cancelled);
}

/**
 * Gets order details with full relations.
 */
export async function getOrder(orderId: string) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      user: true,
      provider: true,
      serviceCategory: true,
      items: { include: { product: true } },
      transactions: true,
      offers: true,
    },
  });
  if (!order) throw new OrderEngineError(`Order not found: ${orderId}`, "NOT_FOUND");
  return order;
}
