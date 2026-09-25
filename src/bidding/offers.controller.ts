import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../core/auth/index.js";
import { requirePermission } from "../core/rbac/index.js";
import { createBiddingRequest, getBiddingRequest, submitOffer, acceptOffer } from "./offers.service.js";

const router = Router();

// Customer opens a bidding request (ride or handyman)
router.post(["/requests", "/request"], authMiddleware, requirePermission("order.create"), async (req: AuthRequest, res: Response) => {
  const { serviceType, serviceCategoryId, pickupLat, pickupLng, dropoffLat, dropoffLng, details } = req.body;

  if (!serviceType || !serviceCategoryId) {
    return res.status(400).json({ message: "serviceType and serviceCategoryId are required" });
  }

  try {
    const result = await createBiddingRequest({
      customerId: req.user!.id,
      serviceType,
      serviceCategoryId,
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
      details,
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// View a bidding request and its offers
router.get(["/requests/:id", "/request/:id"], authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const request = await getBiddingRequest(req.params.id as string);
    res.json(request);
  } catch (err: any) {
    res.status(404).json({ message: err.message });
  }
});

// Provider submits an offer
router.post(["/requests/:id/offers", "/request/:id/offers", "/requests/:id/offer", "/request/:id/offer"], authMiddleware, requirePermission("bidding.offer"), async (req: AuthRequest, res: Response) => {
  const { amount, message, fareAmount } = req.body;
  const finalAmount = amount || fareAmount;
  if (!finalAmount || Number(finalAmount) <= 0) {
    return res.status(400).json({ message: "A positive offer amount is required" });
  }

  try {
    const offer = await submitOffer({
      biddingRequestId: req.params.id as string,
      providerId: req.user!.id,
      amount: Number(finalAmount),
      message,
    });
    res.status(201).json(offer);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// Customer accepts an offer
router.post("/offers/:id/accept", authMiddleware, requirePermission("bidding.accept"), async (req: AuthRequest, res: Response) => {
  try {
    const result = await acceptOffer(req.params.id as string, req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// AI Fair Price Negotiation Mediation for a Bidding Request
router.post("/requests/:id/mediate-price", authMiddleware, async (req: AuthRequest, res: Response) => {
  const { customerOffer, offerId, driverAsk } = req.body;
  try {
    const biddingReq = await getBiddingRequest(req.params.id as string);
    if (!biddingReq) return res.status(404).json({ message: "Bidding request not found" });

    let finalDriverAsk = driverAsk;
    if (offerId && !finalDriverAsk) {
      const offer = biddingReq.offers.find((o) => o.id === offerId);
      if (offer) finalDriverAsk = Number(offer.amount);
    }

    if (customerOffer === undefined || finalDriverAsk === undefined) {
      return res.status(400).json({ message: "customerOffer and driverAsk (or valid offerId) are required" });
    }

    const { mediateFairPrice } = await import("../core/ai/ai.service.js");
    const mediation = await mediateFairPrice({
      customerOffer: Number(customerOffer),
      driverAsk: Number(finalDriverAsk),
      pickupLat: biddingReq.pickupLat || undefined,
      pickupLng: biddingReq.pickupLng || undefined,
      dropoffLat: biddingReq.dropoffLat || undefined,
      dropoffLng: biddingReq.dropoffLng || undefined,
      serviceType: biddingReq.serviceType,
    });

    res.json({
      biddingRequestId: biddingReq.id,
      offerId,
      mediation,
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// Accept offer at the AI Mediated win-win price
router.post("/offers/:id/accept-mediated", authMiddleware, requirePermission("bidding.accept"), async (req: AuthRequest, res: Response) => {
  const { mediatedPrice } = req.body;
  if (!mediatedPrice || Number(mediatedPrice) <= 0) {
    return res.status(400).json({ message: "A positive mediatedPrice is required" });
  }

  try {
    const { db } = await import("../db.js");
    // Update offer to mediated price before accepting
    await db.offer.update({
      where: { id: req.params.id as string },
      data: {
        amount: Number(mediatedPrice),
        message: `Accepted at MoveX AI Mediated Fair Price ($${Number(mediatedPrice).toFixed(2)})`,
      },
    });

    const result = await acceptOffer(req.params.id as string, req.user!.id);
    res.json({
      ...result,
      mediatedPriceApplied: Number(mediatedPrice),
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
