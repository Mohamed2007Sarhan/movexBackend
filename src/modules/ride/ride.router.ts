import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { requirePermission } from "../../core/rbac/index.js";
import { requestRide } from "./ride.service.js";

const router = Router();

router.post(["/requests", "/request"], authMiddleware, requirePermission("order.create"), async (req: AuthRequest, res: Response) => {
  const { pickupLat, pickupLng, dropoffLat, dropoffLng, notes } = req.body;

  if (pickupLat === undefined || pickupLng === undefined || dropoffLat === undefined || dropoffLng === undefined) {
    return res.status(400).json({ message: "pickupLat, pickupLng, dropoffLat, and dropoffLng are required" });
  }

  try {
    const result = await requestRide({
      customerId: req.user!.id,
      pickupLat: Number(pickupLat),
      pickupLng: Number(pickupLng),
      dropoffLat: Number(dropoffLat),
      dropoffLng: Number(dropoffLng),
      notes,
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
