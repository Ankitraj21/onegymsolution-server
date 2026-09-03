import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { verifyAccessToken, type UserRole } from "../lib/auth";
import { failure } from "../lib/http";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        id: number;
        role: UserRole;
      };
      rawBody?: Buffer;
    }
  }
}

function bearerToken(req: Request): string | null {
  const value = req.header("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) {
    failure(res, 401, "Authentication required", "UNAUTHORIZED");
    return;
  }
  const [user] = await db
    .select({ id: usersTable.id, role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.id, claims.sub));
  if (!user || user.status !== "ACTIVE") {
    failure(res, 401, "User account is not active", "ACCOUNT_INACTIVE");
    return;
  }
  req.auth = { id: user.id, role: user.role as UserRole };
  next();
}

export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  const claims = token ? verifyAccessToken(token) : null;
  if (claims) req.auth = { id: claims.sub, role: claims.role };
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      failure(res, 403, "You do not have permission to access this resource", "FORBIDDEN");
      return;
    }
    next();
  };
}