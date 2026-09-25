import { Router, Response } from "express";
import { VehicleType } from "@prisma/client";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { requirePermission } from "../../core/rbac/index.js";
import { createMovingJob, getEligibleProvidersForVehicle } from "./moving.service.js";

const router = Router();

router.get("/vehicle-types", (_req, res: Response) => {
  res.json({
    vehicleTypes: Object.values(VehicleType),
    hierarchy: "sedan < pickup < van < small_truck < large_truck"
  });
});

router.post(["/jobs", "/orders"], authMiddleware, requirePermission("order.create"), async (req: AuthRequest, res: Response) => {
  const { requiredVehicleType, pickupAddress, dropoffAddress, itemsDescription, priceEstimate, pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;

  if (!requiredVehicleType || !pickupAddress || !dropoffAddress || !itemsDescription) {
    return res.status(400).json({
      message: "requiredVehicleType, pickupAddress, dropoffAddress, and itemsDescription are required",
    });
  }

  if (!Object.values(VehicleType).includes(requiredVehicleType)) {
    return res.status(400).json({
      message: `Invalid requiredVehicleType '${requiredVehicleType}'. Must be one of: ${Object.values(VehicleType).join(", ")}`,
    });
  }

  try {
    const result = await createMovingJob({
      customerId: req.user!.id,
      requiredVehicleType,
      pickupAddress,
      dropoffAddress,
      itemsDescription,
      priceEstimate: priceEstimate ? Number(priceEstimate) : undefined,
      pickupLat: pickupLat ? Number(pickupLat) : undefined,
      pickupLng: pickupLng ? Number(pickupLng) : undefined,
      dropoffLat: dropoffLat ? Number(dropoffLat) : undefined,
      dropoffLng: dropoffLng ? Number(dropoffLng) : undefined,
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/eligible-providers", authMiddleware, async (req: AuthRequest, res: Response) => {
  const vehicleType = req.query.vehicleType as VehicleType;
  if (!vehicleType || !Object.values(VehicleType).includes(vehicleType)) {
    return res.status(400).json({ message: "Valid vehicleType query parameter is required" });
  }

  try {
    const providers = await getEligibleProvidersForVehicle(vehicleType);
    res.json(providers);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
