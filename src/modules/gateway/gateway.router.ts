import { Router, Response } from "express";
import { auth, AuthRequest } from "../../middleware/auth.js";
import { db } from "../../db.js";
import { sendSuccess, AppError, ErrorCode } from "../../core/errors/index.js";
import { generateToken } from "../../core/auth/index.js";

export const gatewayRouter = Router();

export type AppMode = "customer" | "driver" | "worker" | "partner" | "admin";

/**
 * GET /api/gateway/context
 * Returns current user multi-mode profile, accessible roles, and active orders.
 */
gatewayRouter.get("/context", auth, async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        roles: { include: { role: true } },
        providerProfile: {
          include: {
            serviceCategories: { include: { serviceCategory: true } },
          },
        },
        vendors: true,
        wallet: true,
      },
    });

    if (!user) {
      throw new AppError("User not found", 404, ErrorCode.NOT_FOUND);
    }

    const assignedRoles = user.roles.map((r) => r.role.name.toLowerCase());
    
    // Determine eligible modes
    const eligibleModes: AppMode[] = ["customer"];
    if (assignedRoles.includes("driver") || user.providerProfile?.vehicleType) {
      eligibleModes.push("driver");
    }
    if (assignedRoles.includes("worker") || (user.providerProfile && !user.providerProfile.vehicleType)) {
      eligibleModes.push("worker");
    }
    if (assignedRoles.includes("partner") || user.vendors.length > 0) {
      eligibleModes.push("partner");
    }
    if (assignedRoles.includes("admin")) {
      eligibleModes.push("admin");
    }

    // Active orders as customer
    const activeCustomerOrders = await db.order.findMany({
      where: {
        userId,
        status: { in: ["pending", "matching", "accepted", "in_progress"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    // Active orders as provider
    const activeProviderOrders = await db.order.findMany({
      where: {
        providerId: userId,
        status: { in: ["accepted", "in_progress"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    return sendSuccess(res, {
      userId: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      eligibleModes,
      activeMode: (req.user as any).activeMode || "customer",
      wallet: {
        balance: user.wallet?.balance ? Number(user.wallet.balance) : 0,
        currency: user.wallet?.currency || "USD",
      },
      providerProfile: user.providerProfile
        ? {
            id: user.providerProfile.id,
            vehicleType: user.providerProfile.vehicleType,
            isAvailable: user.providerProfile.isAvailable,
            currentLat: user.providerProfile.currentLat,
            currentLng: user.providerProfile.currentLng,
          }
        : null,
      vendors: user.vendors.map((v) => ({ id: v.id, name: v.name, isOpen: v.isOpen })),
      activeCustomerOrdersCount: activeCustomerOrders.length,
      activeProviderOrdersCount: activeProviderOrders.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gateway/switch-mode
 * Seamlessly switch active application context in a single session without re-authenticating.
 */
gatewayRouter.post("/switch-mode", auth, async (req: AuthRequest, res: Response, next) => {
  try {
    const { targetMode } = req.body;
    if (!targetMode) {
      return res.status(400).json({ message: "targetMode is required ('customer', 'driver', 'worker', 'partner', 'admin')" });
    }

    const userId = req.user!.id;
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        roles: { include: { role: true } },
        providerProfile: true,
        vendors: true,
      },
    });

    if (!user) throw new AppError("User not found", 404, ErrorCode.NOT_FOUND);

    const assignedRoles = user.roles.map((r) => r.role.name.toLowerCase());

    // Validation for target modes
    if (targetMode === "admin" && !assignedRoles.includes("admin")) {
      throw new AppError("Access denied: You do not have administrator permissions", 403, ErrorCode.FORBIDDEN);
    }

    if (targetMode === "driver" && !user.providerProfile) {
      // Auto-provision provider profile if user has role or needs on-demand creation
      await db.providerProfile.create({
        data: {
          userId,
          isAvailable: true,
          vehicleType: "sedan",
          currentLat: 30.0444,
          currentLng: 31.2357,
        },
      });
    }

    const roleNames = user.roles.map((r) => r.role.name);
    const newToken = await generateToken({
      id: user.id,
      phone: user.phone,
      role: user.role,
      roles: roleNames,
      activeMode: targetMode,
    });

    return sendSuccess(res, {
      message: `Successfully switched session context to mode: ${targetMode}`,
      activeMode: targetMode,
      token: newToken,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
      },
    });
  } catch (err) {
    next(err);
  }
});
