import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { requirePermission } from "../../core/rbac/index.js";
import { listVendors, getVendor, calculateCart, checkout } from "./food.service.js";

const router = Router();

router.get("/vendors", async (_req, res: Response) => {
  try {
    const vendors = await listVendors();
    res.json(vendors);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/vendors/:id", async (req, res: Response) => {
  try {
    const vendor = await getVendor(req.params.id as string);
    res.json(vendor);
  } catch (err: any) {
    res.status(404).json({ message: err.message });
  }
});

router.post("/cart/calculate", async (req, res: Response) => {
  try {
    const calculation = await calculateCart(req.body.items);
    res.json(calculation);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

router.post(["/checkout", "/orders"], authMiddleware, requirePermission("order.create"), async (req: AuthRequest, res: Response) => {
  const { items, address, phone, deliveryUrgency, pickupLat, pickupLng, dropoffLat, dropoffLng } = req.body;
  if (!items || !items.length || !address || !phone) {
    return res.status(400).json({ message: "Incomplete order data: items, address, and phone are required" });
  }

  try {
    const order = await checkout({
      customerId: req.user!.id,
      items,
      address,
      phone,
      deliveryUrgency,
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
    });
    res.status(201).json(order);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 1. Restaurant/Vendor marks food ready -> triggers courier auto-dispatching based on urgency
router.post("/orders/:id/ready", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { markFoodReady } = await import("./food.service.js");
    const result = await markFoodReady(req.params.id as string);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 2. Courier marks food picked up from restaurant
router.post("/orders/:id/pickup", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { courierPickup } = await import("./food.service.js");
    const result = await courierPickup(req.params.id as string, req.user!.id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 3. Courier marks food delivered to customer
router.post("/orders/:id/courier-delivered", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { confirmFoodDelivered } = await import("./food.service.js");
    const result = await confirmFoodDelivered(req.params.id as string, "courier");
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 4. Customer confirms receipt of food -> completes order & triggers 3-way wallet settlement
router.post("/orders/:id/customer-received", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { confirmFoodDelivered } = await import("./food.service.js");
    const result = await confirmFoodDelivered(req.params.id as string, "customer");
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 5. Explicit Courier Dispatching query
router.post("/orders/:id/dispatch-courier", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { dispatchDeliveryCourier } = await import("./food.service.js");
    const result = await dispatchDeliveryCourier(req.params.id as string, req.body.urgency);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
