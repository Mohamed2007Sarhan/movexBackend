import { ServiceType, OfferStatus, OrderStatus } from "@prisma/client";
import { db } from "../db.js";
import { createOrder } from "../core/order-engine/index.js";
import { emitToBidding, emitToProvider, emitToUser } from "../core/sockets/index.js";

export interface CreateBiddingRequestInput {
  customerId: string;
  serviceType: ServiceType;
  serviceCategoryId: string;
  pickupLat?: number;
  pickupLng?: number;
  dropoffLat?: number;
  dropoffLng?: number;
  details?: any;
}

export interface SubmitOfferInput {
  biddingRequestId: string;
  providerId: string;
  amount: number;
  message?: string;
}

export async function createBiddingRequest(input: CreateBiddingRequestInput) {
  if (input.serviceType !== ServiceType.ride && input.serviceType !== ServiceType.handyman) {
    throw new Error(`Bidding is only permitted for 'ride' and 'handyman', received '${input.serviceType}'`);
  }

  // Verify serviceCategory exists
  const category = await db.serviceCategory.findUnique({
    where: { id: input.serviceCategoryId },
  });
  if (!category) throw new Error(`ServiceCategory not found: ${input.serviceCategoryId}`);

  // Create pending BiddingRequest record (does NOT touch Order table)
  const request = await db.biddingRequest.create({
    data: {
      customerId: input.customerId,
      serviceType: input.serviceType,
      serviceCategoryId: input.serviceCategoryId,
      pickupLat: input.pickupLat,
      pickupLng: input.pickupLng,
      dropoffLat: input.dropoffLat,
      dropoffLng: input.dropoffLng,
      details: input.details ?? undefined,
      status: "open",
    },
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      serviceCategory: true,
    },
  });

  // Find eligible providers by serviceCategories or parent category
  const eligibleProviders = await db.providerProfile.findMany({
    where: {
      isAvailable: true,
      serviceCategories: {
        some: {
          OR: [
            { serviceCategoryId: input.serviceCategoryId },
            { serviceCategoryId: category.parentId || input.serviceCategoryId },
          ],
        },
      },
    },
    include: { user: true },
  });

  // Notify nearby eligible providers via socket
  for (const provider of eligibleProviders) {
    emitToProvider(provider.userId, "bidding:new_request", {
      requestId: request.id,
      serviceType: request.serviceType,
      categoryName: category.name,
      pickupLat: request.pickupLat,
      pickupLng: request.pickupLng,
      details: request.details,
    });
  }

  return { request, notifiedProviderCount: eligibleProviders.length };
}

export async function getBiddingRequest(requestId: string) {
  const req = await db.biddingRequest.findUnique({
    where: { id: requestId },
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      serviceCategory: true,
      offers: {
        include: {
          provider: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!req) throw new Error(`Bidding request not found: ${requestId}`);
  return req;
}

export async function submitOffer(input: SubmitOfferInput) {
  const req = await db.biddingRequest.findUnique({
    where: { id: input.biddingRequestId },
  });
  if (!req) throw new Error(`Bidding request not found: ${input.biddingRequestId}`);
  if (req.status !== "open") throw new Error(`Cannot submit offer to a ${req.status} request`);

  const offer = await db.offer.create({
    data: {
      biddingRequestId: input.biddingRequestId,
      providerId: input.providerId,
      amount: input.amount,
      message: input.message,
      status: OfferStatus.pending,
    },
    include: {
      provider: { select: { id: true, name: true, phone: true } },
    },
  });

  // Notify customer and bidding room
  emitToBidding(req.id, "bidding:new_offer", offer);
  emitToUser(req.customerId, "bidding:new_offer", offer);

  return offer;
}

export async function acceptOffer(offerId: string, customerId: string) {
  return db.$transaction(async (tx) => {
    const offer = await tx.offer.findUnique({
      where: { id: offerId },
      include: {
        biddingRequest: true,
        provider: true,
      },
    });

    if (!offer) throw new Error(`Offer not found: ${offerId}`);
    if (offer.status !== OfferStatus.pending) {
      throw new Error(`Offer is already ${offer.status}`);
    }

    const biddingReq = offer.biddingRequest;
    if (!biddingReq) throw new Error("Offer is not attached to an active bidding request");

    if (biddingReq.customerId !== customerId) {
      throw new Error("Unauthorized: Only the customer who opened the request may accept an offer");
    }

    // 1. Mark this offer accepted
    const acceptedOffer = await tx.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.accepted },
    });

    // 2. Auto-reject/expire all other pending offers for this request
    await tx.offer.updateMany({
      where: {
        biddingRequestId: biddingReq.id,
        id: { not: offerId },
        status: OfferStatus.pending,
      },
      data: { status: OfferStatus.rejected },
    });

    // 3. Mark bidding request accepted
    await tx.biddingRequest.update({
      where: { id: biddingReq.id },
      data: { status: "accepted" },
    });

    // 4. THIS IS THE ONLY POINT WHERE orderEngine.createOrder() IS CALLED FOR RIDE & HANDYMAN
    // Pre-filled with agreed price and provider!
    const agreedPrice = Number(offer.amount);
    const order = await createOrder({
      customerId: biddingReq.customerId,
      serviceType: biddingReq.serviceType,
      serviceCategoryId: biddingReq.serviceCategoryId,
      providerId: offer.providerId,
      priceFinal: agreedPrice,
      total: agreedPrice,
      pickupLat: biddingReq.pickupLat ?? undefined,
      pickupLng: biddingReq.pickupLng ?? undefined,
      dropoffLat: biddingReq.dropoffLat ?? undefined,
      dropoffLng: biddingReq.dropoffLng ?? undefined,
      payload: {
        biddingRequestId: biddingReq.id,
        offerId: offer.id,
        negotiatedPrice: agreedPrice,
      },
      initialStatus: OrderStatus.accepted,
    });

    // Link offer to created order
    await tx.offer.update({
      where: { id: offer.id },
      data: { orderId: order.id },
    });

    // Realtime notifications
    emitToBidding(biddingReq.id, "bidding:offer_accepted", {
      acceptedOfferId: offer.id,
      orderId: order.id,
      price: agreedPrice,
    });
    emitToUser(offer.providerId, "bidding:offer_won", {
      orderId: order.id,
      price: agreedPrice,
    });

    return { order, acceptedOffer };
  });
}
