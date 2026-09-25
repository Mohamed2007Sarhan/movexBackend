import { Router, Response } from "express";
import { z } from "zod";
import { VehicleType } from "@prisma/client";
import { db } from "../../db.js";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { sendSuccess } from "../../core/errors/index.js";
import { validate } from "../../core/security/index.js";
import { findNearestProviders, updateProviderLocation } from "../../core/proximity/index.js";

const router = Router();

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const availabilitySchema = z.object({
  isAvailable: z.boolean(),
});

// View provider's own profile & vehicle details
router.get("/me", authMiddleware, async (req: AuthRequest, res: Response, next) => {
  try {
    const profile = await db.providerProfile.findUnique({
      where: { userId: req.user!.id },
      include: {
        serviceCategories: { include: { serviceCategory: true } },
      },
    });
    return sendSuccess(res, profile);
  } catch (err) {
    next(err);
  }
});

// Toggle availability
router.patch(
  "/me/availability",
  authMiddleware,
  validate({ body: availabilitySchema }),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const profile = await db.providerProfile.upsert({
        where: { userId: req.user!.id },
        update: { isAvailable: req.body.isAvailable },
        create: { userId: req.user!.id, isAvailable: req.body.isAvailable },
      });
      return sendSuccess(res, profile);
    } catch (err) {
      next(err);
    }
  }
);

// Update real-time GPS location
router.post(
  "/me/location",
  authMiddleware,
  validate({ body: locationSchema }),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const updated = await updateProviderLocation(req.user!.id, req.body.lat, req.body.lng);
      return sendSuccess(res, updated);
    } catch (err) {
      next(err);
    }
  }
);

// Proximity search: find nearest available providers
router.get("/nearby", async (req, res: Response, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const categoryId = req.query.categoryId as string | undefined;
    const vehicleType = req.query.vehicleType as VehicleType | undefined;
    const maxDistanceKm = req.query.maxDistance ? Number(req.query.maxDistance) : 30;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ message: "Valid 'lat' and 'lng' query parameters are required" });
    }

    const providers = await findNearestProviders({
      lat,
      lng,
      serviceCategoryId: categoryId,
      vehicleTypes: vehicleType ? [vehicleType] : undefined,
      maxDistanceKm,
      limit: 15,
    });

    return sendSuccess(res, providers, 200, { searchCenter: { lat, lng }, resultCount: providers.length });
  } catch (err) {
    next(err);
  }
});

export default router;
