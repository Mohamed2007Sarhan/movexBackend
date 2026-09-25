import { ServiceType } from "@prisma/client";
import { db } from "../../db.js";
import { createBiddingRequest } from "../../bidding/offers.service.js";

export interface RequestRideInput {
  customerId: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  notes?: string;
}

/**
 * Ride Module Service:
 * Opens a pending bidding request for drivers to bid on.
 * ARCHITECTURAL RULE: Does NOT call orderEngine.createOrder() directly.
 * Order creation occurs ONLY after the customer accepts an offer in the bidding layer.
 */
export async function requestRide(input: RequestRideInput) {
  // Resolve Ride ServiceCategory
  const rideCategory = await db.serviceCategory.findFirst({
    where: {
      OR: [
        { id: "cat-ride" },
        { name: { equals: "Ride", mode: "insensitive" } },
      ],
    },
  });

  if (!rideCategory) {
    throw new Error("Ride service category is not configured in ServiceCategory");
  }

  // Opens bidding request -> notifies nearby eligible drivers
  return createBiddingRequest({
    customerId: input.customerId,
    serviceType: ServiceType.ride,
    serviceCategoryId: rideCategory.id,
    pickupLat: input.pickupLat,
    pickupLng: input.pickupLng,
    dropoffLat: input.dropoffLat,
    dropoffLng: input.dropoffLng,
    details: {
      notes: input.notes,
      requestTime: new Date().toISOString(),
    },
  });
}
