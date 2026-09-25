import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { db } from "../../db.js";

const secret = process.env.JWT_SECRET || "dev-secret";

export interface JwtPayload {
  id: string;
  phone: string;
  role: string;        // legacy primary role
  roles: string[];     // full list of assigned role names
  activeMode?: string; // current active gateway session mode
}

export type AuthRequest = Request & {
  user?: JwtPayload;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function generateToken(user: {
  id: string;
  phone: string;
  role?: string;
  roles?: string[];
  activeMode?: string;
}): Promise<string> {
  let roleList: string[] = user.roles || [];
  if (!roleList.length) {
    const userRoles = await db.userRole.findMany({
      where: { userId: user.id },
      include: { role: true },
    });
    roleList = userRoles.map((ur) => ur.role.name);
  }
  const primaryRole = user.role || roleList[0] || "customer";

  const payload: JwtPayload = {
    id: user.id,
    phone: user.phone,
    role: primaryRole.toUpperCase(),
    roles: roleList,
    activeMode: user.activeMode,
  };

  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: Missing Bearer token" });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized: Invalid or expired token" });
  }
}

// Legacy admin check
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const hasAdmin = req.user?.role === "ADMIN" || req.user?.roles?.includes("admin");
  if (!hasAdmin) {
    return res.status(403).json({ message: "Forbidden: Admin access required" });
  }
  next();
}
