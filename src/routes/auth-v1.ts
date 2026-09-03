import { Router, type IRouter } from "express";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  db,
  gymsTable,
  passwordResetTokensTable,
  refreshTokensTable,
  trainerCertificationsTable,
  trainerProfilesTable,
  trainerGymsTable,
  trainerVisibilitySettingsTable,
  usersTable,
} from "@workspace/db";
import {
  createAccessToken,
  createPasswordResetToken,
  createRefreshToken,
  hashPassword,
  hashToken,
  verifyPassword,
  type UserRole,
} from "../lib/auth";
import { failure, success } from "../lib/http";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rate-limit";

const router: IRouter = Router();
const authRateLimit = rateLimit({ windowMs: 60_000, max: 10 });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const indianPhonePattern = /^\+91[6-9]\d{9}$/;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return value.trim();
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

type AccountInput = { name: string; email: string; phone: string; password: string };
type OwnerInput = AccountInput & { registrationCode: string; gymName: string; gymAddress: string; gymCity: string; gymNeighborhood?: string };
type TrainerInput = AccountInput & {
  city: string;
  address?: string;
  dateOfBirth?: string;
  gender?: string;
  specializations: string[];
  expertise?: string;
  trainingStyle?: string;
  languages: string[];
  qualification?: string;
  bio: string;
  trainingLocation?: string;
  yearsExperience: number;
  pricePerSessionMinor?: number;
  gymId: number;
  certifications?: Array<{
    name: string;
    issuingOrganization: string;
    certificationId?: string;
    issueDate?: string;
    expiryDate?: string;
  }>;
};

function accountInput(body: unknown): body is AccountInput {
  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  return typeof value.name === "string" && value.name.trim().length >= 2 &&
    typeof value.email === "string" && emailPattern.test(normalizeEmail(value.email)) &&
    typeof value.phone === "string" && indianPhonePattern.test(normalizePhone(value.phone)) &&
    validPassword(value.password);
}

function ownerInput(body: unknown): body is OwnerInput {
  return accountInput(body) && typeof (body as Record<string, unknown>).registrationCode === "string" &&
    typeof (body as Record<string, unknown>).gymName === "string" && (body as Record<string, string>).gymName.trim().length >= 2 &&
    typeof (body as Record<string, unknown>).gymAddress === "string" && (body as Record<string, string>).gymAddress.trim().length >= 4 &&
    typeof (body as Record<string, unknown>).gymCity === "string" && (body as Record<string, string>).gymCity.trim().length >= 2;
}

function stringArray(value: unknown, max = 20): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function trainerInput(body: unknown): body is TrainerInput {
  if (!accountInput(body) || !body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  return typeof value.city === "string" && value.city.trim().length >= 2 &&
    typeof value.bio === "string" && value.bio.trim().length >= 20 &&
    stringArray(value.specializations) && value.specializations.length > 0 &&
    stringArray(value.languages) && value.languages.length > 0 &&
    typeof value.yearsExperience === "number" && Number.isInteger(value.yearsExperience) && value.yearsExperience >= 0 && value.yearsExperience <= 60 &&
    (value.certifications === undefined || (Array.isArray(value.certifications) && value.certifications.every((item) => {
      if (!item || typeof item !== "object") return false;
      const certification = item as Record<string, unknown>;
      return typeof certification.name === "string" && certification.name.trim().length >= 2 &&
        typeof certification.issuingOrganization === "string" && certification.issuingOrganization.trim().length >= 2;
    }))) &&
    typeof value.gymId === "number" && Number.isInteger(value.gymId) && value.gymId > 0;
}

function duplicateError(error: unknown, depth = 0): boolean {
  if (depth > 3 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "23505" || duplicateError(candidate.cause, depth + 1);
}

export function publicUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id, name: user.name, email: user.email, phone: user.phone,
    role: user.role, status: user.status,
    emailVerified: user.emailVerified?.toISOString() ?? null,
    phoneVerified: user.phoneVerified?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

async function issueTokens(user: typeof usersTable.$inferSelect) {
  const refresh = createRefreshToken();
  await db.insert(refreshTokensTable).values({ userId: user.id, tokenHash: hashToken(refresh.token), expiresAt: refresh.expiresAt });
  return {
    accessToken: createAccessToken({ id: user.id, role: user.role as UserRole }),
    refreshToken: refresh.token,
    expiresIn: Number(process.env.JWT_ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60),
  };
}

router.post("/auth/register", authRateLimit, async (req, res): Promise<void> => {
  if (!accountInput(req.body)) {
    failure(res, 422, "Name, valid email, Indian mobile number, and a strong password are required", "VALIDATION_ERROR");
    return;
  }
  try {
    const [user] = await db.insert(usersTable).values({
      name: req.body.name.trim(), email: normalizeEmail(req.body.email), phone: normalizePhone(req.body.phone),
      passwordHash: await hashPassword(req.body.password), role: "CUSTOMER", status: "ACTIVE",
    }).returning();
    success(res, { user: publicUser(user), ...(await issueTokens(user)) }, "Account created", 201);
  } catch (error) {
    if (duplicateError(error)) failure(res, 409, "An account with this email or phone already exists", "DUPLICATE_ACCOUNT");
    else throw error;
  }
});

router.post("/auth/register-owner", authRateLimit, async (req, res): Promise<void> => {
  if (!ownerInput(req.body)) {
    failure(res, 422, "Owner, registration code, and gym details are required", "VALIDATION_ERROR");
    return;
  }
  if (!process.env.OWNER_REGISTRATION_CODE || req.body.registrationCode !== process.env.OWNER_REGISTRATION_CODE) {
    failure(res, 403, "Owner registration requires a valid invitation", "OWNER_INVITE_REQUIRED");
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [user] = await tx.insert(usersTable).values({
        name: req.body.name.trim(), email: normalizeEmail(req.body.email), phone: normalizePhone(req.body.phone),
        passwordHash: await hashPassword(req.body.password), role: "GYM_OWNER", status: "ACTIVE",
      }).returning();
      const slugBase = `${req.body.gymName}-${req.body.gymCity}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const [gym] = await tx.insert(gymsTable).values({
        ownerId: user.id, slug: `${slugBase}-${Date.now().toString(36)}-${user.id}`, name: req.body.gymName.trim(),
        neighborhood: typeof req.body.gymNeighborhood === "string" ? req.body.gymNeighborhood.trim() : req.body.gymCity.trim(),
        city: req.body.gymCity.trim(), address: req.body.gymAddress.trim(), phone: normalizePhone(req.body.phone),
        email: normalizeEmail(req.body.email), imageUrl: "", gallery: [], description: "", gymType: "Fitness gym",
        facilities: [], status: "PENDING_APPROVAL", isOpen: false, openUntil: "",
      }).returning();
      return { user, gym };
    });
    success(res, { user: publicUser(result.user), gym: result.gym, ...(await issueTokens(result.user)) }, "Owner account and gym submitted", 201);
  } catch (error) {
    if (duplicateError(error)) failure(res, 409, "An account with this email or phone already exists", "DUPLICATE_ACCOUNT");
    else throw error;
  }
});

router.post("/auth/register-trainer", authRateLimit, async (req, res): Promise<void> => {
  if (!trainerInput(req.body)) {
    failure(res, 422, "Name, valid contact details, city, bio, specialization, language, and experience are required", "VALIDATION_ERROR");
    return;
  }
  try {
    const trainerData = req.body as TrainerInput;
    const result = await db.transaction(async (tx) => {
        const [gym] = await tx.select({ id: gymsTable.id }).from(gymsTable).where(and(eq(gymsTable.id, trainerData.gymId), eq(gymsTable.status, "APPROVED")));
        if (!gym) throw new Error("TRAINER_GYM_NOT_FOUND");
      const [user] = await tx.insert(usersTable).values({
        name: trainerData.name.trim(),
        email: normalizeEmail(trainerData.email),
        phone: normalizePhone(trainerData.phone),
        passwordHash: await hashPassword(req.body.password),
        role: "TRAINER",
        status: "ACTIVE",
      }).returning();
      const [profile] = await tx.insert(trainerProfilesTable).values({
        userId: user.id,
        city: trainerData.city.trim(),
        address: trainerData.address?.trim() || null,
        dateOfBirth: trainerData.dateOfBirth || null,
        gender: trainerData.gender?.trim() || null,
        specializations: trainerData.specializations.map((item: string) => item.trim()),
        specialization: trainerData.specializations[0]?.trim() ?? null,
        expertise: trainerData.expertise?.trim() || null,
        trainingStyle: trainerData.trainingStyle?.trim() || null,
        languages: trainerData.languages.map((item: string) => item.trim()),
        qualification: trainerData.qualification?.trim() || null,
        bio: trainerData.bio.trim(),
        trainingLocation: trainerData.trainingLocation?.trim() || null,
        yearsExperience: trainerData.yearsExperience,
        pricePerSessionMinor: typeof trainerData.pricePerSessionMinor === "number" && Number.isInteger(trainerData.pricePerSessionMinor) ? trainerData.pricePerSessionMinor : null,
        status: "PENDING_APPROVAL",
         adminVerificationStatus: "PENDING",
      }).returning();
       await tx.insert(trainerGymsTable).values({
         trainerId: profile.id,
         gymId: gym.id,
         isPrimaryGym: true,
         sessionPriceMinor: typeof trainerData.pricePerSessionMinor === "number" && Number.isInteger(trainerData.pricePerSessionMinor) ? trainerData.pricePerSessionMinor : null,
         currency: "INR",
         status: "ACTIVE",
       });
      await tx.insert(trainerVisibilitySettingsTable).values({ trainerId: profile.id });
      if (trainerData.certifications?.length) {
        await tx.insert(trainerCertificationsTable).values(trainerData.certifications.map((certification: NonNullable<TrainerInput["certifications"]>[number]) => ({
          trainerId: profile.id,
          name: certification.name.trim(),
          issuingOrganization: certification.issuingOrganization.trim(),
          certificationId: certification.certificationId?.trim() || null,
          issueDate: certification.issueDate || null,
          expiryDate: certification.expiryDate || null,
          verificationStatus: "PENDING",
        })));
      }
      return user;
    });
    success(res, { user: publicUser(result), ...(await issueTokens(result)) }, "Trainer application submitted for review", 201);
   } catch (error) {
     if (error instanceof Error && error.message === "TRAINER_GYM_NOT_FOUND") {
       failure(res, 422, "Choose an approved gym where you will train", "TRAINER_GYM_REQUIRED");
       return;
     }
    if (duplicateError(error)) failure(res, 409, "An account with this email or phone already exists", "DUPLICATE_ACCOUNT");
    else throw error;
  }
});

router.post("/auth/login", authRateLimit, async (req, res): Promise<void> => {
  if (typeof req.body?.identifier !== "string" && typeof req.body?.email !== "string" || typeof req.body?.password !== "string") {
    failure(res, 422, "Email or mobile number and password are required", "VALIDATION_ERROR");
    return;
  }
  const identifier = typeof req.body.identifier === "string" ? req.body.identifier : req.body.email;
  const normalized = identifier.includes("@") ? normalizeEmail(identifier) : normalizePhone(identifier);
  const [user] = await db.select().from(usersTable).where(or(eq(usersTable.email, normalized), eq(usersTable.phone, normalized)));
  if (!user || user.status !== "ACTIVE" || !(await verifyPassword(req.body.password, user.passwordHash))) {
    failure(res, 401, "Invalid credentials", "INVALID_CREDENTIALS");
    return;
  }
  const [updated] = await db.update(usersTable).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, user.id)).returning();
  success(res, { user: publicUser(updated), ...(await issueTokens(updated)) }, "Login successful");
});

router.post("/auth/login-trainer", authRateLimit, async (req, res): Promise<void> => {
  if ((typeof req.body?.identifier !== "string" && typeof req.body?.email !== "string") || typeof req.body?.password !== "string") {
    failure(res, 422, "Email or mobile number and password are required", "VALIDATION_ERROR");
    return;
  }
  const identifier = typeof req.body.identifier === "string" ? req.body.identifier : req.body.email;
  const normalized = identifier.includes("@") ? normalizeEmail(identifier) : normalizePhone(identifier);
  const [user] = await db.select().from(usersTable).where(or(eq(usersTable.email, normalized), eq(usersTable.phone, normalized)));
  if (!user || user.role !== "TRAINER" || user.status !== "ACTIVE" || !(await verifyPassword(req.body.password, user.passwordHash))) {
    failure(res, 401, "Invalid trainer credentials", "INVALID_CREDENTIALS");
    return;
  }
  const [updated] = await db.update(usersTable).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, user.id)).returning();
  success(res, { user: publicUser(updated), ...(await issueTokens(updated)) }, "Trainer login successful");
});

router.post("/auth/forgot-password", authRateLimit, async (req, res): Promise<void> => {
  const generic = "If an account matches those details, password reset instructions have been created.";
  if (typeof req.body?.email !== "string" || !emailPattern.test(normalizeEmail(req.body.email))) {
    success(res, null, generic);
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizeEmail(req.body.email)));
  if (!user) { success(res, null, generic); return; }
  const reset = createPasswordResetToken();
  await db.insert(passwordResetTokensTable).values({ userId: user.id, tokenHash: hashToken(reset.token), expiresAt: reset.expiresAt });
  success(res, process.env.NODE_ENV === "production" ? null : { resetToken: reset.token }, generic);
});

router.post("/auth/reset-password", authRateLimit, async (req, res): Promise<void> => {
  if (typeof req.body?.token !== "string" || req.body.token.length < 20 || !validPassword(req.body.password)) {
    failure(res, 422, "A valid reset token and strong password are required", "VALIDATION_ERROR");
    return;
  }
  const [stored] = await db.select().from(passwordResetTokensTable).where(and(
    eq(passwordResetTokensTable.tokenHash, hashToken(req.body.token)), isNull(passwordResetTokensTable.usedAt), gt(passwordResetTokensTable.expiresAt, new Date()),
  ));
  if (!stored) { failure(res, 400, "Reset token is invalid or expired", "INVALID_RESET_TOKEN"); return; }
  const resetApplied = await db.transaction(async (tx) => {
    const used = await tx.update(passwordResetTokensTable).set({ usedAt: new Date() }).where(and(eq(passwordResetTokensTable.id, stored.id), isNull(passwordResetTokensTable.usedAt))).returning();
    if (!used.length) return false;
    await tx.update(usersTable).set({ passwordHash: await hashPassword(req.body.password), updatedAt: new Date() }).where(eq(usersTable.id, stored.userId));
    await tx.update(refreshTokensTable).set({ revokedAt: new Date() }).where(eq(refreshTokensTable.userId, stored.userId));
    return true;
  });
  if (!resetApplied) { failure(res, 400, "Reset token is invalid or expired", "INVALID_RESET_TOKEN"); return; }
  success(res, null, "Password reset successfully");
});

router.post("/auth/refresh", authRateLimit, async (req, res): Promise<void> => {
  const token = req.body?.refreshToken;
  if (typeof token !== "string" || token.length < 20) { failure(res, 422, "Refresh token is required", "VALIDATION_ERROR"); return; }
  const [stored] = await db.select().from(refreshTokensTable).where(and(eq(refreshTokensTable.tokenHash, hashToken(token)), isNull(refreshTokensTable.revokedAt), gt(refreshTokensTable.expiresAt, new Date())));
  if (!stored) { failure(res, 401, "Refresh token is invalid or expired", "INVALID_REFRESH_TOKEN"); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, stored.userId));
  if (!user || user.status !== "ACTIVE") { failure(res, 401, "User account is not active", "ACCOUNT_INACTIVE"); return; }
  await db.update(refreshTokensTable).set({ revokedAt: new Date() }).where(eq(refreshTokensTable.id, stored.id));
  success(res, { user: publicUser(user), ...(await issueTokens(user)) }, "Token refreshed");
});

router.post("/auth/logout", authenticate, async (req, res): Promise<void> => {
  if (typeof req.body?.refreshToken === "string") await db.update(refreshTokensTable).set({ revokedAt: new Date() }).where(and(eq(refreshTokensTable.userId, req.auth!.id), eq(refreshTokensTable.tokenHash, hashToken(req.body.refreshToken))));
  success(res, null, "Logged out");
});

export default router;