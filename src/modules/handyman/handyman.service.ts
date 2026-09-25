import { ServiceType } from "@prisma/client";
import { db } from "../../db.js";
import { createBiddingRequest } from "../../bidding/offers.service.js";

export interface RequestHandymanInput {
  customerId: string;
  serviceCategoryId: string;
  lat?: number;
  lng?: number;
  description: string;
}

/**
 * Handyman Module Service:
 * Uses ServiceCategory classification tree (plumbing, electrical, carpentry, etc.).
 * ARCHITECTURAL RULE: No hardcoded categories in code — always looks up ServiceCategory table.
 * Uses bidding layer for worker negotiation; order-engine.createOrder() called ONLY upon offer acceptance.
 */
export async function requestHandyman(input: RequestHandymanInput) {
  const category = await db.serviceCategory.findUnique({
    where: { id: input.serviceCategoryId },
  });

  if (!category) {
    throw new Error(`Invalid service category: ${input.serviceCategoryId}. Must be a valid ServiceCategory.`);
  }

  return createBiddingRequest({
    customerId: input.customerId,
    serviceType: ServiceType.handyman,
    serviceCategoryId: category.id,
    pickupLat: input.lat,
    pickupLng: input.lng,
    details: {
      description: input.description,
      categoryName: category.name,
      requestTime: new Date().toISOString(),
    },
  });
}

export async function listHandymanCategories() {
  const handymanParent = await db.serviceCategory.findFirst({
    where: {
      OR: [
        { id: "cat-handyman" },
        { name: { equals: "Handyman", mode: "insensitive" } },
      ],
    },
    include: {
      children: true,
    },
  });

  return handymanParent?.children || [];
}
