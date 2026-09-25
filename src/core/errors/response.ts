import { Response, Request } from "express";

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta: {
    timestamp: string;
    requestId?: string;
    [key: string]: any;
  };
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200, extraMeta: Record<string, any> = {}): Response {
  const req = res.req as Request & { id?: string };
  const response: ApiResponse<T> = {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req?.id || (req?.headers?.["x-request-id"] as string),
      ...extraMeta,
    },
  };
  return res.status(statusCode).json(response);
}
