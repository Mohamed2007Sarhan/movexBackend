import { Router, Request, Response } from "express";
import { generateSuggestion } from "./ai.service.js";
import { authMiddleware, AuthRequest } from "../auth/auth.service.js";
import { sendSuccess } from "../errors/index.js";

const router = Router();

router.post("/suggest", authMiddleware, async (req: AuthRequest, res: Response, next) => {
  const { context } = req.body;
  const userId = req.body.userId || req.user?.id;

  if (!userId) {
    return res.status(400).json({ message: "userId is required" });
  }

  if (!context || typeof context !== "object") {
    return res.status(400).json({ message: "context object is required" });
  }

  try {
    const suggestion = await generateSuggestion({
      userId,
      orderId: req.body.orderId,
      context,
    });
    return sendSuccess(res, suggestion);
  } catch (err: any) {
    next(err);
  }
});

// MoveX AI Fair Price Negotiation & Bargaining Mediation
router.post("/mediate-price", async (req: Request, res: Response, next) => {
  const { customerOffer, driverAsk, pickupLat, pickupLng, dropoffLat, dropoffLng, distanceKm, serviceType } = req.body;

  if (customerOffer === undefined || driverAsk === undefined) {
    return res.status(400).json({ message: "customerOffer and driverAsk amounts are required" });
  }

  try {
    const { mediateFairPrice } = await import("./ai.service.js");
    const result = await mediateFairPrice({
      customerOffer: Number(customerOffer),
      driverAsk: Number(driverAsk),
      pickupLat: pickupLat ? Number(pickupLat) : undefined,
      pickupLng: pickupLng ? Number(pickupLng) : undefined,
      dropoffLat: dropoffLat ? Number(dropoffLat) : undefined,
      dropoffLng: dropoffLng ? Number(dropoffLng) : undefined,
      distanceKm: distanceKm ? Number(distanceKm) : undefined,
      serviceType,
    });
    return res.json({ success: true, data: result, ...result });
  } catch (err: any) {
    next(err);
  }
});

// MoveX AI Provider Matching from free-text task description
router.post("/match-providers", async (req: Request, res: Response, next) => {
  const { taskDescription, lat, lng, customerLat, customerLng, serviceType, maxDistanceKm } = req.body;
  if (!taskDescription) {
    return res.status(400).json({ message: "taskDescription is required" });
  }

  try {
    const { matchOptimalProviders } = await import("./ai.service.js");
    const result = await matchOptimalProviders({
      taskDescription,
      lat: lat ? Number(lat) : undefined,
      lng: lng ? Number(lng) : undefined,
      customerLat: customerLat ? Number(customerLat) : undefined,
      customerLng: customerLng ? Number(customerLng) : undefined,
      serviceType,
      maxDistanceKm: maxDistanceKm ? Number(maxDistanceKm) : undefined,
    });
    return res.json({ success: true, data: result, ...result });
  } catch (err: any) {
    next(err);
  }
});

// MoveX AI Bio and Profile Parser
router.post("/parse-bio", async (req: Request, res: Response, next) => {
  const { bio, profession, vehicleDetails, vehicleType } = req.body;
  try {
    const { parseProviderBio } = await import("./ai.service.js");
    const result = parseProviderBio({ bio, profession, vehicleDetails, vehicleType });
    return res.json({ success: true, data: result, ...result });
  } catch (err: any) {
    next(err);
  }
});

export default router;
