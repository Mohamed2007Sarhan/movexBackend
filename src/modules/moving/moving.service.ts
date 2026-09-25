import { ServiceType, VehicleType, OrderStatus } from "@prisma/client";
import { db } from "../../db.js";
import { createOrder, assignProvider } from "../../core/order-engine/index.js";
import { emitToProvider } from "../../core/sockets/index.js";

// Defined capacity hierarchy ordering: walking < bicycle < motorcycle < sedan < pickup < van < small_truck < large_truck
export const VEHICLE_CAPACITY_ORDER: Record<VehicleType, number> = {
  [VehicleType.walking]: 0,
  [VehicleType.bicycle]: 0.5,
  [VehicleType.motorcycle]: 0.8,
  [VehicleType.sedan]: 1,
  [VehicleType.pickup]: 2,
  [VehicleType.van]: 3,
  [VehicleType.small_truck]: 4,
  [VehicleType.large_truck]: 5,
};

export interface CreateMovingJobInput {
  customerId: string;
  requiredVehicleType: VehicleType;
  pickupAddress: string;
  dropoffAddress: string;
  pickupLat?: number;
  pickupLng?: number;
  dropoffLat?: number;
  dropoffLng?: number;
  itemsDescription: string;
  priceEstimate?: number;
}

/**
 * Returns list of VehicleTypes that have equal or greater capacity than the required type.
 * Rule: never match a smaller vehicle to a bigger job.
 */
export function getEligibleVehicleTypes(required: VehicleType): VehicleType[] {
  const minRank = VEHICLE_CAPACITY_ORDER[required];
  return (Object.keys(VEHICLE_CAPACITY_ORDER) as VehicleType[]).filter(
    (vt) => VEHICLE_CAPACITY_ORDER[vt] >= minRank
  );
}

/**
 * Moving Service:
 * Enforces vehicle capacity ordering and dispatches only to capable providers.
 */
export async function createMovingJob(input: CreateMovingJobInput) {
  const movingCategory = await db.serviceCategory.findFirst({
    where: {
      OR: [
        { id: "cat-moving" },
        { name: { equals: "Moving", mode: "insensitive" } },
      ],
    },
  });

  const basePrice = input.priceEstimate || 50.0;

  // 1. Create order via Core Order Engine
  const order = await createOrder({
    customerId: input.customerId,
    serviceType: ServiceType.moving,
    serviceCategoryId: movingCategory?.id,
    requiredVehicleType: input.requiredVehicleType,
    pickupLat: input.pickupLat,
    pickupLng: input.pickupLng,
    dropoffLat: input.dropoffLat,
    dropoffLng: input.dropoffLng,
    address: `${input.pickupAddress} -> ${input.dropoffAddress}`,
    priceFinal: basePrice,
    total: basePrice,
    payload: {
      itemsDescription: input.itemsDescription,
      pickupAddress: input.pickupAddress,
      dropoffAddress: input.dropoffAddress,
      requiredVehicleType: input.requiredVehicleType,
    },
    initialStatus: OrderStatus.matching,
  });

  // 2. Query eligible providers strictly enforcing capacity ordering
  const eligibleTypes = getEligibleVehicleTypes(input.requiredVehicleType);

  const eligibleProviders = await db.providerProfile.findMany({
    where: {
      isAvailable: true,
      vehicleType: { in: eligibleTypes },
      serviceCategories: {
        some: {
          serviceCategory: {
            OR: [
              { id: "cat-moving" },
              { name: { equals: "Moving", mode: "insensitive" } },
            ],
          },
        },
      },
    },
    include: { user: true },
  });

  // Notify each eligible provider
  for (const provider of eligibleProviders) {
    emitToProvider(provider.userId, "moving:new_job", {
      orderId: order.id,
      requiredVehicleType: input.requiredVehicleType,
      itemsDescription: input.itemsDescription,
      price: basePrice,
    });
  }

  // Auto-assign first available provider if ready
  let finalOrder = order;
  if (eligibleProviders.length > 0) {
    finalOrder = await assignProvider(order.id, eligibleProviders[0].userId);
  }

  return {
    order: finalOrder,
    matchedVehicleTypes: eligibleTypes,
    notifiedProviderCount: eligibleProviders.length,
    eligibleProviderIds: eligibleProviders.map((p) => p.userId),
  };
}

/**
 * Returns providers matching a required vehicle type for test verification.
 */
export async function getEligibleProvidersForVehicle(required: VehicleType) {
  const eligibleTypes = getEligibleVehicleTypes(required);
  return db.providerProfile.findMany({
    where: {
      isAvailable: true,
      vehicleType: { in: eligibleTypes },
      serviceCategories: {
        some: {
          serviceCategory: {
            OR: [
              { id: "cat-moving" },
              { name: { equals: "Moving", mode: "insensitive" } },
            ],
          },
        },
      },
    },
    include: { user: true },
  });
}
