import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const ACCESS_TOKEN_TTL_SECONDS = Number(process.env.JWT_ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60);
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type UserRole = "CUSTOMER" | "GYM_OWNER" | "TRAINER" | "ADMIN";

export type AuthClaims = {
  sub: number;
  role: UserRole;
  type: "access";
  exp: number;
  iat: number;
};

function secret(): string {
  const value = process.env.JWT_SECRET ?? process.env.SESSION_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }
  return value ?? "development-only-gympass-secret";
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function hashToken(token: string): string {
  return createHmac("sha256", secret()).update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createAccessToken(user: { id: number; role: UserRole }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    sub: user.id,
    role: user.role,
    type: "access",
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  }));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export function verifyAccessToken(token: string): AuthClaims | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const unsigned = `${header}.${payload}`;
  const expected = Buffer.from(sign(unsigned));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as AuthClaims;
    if (claims.type !== "access" || typeof claims.sub !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function createRefreshToken(): { token: string; expiresAt: Date } {
  return {
    token: randomBytes(48).toString("base64url"),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

export function createPasswordResetToken(): { token: string; expiresAt: Date } {
  const ttlMinutes = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? 30);
  const safeTtlMinutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 30;
  return {
    token: randomBytes(48).toString("base64url"),
    expiresAt: new Date(Date.now() + safeTtlMinutes * 60 * 1000),
  };
}