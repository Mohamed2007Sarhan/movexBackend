export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  ILLEGAL_STATE_TRANSITION = "ILLEGAL_STATE_TRANSITION",
  IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
  BAD_REQUEST = "BAD_REQUEST",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: any;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: ErrorCode, details?: any) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 400, ErrorCode.VALIDATION_ERROR, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, 401, ErrorCode.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Access denied: insufficient permissions") {
    super(message, 403, ErrorCode.FORBIDDEN);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = "Resource", identifier?: string) {
    const msg = identifier ? `${resource} with identifier '${identifier}' not found` : `${resource} not found`;
    super(msg, 404, ErrorCode.NOT_FOUND);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, ErrorCode.CONFLICT);
  }
}

export class InsufficientFundsError extends AppError {
  constructor(currentBalance: number, requestedAmount: number) {
    super(
      `Insufficient wallet balance: Current balance is $${currentBalance.toFixed(2)}, requested $${requestedAmount.toFixed(2)}`,
      400,
      ErrorCode.INSUFFICIENT_FUNDS,
      { currentBalance, requestedAmount }
    );
  }
}

export class IllegalStateTransitionError extends AppError {
  constructor(currentStatus: string, targetStatus: string, allowedStates: string[]) {
    super(
      `Invalid order state transition: Cannot change status from '${currentStatus}' to '${targetStatus}'. Allowed next states: [${allowedStates.join(", ")}]`,
      400,
      ErrorCode.ILLEGAL_STATE_TRANSITION,
      { currentStatus, targetStatus, allowedStates }
    );
  }
}
