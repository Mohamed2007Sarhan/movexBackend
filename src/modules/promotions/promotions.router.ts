import { Router, Response } from "express";
import { z } from "zod";
import { db } from "../../db.js";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { sendSuccess, AppError, ErrorCode } from "../../core/errors/index.js";
import { validate } from "../../core/security/index.js";

const router = Router();

const applyCouponSchema = z.object({
  code: z.string().min(1),
  orderTotal: z.number().positive(),
});

// Apply coupon code to order
router.post(
  "/apply",
  authMiddleware,
  validate({ body: applyCouponSchema }),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const { code, orderTotal } = req.body;

      const coupon = await db.coupon.findUnique({
        where: { code: code.toUpperCase() },
      });

      if (!coupon || !coupon.isActive) {
        throw new AppError("Invalid or inactive coupon code", 404, ErrorCode.NOT_FOUND);
      }

      if (new Date() > coupon.expiresAt) {
        throw new AppError("Coupon has expired", 400, ErrorCode.BAD_REQUEST);
      }

      const minOrder = Number(coupon.minOrder);
      if (orderTotal < minOrder) {
        throw new AppError(
          `Minimum order value for this coupon is $${minOrder.toFixed(2)} (current: $${orderTotal.toFixed(2)})`,
          400,
          ErrorCode.BAD_REQUEST
        );
      }

      const discountPct = Number(coupon.discountPct);
      const maxDiscount = Number(coupon.maxDiscount);
      let calculatedDiscount = (orderTotal * discountPct) / 100;
      if (calculatedDiscount > maxDiscount) {
        calculatedDiscount = maxDiscount;
      }
      calculatedDiscount = Math.round(calculatedDiscount * 100) / 100;

      const finalTotal = Math.max(0, Math.round((orderTotal - calculatedDiscount) * 100) / 100);

      return sendSuccess(res, {
        valid: true,
        code: coupon.code,
        discountPercentage: discountPct,
        discountAmount: calculatedDiscount,
        originalTotal: orderTotal,
        finalTotal,
      });
    } catch (err) {
      next(err);
    }
  }
);

// List active promotional coupons
router.get("/active", async (_req, res: Response, next) => {
  try {
    const activeCoupons = await db.coupon.findMany({
      where: {
        isActive: true,
        expiresAt: { gt: new Date() },
      },
      select: {
        code: true,
        discountPct: true,
        maxDiscount: true,
        minOrder: true,
        expiresAt: true,
      },
    });
    return sendSuccess(res, activeCoupons);
  } catch (err) {
    next(err);
  }
});

export default router;
