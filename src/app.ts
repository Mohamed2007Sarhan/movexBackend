import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./db.js";
import { auth, admin, AuthRequest } from "./middleware/auth.js";
import { generateToken, hashPassword, comparePassword } from "./core/auth/index.js";
import { requirePermission } from "./core/rbac/index.js";
import {
  getOrCreateWallet,
  getBalance,
  credit,
  topupWallet,
  transferBetweenWallets,
  setWalletPin,
  requestMoney,
  payTransferRequest,
  rejectTransferRequest,
  listTransferRequests,
  getTransactionReceipt,
} from "./core/wallet/index.js";
import { parseProviderBio } from "./core/ai/index.js";
import { createOrder, advanceStatus, cancelOrder, getOrder } from "./core/order-engine/index.js";
import { OrderStatus, ServiceType, TransactionType } from "@prisma/client";

// Core Security & Error Infrastructure
import {
  securityHeaders,
  requestIdMiddleware,
  apiRateLimiter,
  authRateLimiter,
  walletRateLimiter,
} from "./core/security/index.js";
import { globalErrorHandler, sendSuccess, AppError, ErrorCode } from "./core/errors/index.js";

import path from "path";
import swaggerRouter from "./core/docs/swagger.js";
import { foodRouter } from "./modules/food/index.js";
import { rideRouter } from "./modules/ride/index.js";
import { handymanRouter } from "./modules/handyman/index.js";
import { movingRouter } from "./modules/moving/index.js";
import { biddingRouter } from "./bidding/index.js";
import { aiRouter } from "./core/ai/index.js";
import usersRouter from "./modules/users/users.router.js";
import providersRouter from "./modules/providers/providers.router.js";
import reviewsRouter from "./modules/reviews/reviews.router.js";
import promotionsRouter from "./modules/promotions/promotions.router.js";
import { gatewayRouter } from "./modules/gateway/gateway.router.js";
import { trackingRouter } from "./modules/tracking/tracking.router.js";
import { safetyRouter } from "./modules/safety/safety.router.js";
import { resilienceRouter } from "./modules/resilience/resilience.router.js";
import { adminRouter } from "./modules/admin/admin.router.js";
import { seedDefaultConfigs } from "./core/config/system-config.service.js";
import {
  initiateTopup,
  submitTopupProof,
  getTopupHistory,
} from "./core/wallet/wallet-topup.service.js";
import {
  attachEtaToOrder,
  checkAndFlagLateDelivery,
  calculateEta,
} from "./core/delivery/delivery-eta.service.js";


const app = express();

// 1. Security & Pre-processing Middlewares
app.use(securityHeaders);
app.use(requestIdMiddleware);
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || true }));
app.use(express.json({ limit: "2mb" }));
app.use(apiRateLimiter);

// 2. Interactive Web Test Console & Live Map Dashboard
const publicDir = path.resolve(process.cwd(), "public");
app.use(express.static(publicDir));
app.use("/console", express.static(publicDir));
app.get(["/", "/console"], (_req, res, next) => {
  if (_req.accepts("html")) {
    return res.sendFile(path.join(publicDir, "index.html"));
  }
  next();
});

// 3. Interactive API Documentation (OpenAPI / Swagger UI)
app.use("/api-docs", swaggerRouter);

// 4. Health Check
app.get("/health", (_req, res) => {
  return sendSuccess(res, { status: "healthy", version: "2.0.0-movex", service: "MoveX Backend Platform" });
});

// -------------------------------------------------------------
// Core Services & Modules Routing
// -------------------------------------------------------------
app.use("/api/admin", adminRouter);
app.use("/api/gateway", gatewayRouter);
app.use("/api/tracking", trackingRouter);
app.use("/api/safety", safetyRouter);
app.use("/api/resilience", resilienceRouter);
app.use("/api/users", usersRouter);
app.use("/api/providers", providersRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/promotions", promotionsRouter);
app.use("/api/food", foodRouter);
app.use("/api/ride", rideRouter);
app.use("/api/handyman", handymanRouter);
app.use("/api/moving", movingRouter);
app.use("/api/bidding", biddingRouter);
app.use("/bidding", biddingRouter); // Top-level bidding route per spec
app.use("/api/ai", aiRouter);
app.use("/ai", aiRouter); // Top-level ai route per spec

// -------------------------------------------------------------
// Unified Order Engine Routes
// -------------------------------------------------------------
app.get("/api/orders/:id", auth, async (req: AuthRequest, res, next) => {
  try {
    const order = await getOrder(req.params.id as string);
    return sendSuccess(res, order);
  } catch (err) {
    next(err);
  }
});

app.post("/api/orders/:id/status", auth, async (req: AuthRequest, res, next) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ message: "next status is required" });
  try {
    const updated = await advanceStatus(req.params.id as string, status as OrderStatus);

    // Fire-and-forget: Attach ETA if order just got a provider assigned
    if (
      status === "accepted" ||
      status === "in_progress" ||
      status === "CONFIRMED" ||
      status === "PREPARING"
    ) {
      attachEtaToOrder(updated.id).catch((e) => console.error("[ETA attach]", e));
    }

    // Fire-and-forget: Check for late delivery when order completes
    if (
      status === "completed" ||
      status === "DELIVERED" ||
      status === "customerReceivedAt"
    ) {
      checkAndFlagLateDelivery(updated.id).catch((e) => console.error("[late check]", e));
    }

    return sendSuccess(res, updated);
  } catch (err) {
    next(err);
  }
});

app.post("/api/orders/:id/cancel", auth, requirePermission("order.cancel"), async (req: AuthRequest, res, next) => {
  try {
    const cancelled = await cancelOrder(req.params.id as string, req.body.reason);
    return sendSuccess(res, cancelled);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Wallet Routes (Hardened & Rate-Limited)
// -------------------------------------------------------------
app.get("/api/wallet/balance", auth, async (req: AuthRequest, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user!.id);
    const balance = await getBalance(wallet.id);
    return sendSuccess(res, { walletAccountId: wallet.id, balance, currency: wallet.currency });
  } catch (err) {
    next(err);
  }
});

app.get("/api/wallet/transactions", auth, async (req: AuthRequest, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user!.id);
    const transactions = await db.walletTransaction.findMany({
      where: { walletAccountId: wallet.id },
      orderBy: { createdAt: "desc" },
    });
    return sendSuccess(res, transactions);
  } catch (err) {
    next(err);
  }
});

// ── NEW: Initiate topup — show platform payment numbers, create pending request
app.post("/api/wallet/topup/initiate", auth, walletRateLimiter, async (req: AuthRequest, res, next) => {
  const { paymentMethod, declaredAmount } = req.body;
  const numAmount = Number(declaredAmount);
  if (!paymentMethod || !numAmount || numAmount <= 0) {
    return res.status(400).json({ message: "paymentMethod and positive declaredAmount are required" });
  }
  if (!["instapay", "vodafone_cash", "bank_transfer"].includes(paymentMethod)) {
    return res.status(400).json({ message: "paymentMethod must be one of: instapay, vodafone_cash, bank_transfer" });
  }
  try {
    const result = await initiateTopup({
      userId: req.user!.id,
      paymentMethod: paymentMethod as "instapay" | "vodafone_cash" | "bank_transfer",
      declaredAmount: numAmount,
    });
    return sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
});

// ── NEW: Submit proof — user uploads screenshot or describes the transfer
app.post("/api/wallet/topup/submit-proof", auth, walletRateLimiter, async (req: AuthRequest, res, next) => {
  const { requestId, proofImageUrl, proofText } = req.body;
  if (!requestId) {
    return res.status(400).json({ message: "requestId from the initiate step is required" });
  }
  if (!proofImageUrl && !proofText) {
    return res.status(400).json({ message: "At least one of proofImageUrl or proofText must be provided" });
  }
  try {
    const result = await submitTopupProof({
      userId: req.user!.id,
      requestId,
      proofImageUrl,
      proofText,
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

// ── NEW: Get topup history for user
app.get("/api/wallet/topup/history", auth, async (req: AuthRequest, res, next) => {
  try {
    const history = await getTopupHistory(req.user!.id);
    return sendSuccess(res, { topupRequests: history, count: history.length });
  } catch (err) {
    next(err);
  }
});

// ── LEGACY: Direct topup (kept for admin/test use only — no proof verification)
app.post("/api/wallet/topup", auth, walletRateLimiter, async (req: AuthRequest, res, next) => {
  const { amount, paymentMethod, referenceId } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ message: "A positive topup amount is required" });
  }

  try {
    const result = await topupWallet(
      req.user!.id,
      numAmount,
      referenceId || `ref_${Date.now()}`,
      paymentMethod || "card"
    );
    return sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
});


// Set or update 4-6 digit wallet transaction PIN
app.post("/api/wallet/set-pin", auth, async (req: AuthRequest, res, next) => {
  try {
    const { pin } = req.body;
    const result = await setWalletPin(req.user!.id, pin);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

// P2P Wallet Transfer / Send Money with PIN verification & double-entry ledger audit
app.post(["/api/wallet/transfer", "/api/wallet/send"], auth, walletRateLimiter, async (req: AuthRequest, res, next) => {
  const recipient = req.body.recipient || req.body.recipientIdentifier || req.body.toPhone || req.body.toUserId;
  const { amount, notes, referenceId, pin } = req.body;
  const numAmount = Number(amount);
  if (!recipient || !numAmount || numAmount <= 0) {
    return res.status(400).json({ message: "Recipient (phone or userId) and positive amount are required" });
  }

  try {
    const result = await transferBetweenWallets({
      senderUserId: req.user!.id,
      recipientIdentifier: String(recipient),
      amount: numAmount,
      notes,
      referenceId,
      pin,
    });
    return sendSuccess(res, result, 200);
  } catch (err) {
    next(err);
  }
});

// Request money from another user by phone
app.post("/api/wallet/request-money", auth, walletRateLimiter, async (req: AuthRequest, res, next) => {
  try {
    const { payerPhone, toPhone, amount, note, notes } = req.body;
    const phone = payerPhone || toPhone;
    const numAmount = Number(amount);
    if (!phone || !numAmount || numAmount <= 0) {
      return res.status(400).json({ message: "payerPhone and positive amount are required" });
    }
    const result = await requestMoney({
      requesterUserId: req.user!.id,
      payerPhone: phone,
      amount: numAmount,
      note: note || notes,
    });
    return sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
});

// List money transfer requests (incoming / outgoing / all)
app.get("/api/wallet/requests", auth, async (req: AuthRequest, res, next) => {
  try {
    const type = (req.query.type as "incoming" | "outgoing" | "all") || "all";
    const requests = await listTransferRequests(req.user!.id, type);
    return sendSuccess(res, requests);
  } catch (err) {
    next(err);
  }
});

// Pay a transfer request
app.post("/api/wallet/requests/:id/pay", auth, walletRateLimiter, async (req: AuthRequest, res, next) => {
  try {
    const { pin } = req.body;
    const result = await payTransferRequest({
      requestId: req.params.id as string,
      payerUserId: req.user!.id,
      pin,
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

// Reject a transfer request
app.post("/api/wallet/requests/:id/reject", auth, async (req: AuthRequest, res, next) => {
  try {
    const { reason } = req.body;
    const result = await rejectTransferRequest({
      requestId: req.params.id as string,
      payerUserId: req.user!.id,
      reason,
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

// Detailed official audit receipt lookup by transaction ID
app.get(["/api/wallet/transactions/:id", "/api/wallet/transactions/:id/receipt"], auth, async (req: AuthRequest, res, next) => {
  try {
    const receipt = await getTransactionReceipt(req.params.id as string);
    return sendSuccess(res, receipt);
  } catch (err) {
    next(err);
  }
});

// Admin-only wallet payout approve (RBAC guarded)
app.post("/api/wallet/payout/approve", auth, requirePermission("wallet.payout.approve"), async (_req: AuthRequest, res) => {
  return sendSuccess(res, { message: "Payout approved by authorized manager" });
});

// -------------------------------------------------------------
// Auth Routes (Multi-Role, AI Bio Parsing & Capability Extraction)
// -------------------------------------------------------------
app.post("/api/auth/register", authRateLimiter, async (req, res, next) => {
  const {
    name,
    phone,
    password,
    role = "customer",
    email,
    profession,
    bio,
    vehicleDetails,
    vehicleType,
    skills,
    experienceYears,
  } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ message: "بيانات ناقصة" });

  try {
    const hash = await hashPassword(password);
    const assignedRole = await db.role.findUnique({
      where: { name: (role as string).toLowerCase() },
    });

    const isDriverOrWorker = ["driver", "worker"].includes(String(role).toLowerCase());

    // Resolve overdraft from SystemConfig — dynamically configurable by admin
    const { getConfigNumber: getCfgNum, CONFIG_KEYS: CFG } = await import("./core/config/system-config.service.js");
    const overdraftLimit = isDriverOrWorker
      ? await getCfgNum(role === "driver" ? CFG.DRIVER_OVERDRAFT_LIMIT : CFG.WORKER_OVERDRAFT_LIMIT, 1500)
      : 0.00;

    // AI Semantic Bio Parsing if bio is provided or provider details are provided
    let aiBioAnalysis: any = null;
    if (bio || profession || isDriverOrWorker) {
      aiBioAnalysis = parseProviderBio({ bio, profession, vehicleDetails, vehicleType });
    }

    const finalVehicleType = vehicleType || aiBioAnalysis?.vehicleType || null;
    const finalProfession = profession || aiBioAnalysis?.profession || (isDriverOrWorker ? (role === "driver" ? "سائق توصيل" : "فني خدمات") : null);
    const finalSkills = Array.from(new Set([...(Array.isArray(skills) ? skills : []), ...(aiBioAnalysis?.skills || [])]));
    const finalExperienceYears = experienceYears ? Number(experienceYears) : (aiBioAnalysis?.experienceYears || 1);

    const hasProviderData = isDriverOrWorker || !!profession || !!bio || !!vehicleType || !!vehicleDetails;

    const user = await db.user.create({
      data: {
        name,
        phone,
        email,
        password: hash,
        role: (role as string).toUpperCase(),
        roles: assignedRole
          ? {
              create: { roleId: assignedRole.id },
            }
          : undefined,
        wallet: {
          create: {
            balance: 0,
            overdraftLimit,
            currency: "EGP",
          },
        },
        providerProfile: hasProviderData
          ? {
              create: {
                vehicleType: finalVehicleType,
                profession: finalProfession,
                vehicleDetails: vehicleDetails || (finalVehicleType ? `Automated classification: ${finalVehicleType}` : undefined),
                bio,
                skills: finalSkills,
                experienceYears: finalExperienceYears,
              },
            }
          : undefined,
      },
      include: {
        roles: { include: { role: true } },
        providerProfile: true,
        wallet: true,
      },
    });

    const token = await generateToken({
      id: user.id,
      phone: user.phone,
      role: user.role,
      roles: user.roles.map((r) => r.role.name),
    });

    return sendSuccess(res, {
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        roles: user.roles.map((r) => r.role.name),
        providerProfile: user.providerProfile,
        wallet: {
          id: user.wallet?.id,
          balance: Number(user.wallet?.balance || 0),
          overdraftLimit: Number(user.wallet?.overdraftLimit || 0),
        },
        aiExtractedCapabilities: aiBioAnalysis ? {
          detectedVehicle: aiBioAnalysis.vehicleType,
          detectedSkills: aiBioAnalysis.skills,
          detectedProfession: aiBioAnalysis.profession,
        } : undefined,
      },
    }, 201);
  } catch (err: any) {
    next(err);
  }
});

app.post("/api/auth/login", authRateLimiter, async (req, res, next) => {
  const { phone, password } = req.body;
  try {
    const user = await db.user.findUnique({
      where: { phone },
      include: {
        roles: { include: { role: true } },
        providerProfile: true,
        wallet: true,
      },
    });

    if (!user || !(await comparePassword(password, user.password))) {
      throw new AppError("Invalid phone number or password", 401, ErrorCode.UNAUTHORIZED);
    }

    const roleNames = user.roles.map((r) => r.role.name);
    const token = await generateToken({
      id: user.id,
      phone: user.phone,
      role: user.role,
      roles: roleNames,
    });

    return sendSuccess(res, {
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        roles: roleNames,
        providerProfile: user.providerProfile,
        wallet: {
          id: user.wallet?.id,
          balance: Number(user.wallet?.balance || 0),
          overdraftLimit: Number(user.wallet?.overdraftLimit || 0),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// User submits a request to upgrade their role (e.g. customer requesting driver or worker or partner status)
app.post("/api/auth/request-role", auth, async (req: AuthRequest, res, next) => {
  try {
    const { requestedRole, profession, vehicleDetails, bio } = req.body;
    if (!requestedRole) {
      return res.status(400).json({ message: "requestedRole is required (e.g. driver, worker, partner)" });
    }

    const existingPending = await db.roleRequest.findFirst({
      where: {
        userId: req.user!.id,
        requestedRole: requestedRole.toLowerCase(),
        status: "PENDING",
      },
    });

    if (existingPending) {
      return res.status(409).json({
        message: `You already have a pending request for role '${requestedRole}'`,
        request: existingPending,
      });
    }

    const roleRequest = await db.roleRequest.create({
      data: {
        userId: req.user!.id,
        requestedRole: requestedRole.toLowerCase(),
        profession,
        vehicleDetails,
        bio,
        status: "PENDING",
      },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    return sendSuccess(res, {
      message: "Role upgrade request submitted successfully for administrative review",
      request: roleRequest,
    }, 201);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Legacy Endpoints (Fully Compatible with Talabat/MoveX architecture)
// -------------------------------------------------------------
app.get("/api/categories", async (_req, res, next) => {
  try {
    const categories = await db.category.findMany({
      where: { active: true },
      include: { products: { where: { active: true } } },
    });
    return sendSuccess(res, categories);
  } catch (err) {
    next(err);
  }
});

app.get("/api/products", async (req, res, next) => {
  try {
    const categoryId = String(req.query.categoryId || "");
    const products = await db.product.findMany({
      where: { active: true, ...(categoryId ? { categoryId } : {}) },
    });
    return sendSuccess(res, products);
  } catch (err) {
    next(err);
  }
});

app.get("/api/ads/config", async (_req, res, next) => {
  try {
    const ads = await db.adConfig.findMany({ where: { enabled: true } });
    return sendSuccess(res, ads);
  } catch (err) {
    next(err);
  }
});

// Legacy Order endpoint -> Refactored to call Core Order Engine
app.post("/api/orders", auth, async (req: AuthRequest, res, next) => {
  const { items, address, phone } = req.body;
  if (!Array.isArray(items) || !items.length || !address || !phone) {
    return res.status(400).json({ message: "بيانات الطلب ناقصة" });
  }

  try {
    const ids = items.map((x: any) => x.productId);
    const products = await db.product.findMany({ where: { id: { in: ids }, active: true } });
    const map = new Map(products.map((p) => [p.id, p]));
    let total = 0;
    const normalized: { productId: string; quantity: number; unitPrice: number }[] = [];

    for (const x of items) {
      const p = map.get(x.productId);
      const q = Math.max(1, Number(x.quantity || 1));
      if (!p) throw new AppError("Requested product is unavailable", 400, ErrorCode.BAD_REQUEST);
      total += Number(p.price) * q;
      normalized.push({ productId: p.id, quantity: q, unitPrice: Number(p.price) });
    }

    const order = await createOrder({
      customerId: req.user!.id,
      serviceType: ServiceType.food,
      total,
      priceFinal: total,
      address,
      phone,
      items: normalized,
      initialStatus: OrderStatus.matching,
    });

    return sendSuccess(res, order, 201);
  } catch (err: any) {
    next(err);
  }
});

app.get("/api/orders/my", auth, async (req: AuthRequest, res, next) => {
  try {
    const orders = await db.order.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      include: { items: { include: { product: true } } },
    });
    return sendSuccess(res, orders);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// Legacy Ads Config (RBAC Guarded)
// -------------------------------------------------------------
app.patch("/api/admin/ads/:id", auth, admin, async (req, res, next) => {
  try {
    const ad = await db.adConfig.update({ where: { id: req.params.id as string }, data: req.body });
    return sendSuccess(res, ad);
  } catch (err) {
    next(err);
  }
});

// 404 Route Handler
app.use((req, res, next) => {
  next(new AppError(`The requested route '${req.method} ${req.originalUrl}' does not exist on this server.`, 404, ErrorCode.NOT_FOUND));
});

// 4. Centralized Global Error Handler (Must be last middleware)
app.use(globalErrorHandler);

// ---------------------------------------------------------------------------
// Startup: Seed default system config values into DB if they don't exist yet
// ---------------------------------------------------------------------------
seedDefaultConfigs().then(() => {
  console.log("[SystemConfig] Default platform configuration values seeded ✓");
}).catch((e) => {
  console.warn("[SystemConfig] Could not seed default configs:", e?.message);
});

export default app;
