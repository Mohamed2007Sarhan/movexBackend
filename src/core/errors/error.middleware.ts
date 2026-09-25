import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError, ErrorCode } from "./app-error.js";
import { ApiResponse } from "./response.js";

export function globalErrorHandler(
  err: any,
  req: Request & { id?: string },
  res: Response,
  _next: NextFunction
): Response {
  const requestId = req.id || (req.headers["x-request-id"] as string);
  const timestamp = new Date().toISOString();

  // 1. Handled Domain AppError
  if (err instanceof AppError) {
    const payload: ApiResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      meta: { timestamp, requestId },
    };
    return res.status(err.statusCode).json(payload);
  }

  // 2. Zod Schema Validation Error
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
      code: i.code,
    }));

    const payload: ApiResponse = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: "Invalid request payload format or parameters",
        details,
      },
      meta: { timestamp, requestId },
    };
    return res.status(400).json(payload);
  }

  // 3. Prisma Database Errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    let statusCode = 400;
    let code = ErrorCode.BAD_REQUEST;
    let message = "A database constraint violation occurred.";

    if (err.code === "P2002") {
      // Unique constraint failed
      statusCode = 409;
      code = ErrorCode.CONFLICT;
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : (err.meta?.target as string) || "field";
      message = `A unique record with this ${target} already exists.`;
    } else if (err.code === "P2025") {
      // Record to update not found
      statusCode = 404;
      code = ErrorCode.NOT_FOUND;
      message = "The requested resource was not found.";
    } else if (err.code === "P2003") {
      // Foreign key constraint failed
      statusCode = 400;
      code = ErrorCode.BAD_REQUEST;
      message = "Invalid reference: related entity does not exist.";
    }

    const payload: ApiResponse = {
      success: false,
      error: {
        code,
        message,
        details: process.env.NODE_ENV === "development" ? err.meta : undefined,
      },
      meta: { timestamp, requestId },
    };
    return res.status(statusCode).json(payload);
  }

  // 4. JWT Errors
  if (err.name === "JsonWebTokenError") {
    const payload: ApiResponse = {
      success: false,
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message: "Unauthorized: Invalid token signature",
      },
      meta: { timestamp, requestId },
    };
    return res.status(401).json(payload);
  }

  if (err.name === "TokenExpiredError") {
    const payload: ApiResponse = {
      success: false,
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message: "Unauthorized: Session token has expired, please log in again",
      },
      meta: { timestamp, requestId },
    };
    return res.status(401).json(payload);
  }

  // 5. Malformed JSON Body
  if (err instanceof SyntaxError && "body" in err) {
    const payload: ApiResponse = {
      success: false,
      error: {
        code: ErrorCode.BAD_REQUEST,
        message: "Malformed JSON payload in request body",
      },
      meta: { timestamp, requestId },
    };
    return res.status(400).json(payload);
  }

  // 6. Generic Internal Server Error
  console.error(`[Unhandled Error][${requestId || "no-req-id"}]`, err);

  const payload: ApiResponse = {
    success: false,
    error: {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: "An internal unexpected server error occurred.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    },
    meta: { timestamp, requestId },
  };

  return res.status(500).json(payload);
}
