import { Router, type IRouter } from "express";
import { eq, or } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hashPassword, verifyPassword } from "../lib/auth";
import { failure, success } from "../lib/http";
import { authenticate } from "../middlewares/auth";
import { publicUser } from "./auth-v1";

const router: IRouter = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+91[6-9]\d{9}$/;
const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 ? `+91${digits}` : digits.length === 12 && digits.startsWith("91") ? `+${digits}` : value.trim();
};
const strongPassword = (value: unknown): value is string => typeof value === "string" && value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
const duplicate = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";

router.get("/users/me", authenticate, async (req, res) => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.auth!.id));
  if (!user) { failure(res, 404, "User not found", "USER_NOT_FOUND"); return; }
  success(res, publicUser(user));
});
router.put("/users/me", authenticate, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const update: { name?: string; email?: string; phone?: string; updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 2) { failure(res, 422, "Name must be at least 2 characters", "VALIDATION_ERROR"); return; }
    update.name = body.name.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== "string" || !emailPattern.test(body.email.trim().toLowerCase())) { failure(res, 422, "A valid email is required", "VALIDATION_ERROR"); return; }
    update.email = body.email.trim().toLowerCase();
  }
  if (body.phone !== undefined) {
    if (typeof body.phone !== "string" || !phonePattern.test(normalizePhone(body.phone))) { failure(res, 422, "A valid Indian mobile number is required", "VALIDATION_ERROR"); return; }
    update.phone = normalizePhone(body.phone);
  }
  if (Object.keys(update).length === 1) { failure(res, 422, "Provide a name, email, or phone to update", "VALIDATION_ERROR"); return; }
  try {
    const [user] = await db.update(usersTable).set(update).where(eq(usersTable.id, req.auth!.id)).returning();
    success(res, publicUser(user), "Profile updated");
  } catch (error) {
    if (duplicate(error)) failure(res, 409, "An account with this email or phone already exists", "DUPLICATE_ACCOUNT");
    else throw error;
  }
});
router.post("/users/me/change-password", authenticate, async (req, res) => {
  if (!strongPassword(req.body?.newPassword) || typeof req.body?.currentPassword !== "string") { failure(res, 422, "Current password and a strong new password are required", "VALIDATION_ERROR"); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.auth!.id));
  if (!user || !(await verifyPassword(req.body.currentPassword, user.passwordHash))) { failure(res, 401, "Current password is incorrect", "INVALID_CREDENTIALS"); return; }
  await db.update(usersTable).set({ passwordHash: await hashPassword(req.body.newPassword), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
  success(res, null, "Password updated");
});
export default router;