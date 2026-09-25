import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ZodSchema } from "zod";
import crypto from "crypto";
import { ValidationError } from "../errors/app-error.js";

// 1. Helmet Security Headers configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: false, // Allows Swagger UI inline scripts
  crossOriginEmbedderPolicy: false,
});

// 2. Request ID Tracing Middleware
export function requestIdMiddleware(req: Request & { id?: string }, res: Response, next: NextFunction) {
  const incomingId = req.headers["x-request-id"] as string;
  const requestId = incomingId || crypto.randomUUID();
  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}

// 3. General API Rate Limiter
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests from this IP, please try again after 15 minutes.",
    },
  },
});

// 4. Strict Auth Rate Limiter (Brute-force protection)
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 25, // 25 login/register attempts per 15 min
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many authentication attempts, please wait 15 minutes before trying again.",
    },
  },
});

// 5. Financial / Wallet Rate Limiter
export const walletRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Transaction rate limit reached. Please space out transfer requests.",
    },
  },
});

// 6. Request Validation Middleware Factory using Zod
export function validate(schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) {
        req.params = (await schemas.params.parseAsync(req.params)) as any;
      }
      if (schemas.query) {
        req.query = (await schemas.query.parseAsync(req.query)) as any;
      }
      if (schemas.body) {
        req.body = await schemas.body.parseAsync(req.body);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
