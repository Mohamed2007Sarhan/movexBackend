import { Router, Response } from "express";
import { z } from "zod";
import { OrderStatus } from "@prisma/client";
import { db } from "../../db.js";
import { authMiddleware, AuthRequest } from "../../core/auth/index.js";
import { sendSuccess, AppError, ErrorCode } from "../../core/errors/index.js";
import { validate } from "../../core/security/index.js";

const router = Router();

const reviewSchema = z.object({
  orderId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  targetId: z.string().optional(),
});

// Submit review for completed order
router.post(
  "/",
  authMiddleware,
  validate({ body: reviewSchema }),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const { orderId, rating, comment, targetId } = req.body;

      const order = await db.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        throw new AppError("Order not found", 404, ErrorCode.NOT_FOUND);
      }

      if (order.userId !== req.user!.id) {
        throw new AppError("Only the customer who placed the order may submit a review", 403, ErrorCode.FORBIDDEN);
      }

      if (order.status !== OrderStatus.completed && order.status !== OrderStatus.DELIVERED) {
        throw new AppError("Reviews can only be submitted for completed orders", 400, ErrorCode.BAD_REQUEST);
      }

      const existingReview = await db.review.findUnique({
        where: { orderId },
      });

      if (existingReview) {
        throw new AppError("A review has already been submitted for this order", 409, ErrorCode.CONFLICT);
      }

      const resolvedTarget = targetId || order.providerId;

      const review = await db.review.create({
        data: {
          orderId,
          authorId: req.user!.id,
          targetId: resolvedTarget,
          rating,
          comment,
        },
        include: {
          author: { select: { id: true, name: true } },
        },
      });

      return sendSuccess(res, review, 201);
    } catch (err) {
      next(err);
    }
  }
);

// Get reviews for a provider
router.get("/provider/:providerId", async (req, res: Response, next) => {
  try {
    const reviews = await db.review.findMany({
      where: { targetId: req.params.providerId },
      orderBy: { createdAt: "desc" },
      include: {
        author: { select: { id: true, name: true } },
      },
    });

    const totalScore = reviews.reduce((sum, r) => sum + r.rating, 0);
    const averageRating = reviews.length ? Math.round((totalScore / reviews.length) * 10) / 10 : 5.0;

    return sendSuccess(res, {
      providerId: req.params.providerId,
      averageRating,
      reviewCount: reviews.length,
      reviews,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
