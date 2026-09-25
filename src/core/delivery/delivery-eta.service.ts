/**
 * Delivery ETA Service
 * 
 * Calculates estimated delivery time based on:
 * - Distance (Haversine formula between pickup and dropoff)
 * - Vehicle type speed (configurable from SystemConfig)
 * - Delivery urgency (express / standard / relaxed)
 * - Buffer minutes for pickup/handoff
 * 
 * Also handles driver laziness detection:
 * - Compares actual delivery time vs estimated
 * - Flags orders where driver was late beyond grace period
 * - Updates ProviderProfile.lateDeliveries counter
 */

import { db } from "../../db.js";
import { getConfigNumber, getConfigs, CONFIG_KEYS } from "../config/system-config.service.js";
import { VehicleType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Haversine Distance (km)
// ---------------------------------------------------------------------------
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Get vehicle speed from SystemConfig
// ---------------------------------------------------------------------------
async function getVehicleSpeedKmh(vehicleType: VehicleType | null | undefined): Promise<number> {
  const configs = await getConfigs([
    CONFIG_KEYS.SPEED_WALKING_KMH,
    CONFIG_KEYS.SPEED_BICYCLE_KMH,
    CONFIG_KEYS.SPEED_MOTORCYCLE_KMH,
    CONFIG_KEYS.SPEED_SEDAN_KMH,
    CONFIG_KEYS.SPEED_VAN_KMH,
    CONFIG_KEYS.SPEED_TRUCK_KMH,
  ]);

  switch (vehicleType) {
    case VehicleType.walking:
      return parseFloat(configs.speed_walking_kmh) || 5;
    case VehicleType.bicycle:
      return parseFloat(configs.speed_bicycle_kmh) || 15;
    case VehicleType.motorcycle:
      return parseFloat(configs.speed_motorcycle_kmh) || 40;
    case VehicleType.sedan:
      return parseFloat(configs.speed_sedan_kmh) || 35;
    case VehicleType.pickup:
      return parseFloat(configs.speed_sedan_kmh) || 35;
    case VehicleType.van:
      return parseFloat(configs.speed_van_kmh) || 30;
    case VehicleType.small_truck:
      return parseFloat(configs.speed_truck_kmh) || 25;
    case VehicleType.large_truck:
      return parseFloat(configs.speed_truck_kmh) || 25;
    default:
      return parseFloat(configs.speed_motorcycle_kmh) || 40; // default: motorcycle speed
  }
}

// ---------------------------------------------------------------------------
// Urgency multipliers
// ---------------------------------------------------------------------------
function urgencyMultiplier(urgency: string | null | undefined): number {
  switch (urgency) {
    case "express":
      return 0.7; // AI picks faster driver → 30% quicker estimate
    case "relaxed":
      return 1.4; // More lenient, allow slower vehicle
    default:
      return 1.0; // standard
  }
}

// ---------------------------------------------------------------------------
// Calculate ETA for an order
// ---------------------------------------------------------------------------
export interface EtaResult {
  distanceKm: number;
  speedKmh: number;
  baseTravelMinutes: number;
  bufferMinutes: number;
  etaMinutes: number;
  estimatedDeliveryAt: Date;
}

export async function calculateEta(params: {
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  vehicleType?: VehicleType | null;
  urgency?: string | null;
}): Promise<EtaResult> {
  const { pickupLat, pickupLng, dropoffLat, dropoffLng, vehicleType, urgency } = params;

  const distanceKm = haversineKm(pickupLat, pickupLng, dropoffLat, dropoffLng);
  const speedKmh = await getVehicleSpeedKmh(vehicleType);
  const bufferMinutes = await getConfigNumber(CONFIG_KEYS.ETA_BUFFER_MINUTES, 5);

  const baseTravelMinutes = (distanceKm / speedKmh) * 60;
  const adjustedMinutes = baseTravelMinutes * urgencyMultiplier(urgency);
  const etaMinutes = Math.round(adjustedMinutes + bufferMinutes);

  const estimatedDeliveryAt = new Date(Date.now() + etaMinutes * 60_000);

  return {
    distanceKm: Math.round(distanceKm * 100) / 100,
    speedKmh,
    baseTravelMinutes: Math.round(baseTravelMinutes),
    bufferMinutes,
    etaMinutes,
    estimatedDeliveryAt,
  };
}

/**
 * Attach ETA fields to an order record after creation.
 * Called immediately after order is created in createOrder().
 */
export async function attachEtaToOrder(orderId: string): Promise<void> {
  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { provider: { include: { providerProfile: true } } },
    });

    if (!order) return;
    if (!order.pickupLat || !order.pickupLng || !order.dropoffLat || !order.dropoffLng) return;
    if (order.etaMinutes) return; // Already has ETA

    const vehicleType = order.provider?.providerProfile?.vehicleType ?? order.requiredVehicleType ?? null;

    const eta = await calculateEta({
      pickupLat: order.pickupLat,
      pickupLng: order.pickupLng,
      dropoffLat: order.dropoffLat,
      dropoffLng: order.dropoffLng,
      vehicleType,
      urgency: order.deliveryUrgency,
    });

    await db.order.update({
      where: { id: orderId },
      data: {
        etaMinutes: eta.etaMinutes,
        estimatedDeliveryAt: eta.estimatedDeliveryAt,
      },
    });
  } catch (err) {
    console.error(`[ETA] Failed to attach ETA to order ${orderId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Check if driver was late and flag/record it
// ---------------------------------------------------------------------------
export async function checkAndFlagLateDelivery(orderId: string): Promise<void> {
  try {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    if (!order.estimatedDeliveryAt) return;
    if (!order.courierDeliveredAt && !order.workerFinishedAt && !order.completedAt) return;

    const actualDeliveryAt =
      order.courierDeliveredAt ?? order.workerFinishedAt ?? order.completedAt;
    if (!actualDeliveryAt) return;

    const graceMinutes = await getConfigNumber(CONFIG_KEYS.LATE_DELIVERY_GRACE_MINUTES, 10);
    const lateMsByGrace = graceMinutes * 60_000;

    const estimatedMs = order.estimatedDeliveryAt.getTime();
    const actualMs = actualDeliveryAt.getTime();
    const diffMs = actualMs - estimatedMs;

    const isLate = diffMs > lateMsByGrace;
    const lateByMinutes = isLate ? Math.round(diffMs / 60_000) : 0;

    await db.order.update({
      where: { id: orderId },
      data: {
        isLateDelivery: isLate,
        lateByMinutes: isLate ? lateByMinutes : 0,
      },
    });

    // Update driver's ProviderProfile stats
    const driverUserId = order.providerId ?? order.courierId;
    if (driverUserId) {
      const profile = await db.providerProfile.findUnique({ where: { userId: driverUserId } });
      if (profile) {
        await db.providerProfile.update({
          where: { userId: driverUserId },
          data: {
            totalDeliveries: { increment: 1 },
            ...(isLate ? { lateDeliveries: { increment: 1 } } : {}),
          },
        });
      }
    }

    if (isLate) {
      console.warn(
        `[ETA] ⚠️  Driver ${driverUserId} was ${lateByMinutes} minutes late on order ${orderId}. ` +
          `ETA was ${order.estimatedDeliveryAt.toISOString()}, actual: ${actualDeliveryAt.toISOString()}`
      );
    }
  } catch (err) {
    console.error(`[ETA] Failed to check late delivery for order ${orderId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Get driver performance stats
// ---------------------------------------------------------------------------
export async function getDriverPerformance(driverUserId: string) {
  const profile = await db.providerProfile.findUnique({
    where: { userId: driverUserId },
    include: { user: { select: { id: true, name: true, phone: true } } },
  });

  if (!profile) return null;

  const lateOrdersDetail = await db.order.findMany({
    where: { providerId: driverUserId, isLateDelivery: true },
    select: {
      id: true,
      createdAt: true,
      estimatedDeliveryAt: true,
      courierDeliveredAt: true,
      lateByMinutes: true,
      deliveryUrgency: true,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const lateRate =
    profile.totalDeliveries > 0
      ? Math.round((profile.lateDeliveries / profile.totalDeliveries) * 100)
      : 0;

  return {
    driver: profile.user,
    totalDeliveries: profile.totalDeliveries,
    lateDeliveries: profile.lateDeliveries,
    onTimeDeliveries: profile.totalDeliveries - profile.lateDeliveries,
    lateDeliveryRate: `${lateRate}%`,
    avgRating: profile.avgRating ? Number(profile.avgRating) : null,
    performanceScore: Math.max(0, 100 - lateRate),  // Simple score: 100 - late%
    recentLateOrders: lateOrdersDetail,
  };
}

// ---------------------------------------------------------------------------
// Admin: List all late deliveries with driver info
// ---------------------------------------------------------------------------
export async function listLateDeliveries(filters?: {
  driverUserId?: string;
  minLateMinutes?: number;
  limit?: number;
}) {
  const { driverUserId, minLateMinutes = 0, limit = 50 } = filters ?? {};

  return db.order.findMany({
    where: {
      isLateDelivery: true,
      ...(driverUserId ? { providerId: driverUserId } : {}),
      ...(minLateMinutes > 0 ? { lateByMinutes: { gte: minLateMinutes } } : {}),
    },
    include: {
      provider: {
        select: {
          id: true,
          name: true,
          phone: true,
          providerProfile: {
            select: {
              vehicleType: true,
              totalDeliveries: true,
              lateDeliveries: true,
              avgRating: true,
            },
          },
        },
      },
      user: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
