import { Response, NextFunction } from "express";
import { db } from "../../db.js";
import { AuthRequest } from "../auth/auth.service.js";

interface CacheEntry {
  permissions: Set<string>;
  expiresAt: number;
}

const rolePermissionsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getPermissionsForRole(roleName: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = rolePermissionsCache.get(roleName);
  if (cached && cached.expiresAt > now) {
    return cached.permissions;
  }

  const roleWithPerms = await db.role.findUnique({
    where: { name: roleName.toLowerCase() },
    include: {
      permissions: {
        include: { permission: true },
      },
    },
  });

  const permissions = new Set<string>();
  if (roleWithPerms) {
    for (const rp of roleWithPerms.permissions) {
      permissions.add(rp.permission.key);
    }
  }

  rolePermissionsCache.set(roleName, {
    permissions,
    expiresAt: now + CACHE_TTL_MS,
  });

  return permissions;
}

export async function getUserPermissions(roles: string[]): Promise<Set<string>> {
  const combined = new Set<string>();
  for (const role of roles) {
    const perms = await getPermissionsForRole(role);
    for (const p of perms) {
      combined.add(p);
    }
  }
  return combined;
}

export function clearRbacCache() {
  rolePermissionsCache.clear();
}

/**
 * Middleware guarding routes by required permission key.
 * Checks caller's roles -> permissions with in-memory caching.
 */
export function requirePermission(permissionKey: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized: Authentication required" });
    }

    const userRoles = req.user.roles || [req.user.role?.toLowerCase() || "customer"];

    // Admin has superuser access
    if (userRoles.includes("admin") || req.user.role === "ADMIN") {
      return next();
    }

    try {
      const permissions = await getUserPermissions(userRoles);
      if (!permissions.has(permissionKey)) {
        return res.status(403).json({
          message: `Forbidden: Missing required permission '${permissionKey}'`,
          requiredPermission: permissionKey,
        });
      }
      next();
    } catch (err: any) {
      return res.status(500).json({ message: "Internal server error during authorization check", error: err.message });
    }
  };
}
