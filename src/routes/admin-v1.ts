import { Router, type IRouter } from "express";
import { count, desc, eq, ilike, inArray, or, sum } from "drizzle-orm";
import { db, bookingsTable, gymsTable, paymentsTable, platformSettingsTable, payoutsTable, reviewsTable, usersTable } from "@workspace/db";
import { authenticate, requireRole } from "../middlewares/auth";
import { failure, success } from "../lib/http";
import { bookingData } from "./bookings-v1";
import { integerParam, pageData, pageParams, queryString, userData } from "../lib/v1";

const router: IRouter = Router();
router.use(authenticate, requireRole("ADMIN"));

router.get("/admin/users", async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const search = queryString(req.query.search);
  const where = search ? or(
    ilike(usersTable.name, `%${search}%`),
    ilike(usersTable.email, `%${search}%`),
    ilike(usersTable.phone, `%${search}%`),
  ) : undefined;
  const [users, [{ value: total }]] = await Promise.all([
    db.select().from(usersTable).where(where).orderBy(desc(usersTable.createdAt)).limit(size).offset(offset),
    db.select({ value: count() }).from(usersTable).where(where),
  ]);
  success(res, pageData(users.map(userData), page, size, Number(total)));
});

router.get("/admin/users/:id", async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const [user] = id ? await db.select().from(usersTable).where(eq(usersTable.id, id)) : [];
  if (!user) {
    failure(res, 404, "User not found", "USER_NOT_FOUND");
    return;
  }
  success(res, userData(user));
});

router.patch("/admin/users/:id/status", async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const status = req.body?.status;
  if (!id || !["ACTIVE", "INACTIVE", "BLOCKED"].includes(status)) {
    failure(res, 422, "A valid user id and status are required", "VALIDATION_ERROR");
    return;
  }
  const [user] = await db.update(usersTable).set({ status, updatedAt: new Date() }).where(eq(usersTable.id, id)).returning();
  if (!user) {
    failure(res, 404, "User not found", "USER_NOT_FOUND");
    return;
  }
  success(res, userData(user), "User status updated");
});

router.patch("/admin/users/:id/role", async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const role = req.body?.role;
  if (!id || !["CUSTOMER", "GYM_OWNER", "ADMIN"].includes(role)) {
    failure(res, 422, "A valid user id and role are required", "VALIDATION_ERROR");
    return;
  }
  const [user] = await db.update(usersTable).set({ role, updatedAt: new Date() }).where(eq(usersTable.id, id)).returning();
  if (!user) {
    failure(res, 404, "User not found", "USER_NOT_FOUND");
    return;
  }
  success(res, userData(user), "User role updated");
});

router.get("/admin/gyms", async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const [gyms, [{ value: total }]] = await Promise.all([
    db.select().from(gymsTable).orderBy(desc(gymsTable.createdAt)).limit(size).offset(offset),
    db.select({ value: count() }).from(gymsTable),
  ]);
  success(res, pageData(gyms, page, size, Number(total)));
});

async function changeGymStatus(id: unknown, status: string, res: Parameters<typeof success>[0]): Promise<void> {
  const gymId = integerParam(id);
  if (!gymId) {
    failure(res, 400, "Gym id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [gym] = await db.update(gymsTable).set({ status, updatedAt: new Date() }).where(eq(gymsTable.id, gymId)).returning();
  if (!gym) {
    failure(res, 404, "Gym not found", "GYM_NOT_FOUND");
    return;
  }
  success(res, gym, "Gym status updated");
}

router.post("/admin/gyms/:id/approve", (req, res) => changeGymStatus(req.params.id, "APPROVED", res));
router.post("/admin/gyms/:id/reject", (req, res) => changeGymStatus(req.params.id, "REJECTED", res));
router.post("/admin/gyms/:id/suspend", (req, res) => changeGymStatus(req.params.id, "SUSPENDED", res));

router.get("/admin/bookings", async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const [bookings, [{ value: total }]] = await Promise.all([
    db.select().from(bookingsTable).orderBy(desc(bookingsTable.createdAt)).limit(size).offset(offset),
    db.select({ value: count() }).from(bookingsTable),
  ]);
  success(res, pageData(await Promise.all(bookings.map(bookingData)), page, size, Number(total)));
});

router.get("/admin/payments", async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const [payments, [{ value: total }]] = await Promise.all([
    db.select().from(paymentsTable).orderBy(desc(paymentsTable.createdAt)).limit(size).offset(offset),
    db.select({ value: count() }).from(paymentsTable),
  ]);
  success(res, pageData(payments, page, size, Number(total)));
});

router.get("/admin/reviews", async (req, res): Promise<void> => {
  const reviews = await db.select().from(reviewsTable).orderBy(desc(reviewsTable.date));
  success(res, reviews);
});

router.delete("/admin/reviews/:id", async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  if (!id) {
    failure(res, 400, "Review id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [review] = await db.delete(reviewsTable).where(eq(reviewsTable.id, id)).returning();
  if (!review) {
    failure(res, 404, "Review not found", "REVIEW_NOT_FOUND");
    return;
  }
  success(res, null, "Review deleted");
});

router.get("/admin/payouts", async (req, res): Promise<void> => {
  const payouts = await db.select().from(payoutsTable).orderBy(desc(payoutsTable.createdAt));
  success(res, payouts);
});

router.post("/admin/payouts/:id/mark-paid", async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  if (!id) {
    failure(res, 400, "Payout id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [payout] = await db.update(payoutsTable).set({
    status: "PAID",
    payoutReference: typeof req.body?.payoutReference === "string" ? req.body.payoutReference : `PAYOUT-${id}`,
    payoutDate: new Date(),
    updatedAt: new Date(),
  }).where(eq(payoutsTable.id, id)).returning();
  if (!payout) {
    failure(res, 404, "Payout not found", "PAYOUT_NOT_FOUND");
    return;
  }
  success(res, payout, "Payout marked as paid");
});

router.get("/admin/settings/commission", async (_req, res): Promise<void> => {
  const [setting] = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "platformCommissionPercentage"));
  success(res, { platformCommissionPercentage: setting ? Number(setting.value) : Number(process.env.PLATFORM_COMMISSION_PERCENTAGE ?? 20) });
});

router.patch("/admin/settings/commission", async (req, res): Promise<void> => {
  const value = Number(req.body?.platformCommissionPercentage);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    failure(res, 422, "Commission percentage must be between 0 and 100", "VALIDATION_ERROR");
    return;
  }
  const [setting] = await db.insert(platformSettingsTable).values({
    key: "platformCommissionPercentage",
    value: String(value),
  }).onConflictDoUpdate({
    target: platformSettingsTable.key,
    set: { value: String(value), updatedAt: new Date() },
  }).returning();
  success(res, { platformCommissionPercentage: Number(setting.value) }, "Commission updated");
});

router.get("/admin/dashboard", async (_req, res): Promise<void> => {
  const [[users], [gyms], [activeGyms], [bookings], [successfulBookings], [revenue], [platformRevenue], [gymRevenue], [pendingPayouts]] = await Promise.all([
    db.select({ value: count() }).from(usersTable),
    db.select({ value: count() }).from(gymsTable),
    db.select({ value: count() }).from(gymsTable).where(inArray(gymsTable.status, ["APPROVED", "ACTIVE"])),
    db.select({ value: count() }).from(bookingsTable),
    db.select({ value: count() }).from(bookingsTable).where(inArray(bookingsTable.status, ["CONFIRMED", "CHECKED_IN", "COMPLETED"])),
    db.select({ value: sum(bookingsTable.amount) }).from(bookingsTable).where(inArray(bookingsTable.status, ["CONFIRMED", "CHECKED_IN", "COMPLETED"])),
    db.select({ value: sum(bookingsTable.platformCommission) }).from(bookingsTable).where(inArray(bookingsTable.status, ["CONFIRMED", "CHECKED_IN", "COMPLETED"])),
    db.select({ value: sum(bookingsTable.gymAmount) }).from(bookingsTable).where(inArray(bookingsTable.status, ["CONFIRMED", "CHECKED_IN", "COMPLETED"])),
    db.select({ value: sum(payoutsTable.amount) }).from(payoutsTable).where(inArray(payoutsTable.status, ["PENDING", "PROCESSING"])),
  ]);
  success(res, {
    totalUsers: Number(users.value),
    totalGyms: Number(gyms.value),
    activeGyms: Number(activeGyms.value),
    totalBookings: Number(bookings.value),
    successfulBookings: Number(successfulBookings.value),
    totalRevenue: Number(revenue.value ?? 0),
    platformRevenue: Number(platformRevenue.value ?? 0),
    gymRevenue: Number(gymRevenue.value ?? 0),
    pendingPayouts: Number(pendingPayouts.value ?? 0),
  });
});

export default router;