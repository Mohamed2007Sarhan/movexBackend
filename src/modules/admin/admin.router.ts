import { Router, Response } from "express";
import { auth, admin, AuthRequest } from "../../middleware/auth.js";
import { db } from "../../db.js";
import { sendSuccess, AppError, ErrorCode } from "../../core/errors/index.js";
import { advanceStatus } from "../../core/order-engine/index.js";
import { OrderStatus, ServiceType, TransactionType } from "@prisma/client";
import { credit, debit, getOrCreateWallet } from "../../core/wallet/index.js";
import { parseProviderBio } from "../../core/ai/index.js";
import {
  getConfigNumber,
  setConfig,
  listAllConfigs,
  CONFIG_KEYS,
  type ConfigKey,
} from "../../core/config/system-config.service.js";
import {
  getDriverPerformance,
  listLateDeliveries,
} from "../../core/delivery/delivery-eta.service.js";

export const adminRouter = Router();

// Protect ALL admin routes with authentication and admin role verification
adminRouter.use(auth);
adminRouter.use(admin);

// ---------------------------------------------------------------------------
// 1. Platform Statistics & Analytics Overview
// ---------------------------------------------------------------------------
adminRouter.get("/stats", async (_req: AuthRequest, res: Response, next) => {
  try {
    const [totalUsers, totalOrders, totalVendors, productCount, menuItemCount, totalTransactions, pendingKycCount, activeSosCount] =
      await Promise.all([
        db.user.count(),
        db.order.count(),
        db.vendor.count(),
        db.product.count(),
        db.menuItem.count(),
        db.walletTransaction.count(),
        db.providerKyc.count({ where: { status: "PENDING" } }),
        db.safetyAlert.count({ where: { status: "DISPATCHED" } }),
      ]);

    const walletSum = await db.walletAccount.aggregate({
      _sum: { balance: true },
    });

    return sendSuccess(res, {
      totalUsers,
      totalOrders,
      totalVendors,
      totalCatalogItems: productCount + menuItemCount,
      totalWalletTransactions: totalTransactions,
      totalPlatformWalletLiquidity: Number(walletSum._sum.balance || 0),
      pendingKycCount,
      activeSosCount,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 2. Dynamic Service Categories Management (Add ANY category to the system)
// ---------------------------------------------------------------------------
adminRouter.get("/categories", async (_req: AuthRequest, res: Response, next) => {
  try {
    const categories = await db.serviceCategory.findMany({
      include: {
        children: true,
        parent: true,
        _count: { select: { vendors: true, providers: true, orders: true } },
      },
      orderBy: { name: "asc" },
    });
    return sendSuccess(res, categories);
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/categories", async (req: AuthRequest, res: Response, next) => {
  try {
    const { name, parentId } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ message: "Category name is required" });
    }

    const category = await db.serviceCategory.create({
      data: {
        name: name.trim(),
        parentId: parentId || null,
      },
    });

    return sendSuccess(res, {
      message: `Category '${category.name}' created successfully. Available dynamically to all services.`,
      category,
    }, 201);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/categories/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const { name, parentId } = req.body;
    const updated = await db.serviceCategory.update({
      where: { id: req.params.id as string },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(parentId !== undefined ? { parentId: parentId || null } : {}),
      },
    });
    return sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

adminRouter.delete("/categories/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    await db.serviceCategory.delete({
      where: { id: req.params.id as string },
    });
    return sendSuccess(res, { message: `Category ${req.params.id} deleted successfully.` });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 3. Vendors & Store Partners Management
// ---------------------------------------------------------------------------
adminRouter.get("/vendors", async (_req: AuthRequest, res: Response, next) => {
  try {
    const vendors = await db.vendor.findMany({
      include: {
        category: true,
        owner: { select: { id: true, name: true, phone: true } },
        _count: { select: { menuItems: true } },
      },
      orderBy: { name: "asc" },
    });
    return sendSuccess(res, vendors);
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/vendors", async (req: AuthRequest, res: Response, next) => {
  try {
    const { name, categoryId, ownerUserId, address, isOpen = true } = req.body;
    if (!name || !categoryId || !ownerUserId || !address) {
      return res.status(400).json({ message: "name, categoryId, ownerUserId, and address are required" });
    }

    const vendor = await db.vendor.create({
      data: {
        name,
        categoryId,
        ownerUserId,
        address,
        isOpen,
      },
      include: { category: true, owner: { select: { name: true, phone: true } } },
    });

    return sendSuccess(res, {
      message: `Vendor '${vendor.name}' added to database.`,
      vendor,
    }, 201);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/vendors/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const updated = await db.vendor.update({
      where: { id: req.params.id as string },
      data: req.body,
    });
    return sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 4. Products & Menu Items Management (Catalog Operations)
// ---------------------------------------------------------------------------
adminRouter.get("/menu-items", async (req: AuthRequest, res: Response, next) => {
  try {
    const vendorId = req.query.vendorId as string | undefined;
    const items = await db.menuItem.findMany({
      where: vendorId ? { vendorId } : undefined,
      include: { vendor: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });
    return sendSuccess(res, items);
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/menu-items", async (req: AuthRequest, res: Response, next) => {
  try {
    const { vendorId, name, price, isAvailable = true } = req.body;
    if (!vendorId || !name || price === undefined) {
      return res.status(400).json({ message: "vendorId, name, and numeric price are required" });
    }

    const item = await db.menuItem.create({
      data: {
        vendorId,
        name: name.trim(),
        price: Number(price),
        isAvailable,
      },
      include: { vendor: { select: { name: true } } },
    });

    return sendSuccess(res, {
      message: `Menu item '${item.name}' added successfully to ${item.vendor.name}.`,
      item,
    }, 201);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/menu-items/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const { name, price, isAvailable } = req.body;
    const updated = await db.menuItem.update({
      where: { id: req.params.id as string },
      data: {
        ...(name ? { name: name.trim() } : {}),
        ...(price !== undefined ? { price: Number(price) } : {}),
        ...(isAvailable !== undefined ? { isAvailable } : {}),
      },
    });
    return sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

adminRouter.delete("/menu-items/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    await db.menuItem.delete({ where: { id: req.params.id as string } });
    return sendSuccess(res, { message: `Menu item ${req.params.id} deleted.` });
  } catch (err) {
    next(err);
  }
});

// Legacy Product endpoint support
adminRouter.post("/products", async (req: AuthRequest, res: Response, next) => {
  try {
    const { name, description, price, imageUrl, categoryId, vendorId } = req.body;
    const prod = await db.product.create({
      data: { name, description, price: Number(price), imageUrl, categoryId, vendorId },
    });
    return sendSuccess(res, prod, 201);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 5. Complete Financial & Wallet Audit Ledger (Company Oversight)
// ---------------------------------------------------------------------------
adminRouter.get("/wallet/ledger", async (req: AuthRequest, res: Response, next) => {
  try {
    const take = Number(req.query.limit) || 50;
    const skip = Number(req.query.offset) || 0;
    const type = req.query.type as TransactionType | undefined;

    const [total, transactions] = await Promise.all([
      db.walletTransaction.count({ where: type ? { type } : undefined }),
      db.walletTransaction.findMany({
        where: type ? { type } : undefined,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          walletAccount: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
            },
          },
          order: {
            select: { id: true, serviceType: true, status: true, total: true },
          },
        },
      }),
    ]);

    return sendSuccess(res, {
      total,
      limit: take,
      offset: skip,
      transactions: transactions.map((t) => ({
        id: t.id,
        amount: Number(t.amount),
        type: t.type,
        description: t.description,
        user: t.walletAccount?.user,
        orderId: t.orderId,
        serviceType: t.order?.serviceType,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Admin manual balance adjustment with audit trail
adminRouter.post("/wallet/adjust", async (req: AuthRequest, res: Response, next) => {
  try {
    const { userId, amount, action = "credit", reason } = req.body;
    if (!userId || !amount || !reason) {
      return res.status(400).json({ message: "userId, numeric amount, and mandatory reason are required" });
    }

    const wallet = await getOrCreateWallet(userId);
    const numAmount = Math.abs(Number(amount));

    let result;
    if (action === "debit") {
      result = await debit(
        wallet.id,
        numAmount,
        TransactionType.payout,
        undefined,
        `[Admin Adjustment] ${reason} (Authorized by ${req.user!.phone})`
      );
    } else {
      result = await credit(
        wallet.id,
        numAmount,
        TransactionType.topup,
        undefined,
        `[Admin Adjustment] ${reason} (Authorized by ${req.user!.phone})`
      );
    }

    return sendSuccess(res, {
      message: `Admin adjustment executed: ${action} of $${numAmount}`,
      userId,
      newBalance: Number(result.wallet.balance),
      transaction: result.transaction,
    }, 201);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 6. Dynamic Commission Rules Management
// ---------------------------------------------------------------------------
adminRouter.get("/commission-rules", async (_req: AuthRequest, res: Response, next) => {
  try {
    const rules = await db.commissionRule.findMany({ orderBy: { serviceType: "asc" } });
    return sendSuccess(res, rules);
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/commission-rules", async (req: AuthRequest, res: Response, next) => {
  try {
    const { serviceType, percentage } = req.body;
    if (!serviceType || percentage === undefined) {
      return res.status(400).json({ message: "serviceType and percentage are required" });
    }

    const rule = await db.commissionRule.upsert({
      where: { serviceType: serviceType as ServiceType },
      update: {
        percentage: Number(percentage),
      },
      create: {
        serviceType: serviceType as ServiceType,
        percentage: Number(percentage),
      },
    });

    return sendSuccess(res, {
      message: `Commission rule for ${serviceType} updated to ${percentage}%`,
      rule,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 7. Driver KYC Review & Approvals
// ---------------------------------------------------------------------------
adminRouter.get("/kyc", async (req: AuthRequest, res: Response, next) => {
  try {
    const status = req.query.status as string | undefined;
    const submissions = await db.providerKyc.findMany({
      where: status ? { status } : undefined,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            providerProfile: true,
          },
        },
      },
      orderBy: { submittedAt: "desc" },
    });
    return sendSuccess(res, submissions);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/kyc/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const { status } = req.body;
    if (!status || !["APPROVED", "REJECTED", "PENDING"].includes(status)) {
      return res.status(400).json({ message: "Valid status ('APPROVED', 'REJECTED', 'PENDING') is required" });
    }

    const updated = await db.providerKyc.update({
      where: { id: req.params.id as string },
      data: {
        status,
        reviewedAt: new Date(),
      },
    });

    return sendSuccess(res, {
      message: `KYC submission ${updated.id} status updated to ${status}.`,
      kyc: updated,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 8. Safety & Emergency Incidents Oversight
// ---------------------------------------------------------------------------
adminRouter.get("/safety/incidents", async (_req: AuthRequest, res: Response, next) => {
  try {
    const incidents = await db.safetyAlert.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, serviceType: true, status: true, address: true } },
      },
    });
    return sendSuccess(res, incidents);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/safety/incidents/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const { status } = req.body;
    const updated = await db.safetyAlert.update({
      where: { id: req.params.id as string },
      data: { status },
    });
    return sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 9. Orders Oversight & Status Override
// ---------------------------------------------------------------------------
adminRouter.get("/orders", async (_req: AuthRequest, res: Response, next) => {
  try {
    const orders = await db.order.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        provider: { select: { id: true, name: true, phone: true } },
        items: { include: { product: true } },
      },
      take: 50,
    });
    return sendSuccess(res, orders);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch("/orders/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const { status } = req.body;
    const updated = await advanceStatus(req.params.id as string, status as OrderStatus);
    return sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 10. Role Requests Review & Approval Workflow
// ---------------------------------------------------------------------------
adminRouter.get("/role-requests", async (req: AuthRequest, res: Response, next) => {
  try {
    const status = req.query.status as string | undefined;
    const requests = await db.roleRequest.findMany({
      where: status ? { status } : undefined,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            role: true,
            roles: { include: { role: true } },
            providerProfile: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return sendSuccess(res, requests);
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/role-requests/:id/approve", async (req: AuthRequest, res: Response, next) => {
  try {
    const request = await db.roleRequest.findUnique({
      where: { id: req.params.id as string },
      include: { user: true },
    });

    if (!request) {
      throw new AppError("RoleRequest not found", 404, ErrorCode.NOT_FOUND);
    }

    if (request.status !== "PENDING") {
      throw new AppError(`Cannot approve request with status '${request.status}'`, 400, "INVALID_STATUS");
    }

    const targetRoleName = request.requestedRole.toLowerCase();

    // 1. Ensure Role exists in DB
    const roleRecord = await db.role.upsert({
      where: { name: targetRoleName },
      update: {},
      create: {
        name: targetRoleName,
      },
    });

    // 2. Link user to role
    await db.userRole.upsert({
      where: {
        userId_roleId: {
          userId: request.userId,
          roleId: roleRecord.id,
        },
      },
      update: {},
      create: {
        roleId: roleRecord.id,
        userId: request.userId,
      },
    });

    // 3. Update primary User role string
    await db.user.update({
      where: { id: request.userId },
      data: { role: targetRoleName.toUpperCase() },
    });

    // 4. If driver or worker, grant 1500 EGP overdraft limit
    const isDriverOrWorker = ["driver", "worker"].includes(targetRoleName);
    if (isDriverOrWorker) {
      const wallet = await getOrCreateWallet(request.userId);
      // Use SystemConfig for overdraft limit — admin can change this without redeployment
      const cfgKey = targetRoleName === "driver" ? CONFIG_KEYS.DRIVER_OVERDRAFT_LIMIT : CONFIG_KEYS.WORKER_OVERDRAFT_LIMIT;
      const configuredLimit = await getConfigNumber(cfgKey, 1500);
      if (Number(wallet.overdraftLimit) < configuredLimit) {
        await db.walletAccount.update({
          where: { id: wallet.id },
          data: { overdraftLimit: configuredLimit },
        });
      }
    }

    // 5. Update or create ProviderProfile with AI bio analysis if available
    let bioAnalysis: any = null;
    if (request.bio) {
      bioAnalysis = parseProviderBio(request.bio);
    }

    const finalVehicleType = bioAnalysis?.vehicleType || null;
    const finalProfession = request.profession || bioAnalysis?.profession || (isDriverOrWorker ? (targetRoleName === "driver" ? "سائق" : "فني") : null);
    const finalSkills = bioAnalysis?.skills || [];

    await db.providerProfile.upsert({
      where: { userId: request.userId },
      update: {
        ...(finalVehicleType ? { vehicleType: finalVehicleType } : {}),
        ...(finalProfession ? { profession: finalProfession } : {}),
        ...(request.vehicleDetails ? { vehicleDetails: request.vehicleDetails } : {}),
        ...(request.bio ? { bio: request.bio } : {}),
        ...(finalSkills.length > 0 ? { skills: finalSkills } : {}),
      },
      create: {
        userId: request.userId,
        vehicleType: finalVehicleType,
        profession: finalProfession,
        vehicleDetails: request.vehicleDetails || (finalVehicleType ? `Auto-detected ${finalVehicleType}` : undefined),
        bio: request.bio,
        skills: finalSkills,
      },
    });

    // 6. Update RoleRequest status
    const updatedRequest = await db.roleRequest.update({
      where: { id: request.id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        adminNotes: req.body.adminNotes || "Approved by administrator",
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            role: true,
            roles: { include: { role: true } },
            providerProfile: true,
          },
        },
      },
    });

    return sendSuccess(res, {
      message: `Role request approved. User ${request.user.name} upgraded to '${targetRoleName}'.`,
      request: updatedRequest,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/role-requests/:id/reject", async (req: AuthRequest, res: Response, next) => {
  try {
    const request = await db.roleRequest.findUnique({
      where: { id: req.params.id as string },
    });

    if (!request) {
      throw new AppError("RoleRequest not found", 404, ErrorCode.NOT_FOUND);
    }

    if (request.status !== "PENDING") {
      throw new AppError(`Cannot reject request with status '${request.status}'`, 400, "INVALID_STATUS");
    }

    const updated = await db.roleRequest.update({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        adminNotes: req.body.reason || req.body.adminNotes || "Rejected by administrator",
      },
    });

    return sendSuccess(res, {
      message: `Role request ${updated.id} rejected.`,
      request: updated,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 11. System Configuration — Admin Control of All Platform Settings
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/system-config
 * List all platform configuration values (with defaults and admin customizations merged).
 */
adminRouter.get("/system-config", async (_req: AuthRequest, res: Response, next) => {
  try {
    const configs = await listAllConfigs();
    return sendSuccess(res, {
      configs,
      totalKeys: configs.length,
      customizedCount: configs.filter((c) => c.isCustomized).length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/system-config/:key
 * Update a specific platform configuration value.
 * Body: { value: string }
 */
adminRouter.patch("/system-config/:key", async (req: AuthRequest, res: Response, next) => {
  try {
    const key = req.params.key as string;
    const { value } = req.body;

    if (!value || typeof value !== "string") {
      return res.status(400).json({ success: false, message: "Field 'value' is required (string)" });
    }

    // Validate numeric fields
    const numericKeys = [
      CONFIG_KEYS.DRIVER_OVERDRAFT_LIMIT, CONFIG_KEYS.WORKER_OVERDRAFT_LIMIT,
      CONFIG_KEYS.DEFAULT_COMMISSION_PCT, CONFIG_KEYS.FOOD_VENDOR_FEE_PCT,
      CONFIG_KEYS.FOOD_COURIER_FEE_PCT, CONFIG_KEYS.TOPUP_MIN_AMOUNT,
      CONFIG_KEYS.TOPUP_MAX_AMOUNT, CONFIG_KEYS.TOPUP_AI_CONFIDENCE_THRESHOLD,
      CONFIG_KEYS.SPEED_WALKING_KMH, CONFIG_KEYS.SPEED_BICYCLE_KMH,
      CONFIG_KEYS.SPEED_MOTORCYCLE_KMH, CONFIG_KEYS.SPEED_SEDAN_KMH,
      CONFIG_KEYS.SPEED_VAN_KMH, CONFIG_KEYS.SPEED_TRUCK_KMH,
      CONFIG_KEYS.LATE_DELIVERY_GRACE_MINUTES, CONFIG_KEYS.ETA_BUFFER_MINUTES,
    ] as string[];

    if (numericKeys.includes(key) && isNaN(parseFloat(value))) {
      return res.status(400).json({ success: false, message: `Config key '${key}' requires a numeric value` });
    }

    const adminId = req.user?.id;
    await setConfig(key as ConfigKey, value.trim(), adminId);

    return sendSuccess(res, {
      message: `System config '${key}' updated to '${value}'`,
      key,
      value,
      updatedBy: adminId,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/system-config/bulk
 * Update multiple config keys at once.
 * Body: { updates: { key: string, value: string }[] }
 */
adminRouter.post("/system-config/bulk", async (req: AuthRequest, res: Response, next) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, message: "Field 'updates' must be a non-empty array" });
    }

    const adminId = req.user?.id;
    const results: { key: string; value: string; status: string }[] = [];

    for (const { key, value } of updates) {
      if (!key || !value) continue;
      try {
        await setConfig(key as ConfigKey, String(value).trim(), adminId);
        results.push({ key, value, status: "updated" });
      } catch (e) {
        results.push({ key, value, status: "error" });
      }
    }

    return sendSuccess(res, { results, updatedCount: results.filter((r) => r.status === "updated").length });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 12. Wallet Topup Request Review (Proof-of-Transfer Verification)
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/wallet/topup-requests
 * List all wallet topup requests with filters.
 * Query: ?status=PENDING|APPROVED|REJECTED|AI_FLAGGED
 */
adminRouter.get("/wallet/topup-requests", async (req: AuthRequest, res: Response, next) => {
  try {
    const { status, limit = "50", skip = "0" } = req.query as Record<string, string>;

    const requests = await db.walletTopupRequest.findMany({
      where: {
        ...(status ? { status } : {}),
      },
      include: {
        walletAccount: {
          include: {
            user: { select: { id: true, name: true, phone: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit),
      skip: parseInt(skip),
    });

    const total = await db.walletTopupRequest.count({
      where: status ? { status } : {},
    });

    return sendSuccess(res, { requests, total, pendingCount: requests.filter((r) => r.status === "PENDING" || r.status === "AI_FLAGGED").length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/wallet/topup-requests/:id/approve
 * Admin manually approves a topup request and credits the wallet.
 * Body: { adminNotes?: string }
 */
adminRouter.post("/wallet/topup-requests/:id/approve", async (req: AuthRequest, res: Response, next) => {
  try {
    const { id } = req.params as { id: string };
    const topupRequest = await db.walletTopupRequest.findUnique({
      where: { id },
      include: { walletAccount: { include: { user: true } } },
    });

    if (!topupRequest) {
      throw new AppError("Topup request not found", 404, ErrorCode.NOT_FOUND);
    }

    if (topupRequest.status === "APPROVED") {
      throw new AppError("This topup request has already been approved and credited", 400, "ALREADY_APPROVED");
    }

    if (topupRequest.status === "REJECTED") {
      throw new AppError("Cannot approve a rejected topup request", 400, "ALREADY_REJECTED");
    }

    // Credit the wallet
    await credit(
      topupRequest.walletAccountId,
      Number(topupRequest.declaredAmount),
      TransactionType.topup,
      undefined,
      `Wallet top-up approved by admin via ${topupRequest.paymentMethod} [Request: ${id}]`,
      undefined,
      {
        referenceId: id,
        senderName: `${topupRequest.paymentMethod.toUpperCase()} Transfer (Admin Approved)`,
        recipientName: topupRequest.walletAccount.user.name,
        status: "COMPLETED",
      }
    );

    const updated = await db.walletTopupRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        adminNotes: req.body.adminNotes || "Approved by admin after manual review",
        reviewedBy: req.user?.id,
        reviewedAt: new Date(),
        creditedAt: new Date(),
      },
    });

    return sendSuccess(res, {
      message: `Topup request approved. ${Number(topupRequest.declaredAmount)} EGP credited to ${topupRequest.walletAccount.user.name}'s wallet.`,
      creditedAmount: Number(topupRequest.declaredAmount),
      request: updated,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/wallet/topup-requests/:id/reject
 * Admin manually rejects a suspicious topup request.
 * Body: { reason: string }
 */
adminRouter.post("/wallet/topup-requests/:id/reject", async (req: AuthRequest, res: Response, next) => {
  try {
    const { id } = req.params as { id: string };
    const topupRequest = await db.walletTopupRequest.findUnique({ where: { id } });

    if (!topupRequest) {
      throw new AppError("Topup request not found", 404, ErrorCode.NOT_FOUND);
    }

    if (topupRequest.status === "APPROVED") {
      throw new AppError("Cannot reject an already approved and credited request", 400, "ALREADY_APPROVED");
    }

    const updated = await db.walletTopupRequest.update({
      where: { id },
      data: {
        status: "REJECTED",
        adminNotes: req.body.reason || req.body.adminNotes || "Rejected by administrator",
        reviewedBy: req.user?.id,
        reviewedAt: new Date(),
      },
    });

    return sendSuccess(res, {
      message: "Topup request rejected. User will not be credited.",
      request: updated,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 13. Driver Performance & Late Delivery Monitoring
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/drivers/performance
 * List all drivers with their performance stats (on-time rate, late count).
 */
adminRouter.get("/drivers/performance", async (_req: AuthRequest, res: Response, next) => {
  try {
    const driverRole = await db.role.findUnique({ where: { name: "driver" } });
    if (!driverRole) return sendSuccess(res, []);

    const drivers = await db.userRole.findMany({
      where: { roleId: driverRole.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            providerProfile: {
              select: {
                vehicleType: true,
                totalDeliveries: true,
                lateDeliveries: true,
                avgRating: true,
                isAvailable: true,
              },
            },
          },
        },
      },
    });

    const stats = drivers.map(({ user }) => {
      const profile = user.providerProfile;
      const lateRate =
        profile && profile.totalDeliveries > 0
          ? Math.round((profile.lateDeliveries / profile.totalDeliveries) * 100)
          : 0;
      return {
        userId: user.id,
        name: user.name,
        phone: user.phone,
        vehicleType: profile?.vehicleType,
        isAvailable: profile?.isAvailable,
        totalDeliveries: profile?.totalDeliveries ?? 0,
        lateDeliveries: profile?.lateDeliveries ?? 0,
        onTimeDeliveries: (profile?.totalDeliveries ?? 0) - (profile?.lateDeliveries ?? 0),
        lateDeliveryRate: `${lateRate}%`,
        performanceScore: Math.max(0, 100 - lateRate),
        avgRating: profile?.avgRating ? Number(profile.avgRating) : null,
      };
    });

    // Sort by performance score ascending (worst first for admin attention)
    stats.sort((a, b) => a.performanceScore - b.performanceScore);

    return sendSuccess(res, { drivers: stats, totalDrivers: stats.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/drivers/:userId/performance
 * Detailed performance for a specific driver.
 */
adminRouter.get("/drivers/:userId/performance", async (req: AuthRequest, res: Response, next) => {
  try {
    const data = await getDriverPerformance(req.params.userId as string);
    if (!data) throw new AppError("Driver profile not found", 404, ErrorCode.NOT_FOUND);
    return sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/deliveries/late
 * List all late deliveries across the platform.
 * Query: ?driverUserId=...&minLateMinutes=5&limit=50
 */
adminRouter.get("/deliveries/late", async (req: AuthRequest, res: Response, next) => {
  try {
    const { driverUserId, minLateMinutes, limit } = req.query as Record<string, string>;
    const lateOrders = await listLateDeliveries({
      driverUserId: driverUserId || undefined,
      minLateMinutes: minLateMinutes ? parseInt(minLateMinutes) : 0,
      limit: limit ? parseInt(limit) : 50,
    });
    return sendSuccess(res, { lateOrders, count: lateOrders.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/drivers/:userId/reset-stats
 * Reset a driver's performance statistics (fresh start after warning).
 */
adminRouter.post("/drivers/:userId/reset-stats", async (req: AuthRequest, res: Response, next) => {
  try {
    const profile = await db.providerProfile.findUnique({
      where: { userId: req.params.userId as string },
    });
    if (!profile) throw new AppError("Driver profile not found", 404, ErrorCode.NOT_FOUND);

    await db.providerProfile.update({
      where: { userId: req.params.userId as string },
      data: { totalDeliveries: 0, lateDeliveries: 0 },
    });

    return sendSuccess(res, {
      message: "Driver performance statistics reset successfully",
      driverUserId: req.params.userId,
    });
  } catch (err) {
    next(err);
  }
});
