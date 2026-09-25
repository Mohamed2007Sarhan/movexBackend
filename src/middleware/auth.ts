import { authMiddleware, adminMiddleware, type AuthRequest } from "../core/auth/auth.service.js";

export type { AuthRequest };
export { authMiddleware as auth, adminMiddleware as admin };
