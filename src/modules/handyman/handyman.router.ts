import { Router, Response } from "express";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { requirePermission } from "../../core/rbac/index.js";
import { requestHandyman, listHandymanCategories } from "./handyman.service.js";

const router = Router();

router.get("/categories", async (_req, res: Response) => {
  try {
    const categories = await listHandymanCategories();
    res.json(categories);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post(["/requests", "/request"], authMiddleware, requirePermission("order.create"), async (req: AuthRequest, res: Response) => {
  const { serviceCategoryId, lat, lng, description } = req.body;

  if (!serviceCategoryId || !description) {
    return res.status(400).json({ message: "serviceCategoryId and description are required" });
  }

  try {
    const result = await requestHandyman({
      customerId: req.user!.id,
      serviceCategoryId,
      lat: lat ? Number(lat) : undefined,
      lng: lng ? Number(lng) : undefined,
      description,
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 1. Worker (Carpenter/Plumber) marks work completed directly
router.post("/orders/:id/worker-finish", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { db } = await import("../../db.js");
    const order = await db.order.findUnique({ where: { id: req.params.id as string } });
    if (!order) return res.status(404).json({ message: "Handyman order not found" });

    const updated = await db.order.update({
      where: { id: order.id },
      data: {
        workerFinishedAt: new Date(),
        vendorStatus: "work_completed",
      },
      include: { user: true, provider: true },
    });

    res.json({
      orderId: updated.id,
      status: updated.status,
      workerFinishedAt: updated.workerFinishedAt,
      message: "Worker marked work completed. Waiting for customer inspection and confirmation.",
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

// 2. Customer inspects and confirms work -> completes order and executes direct 2-party wallet settlement
router.post("/orders/:id/customer-confirm", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { db } = await import("../../db.js");
    const { OrderStatus } = await import("@prisma/client");
    const { settleOrder } = await import("../../core/wallet/wallet.service.js");

    const order = await db.order.findUnique({ where: { id: req.params.id as string } });
    if (!order) return res.status(404).json({ message: "Handyman order not found" });

    const now = new Date();
    const updated = await db.order.update({
      where: { id: order.id },
      data: {
        customerConfirmedAt: now,
        status: OrderStatus.completed,
        completedAt: now,
      },
      include: { user: true, provider: true },
    });

    // Execute direct 2-party settlement (Customer debited, Worker credited minus platform fee)
    const settlement = await settleOrder(order.id);

    res.json({
      orderId: updated.id,
      status: updated.status,
      customerConfirmedAt: updated.customerConfirmedAt,
      settlement,
      message: "Customer confirmed work completed. Direct 2-party payment settled successfully!",
    });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
