import { VehicleType, ServiceType, NotificationChannel } from "@prisma/client";
import { db } from "../../db.js";
import { executeWithPlanB } from "./resilience.service.js";
import { calculateDistanceKm, estimateEtaMinutes, ProviderDistanceResult } from "../proximity/index.js";
import { emitToRoom } from "../sockets/index.js";

/**
 * 1. AI Suggestion Plan B:
 * If Claude / LLM fails or is disconnected, deterministic heuristic fallback
 * analyzes popular local menus, time of day, and cuisine preferences.
 */
export async function planBAiSuggest(
  serviceType: string,
  userPrompt: string,
  primaryAiCall: () => Promise<any>
) {
  return executeWithPlanB(
    "ai_engine",
    primaryAiCall,
    async (_error) => {
      // Dynamic Database-Driven Heuristic Fallback
      const currentHour = new Date().getHours();
      const isMealTime = (currentHour >= 12 && currentHour <= 15) || (currentHour >= 19 && currentHour <= 23);

      let suggestions: any[] = [];
      if (serviceType.toLowerCase().includes("food") || userPrompt.toLowerCase().includes("food") || isMealTime) {
        // Query real open restaurants from PostgreSQL database
        const realVendors = await db.vendor.findMany({
          where: { isOpen: true },
          include: { menuItems: { where: { isAvailable: true }, take: 2 } },
          take: 4,
        });

        if (realVendors.length > 0) {
          suggestions = realVendors.map((v) => ({
            id: v.id,
            name: v.name,
            reason: `Active open partner restaurant at ${v.address} with ${v.menuItems.length} featured dishes`,
            rating: 4.8,
            eta: "15-25 mins",
            sampleItems: v.menuItems.map((m) => m.name),
          }));
        }
      }

      if (suggestions.length === 0) {
        // Query real available verified providers from PostgreSQL database
        const realProviders = await db.providerProfile.findMany({
          where: { isAvailable: true },
          include: { user: { select: { id: true, name: true } } },
          take: 4,
        });

        if (realProviders.length > 0) {
          suggestions = realProviders.map((p) => ({
            id: p.userId,
            name: p.user.name,
            reason: `Active verified ${p.vehicleType || "specialist"} provider ready for immediate dispatch`,
            rating: 4.9,
            eta: "5-10 mins",
          }));
        }
      }

      // If still empty, query real service categories
      if (suggestions.length === 0) {
        const categories = await db.serviceCategory.findMany({ take: 3 });
        suggestions = categories.map((c) => ({
          id: c.id,
          name: c.name,
          reason: `Featured active MoveX category for immediate booking`,
        }));
      }

      return {
        suggestion_type: serviceType,
        suggested_items: suggestions,
        confidence: 0.85,
        planBActivated: true,
        fallbackSource: "MoveX Database-Driven Smart Rules Engine",
      };
    },
    { timeoutMs: 3000 }
  );
}

/**
 * 2. Vehicle Capacity Escalation Plan B:
 * If requested vehicle tier is not available, escalates upward in capacity hierarchy:
 * sedan (1) -> pickup (2) -> van (3) -> small_truck (4) -> large_truck (5).
 */
const CAPACITY_TIERS: VehicleType[] = [
  VehicleType.walking,
  VehicleType.bicycle,
  VehicleType.motorcycle,
  VehicleType.sedan,
  VehicleType.pickup,
  VehicleType.van,
  VehicleType.small_truck,
  VehicleType.large_truck,
];

export async function planBVehicleDispatch(
  requestedTier: VehicleType,
  lat: number,
  lng: number,
  maxDistanceKm: number = 30
): Promise<{
  selectedTier: VehicleType;
  escalated: boolean;
  providers: ProviderDistanceResult[];
  notes?: string;
}> {
  const startIndex = CAPACITY_TIERS.indexOf(requestedTier);
  if (startIndex === -1) {
    throw new Error(`Invalid vehicle tier: ${requestedTier}`);
  }

  // Iterate from requested tier up to largest truck
  for (let i = startIndex; i < CAPACITY_TIERS.length; i++) {
    const currentTier = CAPACITY_TIERS[i];
    const providers = await db.providerProfile.findMany({
      where: {
        isAvailable: true,
        vehicleType: currentTier,
        currentLat: { not: null },
        currentLng: { not: null },
      },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    const nearby: ProviderDistanceResult[] = [];
    for (const p of providers) {
      if (p.currentLat !== null && p.currentLng !== null) {
        const dist = calculateDistanceKm(lat, lng, p.currentLat, p.currentLng);
        if (dist <= maxDistanceKm) {
          nearby.push({
            providerId: p.id,
            userId: p.userId,
            name: p.user.name,
            phone: p.user.phone,
            vehicleType: p.vehicleType,
            distanceKm: dist,
            etaMinutes: estimateEtaMinutes(dist),
            currentLat: p.currentLat,
            currentLng: p.currentLng,
          });
        }
      }
    }

    if (nearby.length > 0) {
      const escalated = i > startIndex;
      return {
        selectedTier: currentTier,
        escalated,
        providers: nearby.sort((a, b) => a.distanceKm - b.distanceKm),
        notes: escalated
          ? `Requested tier ${requestedTier} had 0 drivers. Plan B escalated to ${currentTier} with ${nearby.length} available driver(s).`
          : undefined,
      };
    }
  }

  // If no vehicles found in higher tiers either
  return {
    selectedTier: requestedTier,
    escalated: false,
    providers: [],
    notes: `No vehicles available in ${requestedTier} or any higher capacity tier within ${maxDistanceKm}km.`,
  };
}

/**
 * 3. Routing & Geospatial Plan B:
 * If Google Maps / external routing API fails, Plan B calculates
 * Haversine great-circle distance with urban road-network tortuosity factor (1.3x)
 * and generates interpolated navigation waypoints.
 */
export async function planBRouteCalculation(
  pickupLat: number,
  pickupLng: number,
  dropoffLat: number,
  dropoffLng: number,
  primaryRouteApi?: () => Promise<any>
) {
  const primaryFn = primaryRouteApi || (async () => {
    // If no external routing API configured, throw to trigger Plan B
    throw new Error("External Maps Routing service not configured or offline");
  });

  return executeWithPlanB(
    "maps_routing_service",
    primaryFn,
    async () => {
      // Plan B: High-precision Haversine with 1.3 urban curvature factor
      const directDist = calculateDistanceKm(pickupLat, pickupLng, dropoffLat, dropoffLng);
      const roadDistKm = Math.round(directDist * 1.3 * 100) / 100;
      const etaMinutes = estimateEtaMinutes(roadDistKm, 28); // 28 km/h urban speed

      // Generate 5 interpolated navigation waypoints along the route
      const waypoints = [];
      const steps = 5;
      for (let s = 0; s <= steps; s++) {
        const ratio = s / steps;
        waypoints.push({
          lat: Math.round((pickupLat + (dropoffLat - pickupLat) * ratio) * 100000) / 100000,
          lng: Math.round((pickupLng + (dropoffLng - pickupLng) * ratio) * 100000) / 100000,
          stepIndex: s,
        });
      }

      return {
        distanceKm: roadDistKm,
        etaMinutes,
        waypoints,
        planBActivated: true,
        source: "MoveX Autonomous Geospatial Fallback Engine",
      };
    }
  );
}

/**
 * 4. Notification Dispatch Plan B:
 * If real-time Socket or push notification fails, Plan B guarantees persistence
 * in the database Notification table and marks it for immediate polling retrieval.
 */
export async function planBNotificationSend(
  userId: string,
  title: string,
  body: string,
  data?: any
) {
  return executeWithPlanB(
    "notification_socket_dispatch",
    async () => {
      // Primary: Real-time socket push
      const sent = emitToRoom(`user:${userId}`, "notification:received", {
        title,
        body,
        data,
        timestamp: new Date(),
      });
      // Also save to database
      const notif = await db.notification.create({
        data: {
          userId,
          title,
          body,
          channel: NotificationChannel.push,
          status: "sent",
        },
      });
      return { success: true, notifId: notif.id, channel: "socket_and_db" };
    },
    async (_error) => {
      // Plan B: Guaranteed database persistence + offline queue
      const notif = await db.notification.create({
        data: {
          userId,
          title: `[In-App] ${title}`,
          body,
          channel: NotificationChannel.push,
          status: "pending_sync",
        },
      });
      return {
        success: true,
        notifId: notif.id,
        channel: "database_polling_fallback",
        planBActivated: true,
      };
    }
  );
}

/**
 * 5. Database Transient Error Retry Wrapper
 */
export async function planBDbRetry<T>(
  actionName: string,
  queryFn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 300
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (err: any) {
      lastError = err;
      const isTransient =
        err.message?.includes("connection") ||
        err.message?.includes("deadlock") ||
        err.message?.includes("timeout") ||
        err.message?.includes("ECONNRESET");

      if (attempt < maxRetries && isTransient) {
        console.warn(`[Plan B DB Retry] ${actionName} failed (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt - 1)));
      } else if (!isTransient) {
        throw err;
      }
    }
  }
  throw lastError;
}
