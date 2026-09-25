import { VehicleType } from "@prisma/client";
import { db } from "../../db.js";
import { emitToRoom } from "../sockets/index.js";

/**
 * Calculates the great-circle distance between two points on the Earth's surface
 * using the Haversine formula (returns distance in Kilometers).
 */
export function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's mean radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Estimates travel time in minutes based on distance and average urban vehicle speed (30 km/h).
 */
export function estimateEtaMinutes(distanceKm: number, averageSpeedKmh: number = 30): number {
  const hours = distanceKm / averageSpeedKmh;
  return Math.max(1, Math.round(hours * 60));
}

export interface NearestProviderSearchParams {
  lat: number;
  lng: number;
  serviceCategoryId?: string;
  vehicleTypes?: VehicleType[];
  maxDistanceKm?: number;
  limit?: number;
}

export interface ProviderDistanceResult {
  providerId: string;
  userId: string;
  name: string;
  phone: string;
  vehicleType: VehicleType | null;
  distanceKm: number;
  etaMinutes: number;
  currentLat: number;
  currentLng: number;
}

/**
 * Queries available providers and calculates exact proximity sorted from nearest to furthest.
 */
export async function findNearestProviders(params: NearestProviderSearchParams): Promise<ProviderDistanceResult[]> {
  const maxDistance = params.maxDistanceKm ?? 50;
  const limit = params.limit ?? 10;

  const whereClause: any = {
    isAvailable: true,
    currentLat: { not: null },
    currentLng: { not: null },
  };

  if (params.vehicleTypes && params.vehicleTypes.length) {
    whereClause.vehicleType = { in: params.vehicleTypes };
  }

  if (params.serviceCategoryId) {
    whereClause.serviceCategories = {
      some: { serviceCategoryId: params.serviceCategoryId },
    };
  }

  const profiles = await db.providerProfile.findMany({
    where: whereClause,
    include: {
      user: {
        select: { id: true, name: true, phone: true },
      },
    },
  });

  const ranked: ProviderDistanceResult[] = [];

  for (const p of profiles) {
    if (p.currentLat !== null && p.currentLng !== null) {
      const distance = calculateDistanceKm(params.lat, params.lng, p.currentLat, p.currentLng);
      if (distance <= maxDistance) {
        ranked.push({
          providerId: p.id,
          userId: p.userId,
          name: p.user.name,
          phone: p.user.phone,
          vehicleType: p.vehicleType,
          distanceKm: distance,
          etaMinutes: estimateEtaMinutes(distance),
          currentLat: p.currentLat,
          currentLng: p.currentLng,
        });
      }
    }
  }

  return ranked.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
}

/**
 * Updates provider's real-time GPS coordinates and broadcasts to relevant subscribers.
 */
export async function updateProviderLocation(userId: string, lat: number, lng: number) {
  const profile = await db.providerProfile.update({
    where: { userId },
    data: {
      currentLat: lat,
      currentLng: lng,
      lastLocationUpdate: new Date(),
    },
  });

  // Real-time broadcast
  emitToRoom(`provider:${userId}`, "location:updated", { userId, lat, lng, timestamp: new Date() });

  return profile;
}
