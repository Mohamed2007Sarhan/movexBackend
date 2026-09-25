import { Router, Response } from "express";
import { z } from "zod";
import { db } from "../../db.js";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { sendSuccess } from "../../core/errors/index.js";
import { validate } from "../../core/security/index.js";
import { getOrCreateWallet } from "../../core/wallet/index.js";

const router = Router();

const updateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
});

// View own profile
router.get("/me", authMiddleware, async (req: AuthRequest, res: Response, next) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      include: {
        roles: { include: { role: true } },
        providerProfile: { include: { serviceCategories: { include: { serviceCategory: true } } } },
        wallet: true,
      },
    });

    const wallet = await getOrCreateWallet(req.user!.id);

    return sendSuccess(res, {
      id: user?.id,
      name: user?.name,
      phone: user?.phone,
      email: user?.email,
      status: user?.status,
      roles: user?.roles.map((r) => r.role.name) || [],
      providerProfile: user?.providerProfile,
      walletBalance: Number(wallet.balance),
      currency: wallet.currency,
    });
  } catch (err) {
    next(err);
  }
});

// Update profile
router.patch(
  "/me",
  authMiddleware,
  validate({ body: updateProfileSchema }),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const updated = await db.user.update({
        where: { id: req.user!.id },
        data: req.body,
        select: { id: true, name: true, phone: true, email: true, status: true },
      });
      return sendSuccess(res, updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
