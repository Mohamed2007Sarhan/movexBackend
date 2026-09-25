import { Router, Request, Response } from "express";
import { auth, AuthRequest } from "../../middleware/auth.js";
import { db } from "../../db.js";
import { sendSuccess, AppError, ErrorCode } from "../../core/errors/index.js";
import { calculateDistanceKm, estimateEtaMinutes } from "../../core/proximity/index.js";
import { emitToRoom } from "../../core/sockets/index.js";
import { planBRouteCalculation } from "../../core/resilience/index.js";

export const trackingRouter = Router();

/**
 * POST /api/tracking/location
 * Provider sends real-time GPS coordinate ping.
 */
trackingRouter.post("/location", auth, async (req: AuthRequest, res: Response, next) => {
  try {
    const { lat, lng, speed = 0, heading = 0 } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ message: "Numeric 'lat' and 'lng' are required" });
    }

    const userId = req.user!.id;

    // Update database
    const profile = await db.providerProfile.updateMany({
      where: { userId },
      data: {
        currentLat: lat,
        currentLng: lng,
        lastLocationUpdate: new Date(),
      },
    });

    const payload = {
      userId,
      lat,
      lng,
      speed,
      heading,
      timestamp: new Date().toISOString(),
    };

    // Emit to provider room
    emitToRoom(`provider:${userId}`, "location:update", payload);

    // Emit to any active orders where this user is the assigned provider
    const activeOrders = await db.order.findMany({
      where: {
        providerId: userId,
        status: { in: ["accepted", "in_progress"] },
      },
      select: { id: true, dropoffLat: true, dropoffLng: true },
    });

    for (const order of activeOrders) {
      let etaMinutes = 0;
      let distanceKm = 0;
      if (order.dropoffLat && order.dropoffLng) {
        distanceKm = calculateDistanceKm(lat, lng, order.dropoffLat, order.dropoffLng);
        etaMinutes = estimateEtaMinutes(distanceKm, Math.max(20, speed));
      }

      emitToRoom(`order:${order.id}`, "location:order_tracking", {
        orderId: order.id,
        driverLat: lat,
        driverLng: lng,
        speed,
        heading,
        distanceKm,
        etaMinutes,
        timestamp: new Date().toISOString(),
      });
    }

    return sendSuccess(res, {
      message: "Location updated and broadcasted successfully",
      coordinates: { lat, lng, speed, heading },
      activeOrdersNotified: activeOrders.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tracking/live-providers
 * Returns all active providers with coordinates for the live map.
 */
trackingRouter.get("/live-providers", async (_req: Request, res: Response, next) => {
  try {
    const providers = await db.providerProfile.findMany({
      where: {
        isAvailable: true,
        currentLat: { not: null },
        currentLng: { not: null },
      },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        serviceCategories: { include: { serviceCategory: true } },
      },
    });

    const mapped = providers.map((p) => ({
      providerId: p.id,
      userId: p.userId,
      name: p.user.name,
      phone: p.user.phone,
      vehicleType: p.vehicleType,
      lat: p.currentLat,
      lng: p.currentLng,
      lastUpdate: p.lastLocationUpdate,
      categories: p.serviceCategories.map((c) => c.serviceCategory.name),
    }));

    return sendSuccess(res, mapped);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tracking/order/:orderId
 * Returns complete trip geospatial telemetry, waypoints, and live driver location.
 */
trackingRouter.get("/order/:orderId", auth, async (req: AuthRequest, res: Response, next) => {
  try {
    const orderId = String(req.params.orderId);
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        provider: {
          select: {
            id: true,
            name: true,
            phone: true,
            providerProfile: true,
          },
        },
      },
    });

    if (!order) {
      throw new AppError("Order not found", 404, ErrorCode.NOT_FOUND);
    }

    const pickupLat = order.pickupLat ?? 30.0444;
    const pickupLng = order.pickupLng ?? 31.2357;
    const dropoffLat = order.dropoffLat ?? 30.0754;
    const dropoffLng = order.dropoffLng ?? 31.3204;

    const driverLat = order.provider?.providerProfile?.currentLat ?? pickupLat;
    const driverLng = order.provider?.providerProfile?.currentLng ?? pickupLng;

    const remainingDistanceKm = calculateDistanceKm(driverLat, driverLng, dropoffLat, dropoffLng);
    const etaMinutes = estimateEtaMinutes(remainingDistanceKm);

    // Calculate resilient route waypoints
    const routeInfo = await planBRouteCalculation(pickupLat, pickupLng, dropoffLat, dropoffLng);

    return sendSuccess(res, {
      orderId: order.id,
      serviceType: order.serviceType,
      status: order.status,
      customer: {
        id: order.user.id,
        name: order.user.name,
        phone: order.user.phone,
      },
      provider: order.provider
        ? {
            id: order.provider.id,
            name: order.provider.name,
            phone: order.provider.phone,
            vehicleType: order.provider.providerProfile?.vehicleType,
            currentLat: driverLat,
            currentLng: driverLng,
          }
        : null,
      pickup: { lat: pickupLat, lng: pickupLng, address: order.address },
      dropoff: { lat: dropoffLat, lng: dropoffLng },
      telemetry: {
        remainingDistanceKm,
        etaMinutes,
        speedKmh: 35,
      },
      route: routeInfo.data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tracking/simulate-step
 * Advances a driver along a trip route to showcase real-time map movement in tests.
 */
trackingRouter.post("/simulate-step", async (req: Request, res: Response, next) => {
  try {
    const { orderId, stepRatio } = req.body;
    if (!orderId || typeof stepRatio !== "number") {
      return res.status(400).json({ message: "orderId and numeric stepRatio (0.0 to 1.0) are required" });
    }

    const order = await db.order.findUnique({
      where: { id: String(orderId) },
      include: { provider: { include: { providerProfile: true } } },
    });

    if (!order || !order.provider) {
      throw new AppError("Order or assigned provider not found", 404, ErrorCode.NOT_FOUND);
    }

    const pLat = order.pickupLat ?? 30.0444;
    const pLng = order.pickupLng ?? 31.2357;
    const dLat = order.dropoffLat ?? 30.0754;
    const dLng = order.dropoffLng ?? 31.3204;

    const clampedRatio = Math.max(0, Math.min(1, stepRatio));
    const newLat = pLat + (dLat - pLat) * clampedRatio;
    const newLng = pLng + (dLng - pLng) * clampedRatio;

    // Update provider profile
    if (order.provider.providerProfile) {
      await db.providerProfile.update({
        where: { id: order.provider.providerProfile.id },
        data: {
          currentLat: newLat,
          currentLng: newLng,
          lastLocationUpdate: new Date(),
        },
      });
    }

    const remainingDistanceKm = calculateDistanceKm(newLat, newLng, dLat, dLng);
    const etaMinutes = estimateEtaMinutes(remainingDistanceKm);

    // Broadcast socket event
    emitToRoom(`order:${orderId}`, "location:order_tracking", {
      orderId,
      driverLat: newLat,
      driverLng: newLng,
      distanceKm: remainingDistanceKm,
      etaMinutes,
      progressRatio: clampedRatio,
      timestamp: new Date().toISOString(),
    });

    return sendSuccess(res, {
      orderId,
      stepRatio: clampedRatio,
      currentPosition: { lat: newLat, lng: newLng },
      remainingDistanceKm,
      etaMinutes,
    });
  } catch (err) {
    next(err);
  }
});
