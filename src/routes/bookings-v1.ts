import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, count, desc, eq, or } from "drizzle-orm";
import { db, bookingsTable, checkinsTable, gymsTable, gymPassesTable, paymentsTable, platformSettingsTable, payoutsTable } from "@workspace/db";
import { authenticate, requireRole } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rate-limit";
import { failure, success } from "../lib/http";
import { createPaymentOrder, verifyWebhookSignature } from "../lib/payments";
import { addDays, dateOnly, integerParam, isDate, pageData, pageParams, paramString, passData } from "../lib/v1";
import { hashToken } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const paymentRateLimit = rateLimit({ windowMs: 60_000, max: 20 });

async function commissionPercentage(): Promise<number> {
  const [setting] = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "platformCommissionPercentage"));
  const value = setting ? Number(setting.value) : Number(process.env.PLATFORM_COMMISSION_PERCENTAGE ?? 20);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 20;
}

export async function bookingData(booking: typeof bookingsTable.$inferSelect) {
  const [[gym], [pass], [payment]] = await Promise.all([
    db.select().from(gymsTable).where(eq(gymsTable.id, booking.gymId)),
    db.select().from(gymPassesTable).where(eq(gymPassesTable.id, booking.passId)),
    db.select().from(paymentsTable).where(eq(paymentsTable.bookingId, booking.id)).orderBy(desc(paymentsTable.createdAt)).limit(1),
  ]);
  if (!gym || !pass) throw new Error("Booking references missing gym or pass");
  return {
    reference: booking.reference,
    gym: { id: gym.id, slug: gym.slug, name: gym.name, city: gym.city, address: gym.address },
    pass: passData(pass),
    bookingDate: booking.bookingDate,
    validFrom: booking.validFrom ?? booking.bookingDate,
    validUntil: booking.validUntil ?? booking.expiresOn,
    amount: booking.amount,
    platformCommission: booking.platformCommission,
    gymAmount: booking.gymAmount,
    status: booking.status,
    qrUsed: booking.qrUsed,
    payment: payment ? {
      provider: payment.provider,
      orderId: payment.providerOrderId,
      paymentId: payment.providerPaymentId,
      status: payment.status,
      currency: payment.currency,
    } : null,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

async function customerBooking(userId: number, reference: string) {
  const [booking] = await db.select().from(bookingsTable).where(and(
    eq(bookingsTable.reference, reference),
    eq(bookingsTable.userId, userId),
  ));
  return booking;
}

router.get("/bookings", authenticate, async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const [bookings, [{ value: total }]] = await Promise.all([
    db.select().from(bookingsTable)
      .where(eq(bookingsTable.userId, req.auth!.id))
      .orderBy(desc(bookingsTable.createdAt))
      .limit(size)
      .offset(offset),
    db.select({ value: count() }).from(bookingsTable).where(eq(bookingsTable.userId, req.auth!.id)),
  ]);
  success(res, pageData(await Promise.all(bookings.map(bookingData)), page, size, Number(total)));
});

router.post("/bookings", authenticate, paymentRateLimit, async (req, res): Promise<void> => {
  const gymId = integerParam(req.body?.gymId);
  const passId = integerParam(req.body?.passId);
  const bookingDate = req.body?.bookingDate;
  if (!gymId || !passId || !isDate(bookingDate)) {
    failure(res, 422, "gymId, passId, and a valid bookingDate (YYYY-MM-DD) are required", "VALIDATION_ERROR");
    return;
  }
  if (bookingDate < dateOnly(new Date())) {
    failure(res, 422, "Booking date cannot be in the past", "INVALID_BOOKING_DATE");
    return;
  }
  const [gym] = await db.select().from(gymsTable).where(and(eq(gymsTable.id, gymId), eq(gymsTable.status, "APPROVED")));
  const [pass] = await db.select().from(gymPassesTable).where(and(eq(gymPassesTable.id, passId), eq(gymPassesTable.gymId, gymId), eq(gymPassesTable.active, true)));
  if (!gym) {
    failure(res, 404, "Gym is not available", "GYM_NOT_FOUND");
    return;
  }
  if (!pass) {
    failure(res, 404, "Pass is not available", "PASS_NOT_FOUND");
    return;
  }
  const idempotencyKey = req.header("Idempotency-Key") ?? `booking-${req.auth!.id}-${gymId}-${passId}-${bookingDate}`;
  const [existingPayment] = await db.select().from(paymentsTable).where(eq(paymentsTable.idempotencyKey, idempotencyKey));
  if (existingPayment) {
    const [existingBooking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, existingPayment.bookingId));
    if (existingBooking) {
      success(res, { booking: await bookingData(existingBooking), payment: {
        orderId: existingPayment.providerOrderId,
        amount: existingPayment.amount,
        currency: existingPayment.currency,
        status: existingPayment.status,
      } }, "Booking already created");
      return;
    }
  }
  const commission = Number((pass.price * (await commissionPercentage()) / 100).toFixed(2));
  const reference = `GP-${randomUUID().slice(0, 8).toUpperCase()}`;
  const validUntil = addDays(bookingDate, Math.max(0, pass.durationDays - 1));
  const [booking] = await db.insert(bookingsTable).values({
    reference,
    userId: req.auth!.id,
    gymId,
    passId,
    customerName: req.body.customerName ?? "GymPass member",
    customerPhone: req.body.customerPhone ?? "",
    customerEmail: req.body.customerEmail ?? "",
    bookingDate,
    expiresOn: validUntil,
    validFrom: bookingDate,
    validUntil,
    amount: pass.price,
    platformCommission: commission,
    gymAmount: Number((pass.price - commission).toFixed(2)),
    status: "PAYMENT_PENDING",
    qrUsed: false,
  }).returning();
  let order;
  try {
    order = await createPaymentOrder({ amount: pass.price, receipt: reference });
  } catch (error) {
    await db.update(bookingsTable).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(bookingsTable.id, booking.id));
    logger.error({ err: error, bookingReference: reference }, "Payment order creation failed");
    failure(res, 502, "Payment provider is temporarily unavailable", "PAYMENT_PROVIDER_ERROR");
    return;
  }
  const [payment] = await db.insert(paymentsTable).values({
    bookingId: booking.id,
    provider: order.provider,
    providerOrderId: order.id,
    amount: pass.price,
    currency: order.currency,
    status: "CREATED",
    idempotencyKey,
  }).returning();
  success(res, {
    booking: await bookingData(booking),
    payment: { orderId: order.id, amount: order.amount, currency: order.currency, provider: order.provider, status: payment.status },
    checkout: order.provider === "RAZORPAY" ? { keyId: process.env.RAZORPAY_KEY_ID } : { mode: "demo" },
  }, "Booking created; payment is pending", 201);
});

router.get("/bookings/:reference", authenticate, async (req, res): Promise<void> => {
  const booking = await customerBooking(req.auth!.id, paramString(req.params.reference));
  if (!booking) {
    failure(res, 404, "Booking not found", "BOOKING_NOT_FOUND");
    return;
  }
  success(res, await bookingData(booking));
});

router.get("/bookings/:reference/qr", authenticate, async (req, res): Promise<void> => {
  const booking = await customerBooking(req.auth!.id, paramString(req.params.reference));
  if (!booking) {
    failure(res, 404, "Booking not found", "BOOKING_NOT_FOUND");
    return;
  }
  if (booking.status !== "CONFIRMED" || booking.qrUsed || !booking.qrToken) {
    failure(res, 409, "QR is not available for this booking", "QR_NOT_AVAILABLE");
    return;
  }
  success(res, { reference: booking.reference, qrToken: booking.qrToken, validFrom: booking.validFrom ?? booking.bookingDate, validUntil: booking.validUntil ?? booking.expiresOn });
});

router.post("/bookings/:reference/cancel", authenticate, async (req, res): Promise<void> => {
  const booking = await customerBooking(req.auth!.id, paramString(req.params.reference));
  if (!booking) {
    failure(res, 404, "Booking not found", "BOOKING_NOT_FOUND");
    return;
  }
  const today = dateOnly(new Date());
  if (!["PAYMENT_PENDING", "CONFIRMED"].includes(booking.status)) {
    failure(res, 409, "This booking cannot be cancelled", "BOOKING_NOT_CANCELLABLE");
    return;
  }
  const eligibleForRefund = today < (booking.validFrom ?? booking.bookingDate);
  const [updated] = await db.update(bookingsTable)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(bookingsTable.id, booking.id), eq(bookingsTable.userId, req.auth!.id), eq(bookingsTable.status, booking.status)))
    .returning();
  if (!updated) {
    failure(res, 409, "Booking changed before it could be cancelled", "BOOKING_CONFLICT");
    return;
  }
  success(res, { booking: await bookingData(updated), refundEligible: eligibleForRefund }, "Booking cancelled");
});

router.post("/payments/create-order", authenticate, paymentRateLimit, async (req, res): Promise<void> => {
  const reference = typeof req.body?.bookingReference === "string" ? req.body.bookingReference : "";
  const booking = await customerBooking(req.auth!.id, reference);
  if (!booking || booking.status !== "PAYMENT_PENDING") {
    failure(res, 404, "Pending booking not found", "BOOKING_NOT_FOUND");
    return;
  }
  const [existing] = await db.select().from(paymentsTable).where(eq(paymentsTable.bookingId, booking.id)).orderBy(desc(paymentsTable.createdAt)).limit(1);
  if (existing?.providerOrderId) {
    success(res, { orderId: existing.providerOrderId, amount: existing.amount, currency: existing.currency, status: existing.status });
    return;
  }
  const order = await createPaymentOrder({ amount: booking.amount, receipt: booking.reference });
  const [payment] = await db.insert(paymentsTable).values({
    bookingId: booking.id,
    provider: order.provider,
    providerOrderId: order.id,
    amount: booking.amount,
    currency: order.currency,
    status: "CREATED",
    idempotencyKey: req.header("Idempotency-Key") ?? `order-${booking.reference}`,
  }).returning();
  success(res, { orderId: order.id, amount: order.amount, currency: order.currency, provider: order.provider, status: payment.status });
});

router.post("/payments/webhook", async (req, res): Promise<void> => {
  if (!verifyWebhookSignature(req.rawBody ?? Buffer.from(JSON.stringify(req.body)), req.header("x-razorpay-signature"))) {
    failure(res, 401, "Invalid webhook signature", "INVALID_WEBHOOK_SIGNATURE");
    return;
  }
  const event = req.body as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string } } } };
  const paymentEntity = event.payload?.payment?.entity;
  const orderId = paymentEntity?.order_id;
  if (!orderId) {
    success(res, null, "Webhook ignored");
    return;
  }
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.providerOrderId, orderId));
  if (!payment) {
    success(res, null, "Webhook ignored");
    return;
  }
  const successful = event.event === "payment.captured" || event.event === "order.paid" || paymentEntity?.status === "captured";
  if (payment.status === "SUCCESS" && successful) {
    success(res, null, "Webhook already processed");
    return;
  }
  const paymentStatus = successful ? "SUCCESS" : event.event === "payment.failed" ? "FAILED" : "PENDING";
  const paidAt = successful ? new Date() : undefined;
  await db.transaction(async (tx) => {
    await tx.update(paymentsTable).set({
      status: paymentStatus,
      providerPaymentId: paymentEntity?.id ?? payment.providerPaymentId,
      paidAt,
      updatedAt: new Date(),
    }).where(and(eq(paymentsTable.id, payment.id), successful ? eq(paymentsTable.status, "CREATED") : eq(paymentsTable.id, payment.id)));
    if (successful) {
      const token = randomUUID();
      await tx.update(bookingsTable).set({
        status: "CONFIRMED",
        qrToken: token,
        qrTokenHash: hashToken(token),
        updatedAt: new Date(),
      }).where(and(eq(bookingsTable.id, payment.bookingId), eq(bookingsTable.status, "PAYMENT_PENDING")));
    }
  });
  logger.info({ orderId, event: event.event, paymentStatus }, "Payment webhook processed");
  success(res, null, "Webhook processed");
});

router.post("/checkins/verify", authenticate, requireRole("GYM_OWNER", "ADMIN"), async (req, res): Promise<void> => {
  const token = typeof req.body?.qrToken === "string" ? req.body.qrToken : "";
  if (token.length < 10) {
    failure(res, 422, "qrToken is required", "VALIDATION_ERROR");
    return;
  }
  const [booking] = await db.select().from(bookingsTable).where(or(
    eq(bookingsTable.qrTokenHash, hashToken(token)),
    eq(bookingsTable.qrToken, token),
  ));
  if (!booking) {
    failure(res, 409, "This QR pass is invalid", "INVALID_QR");
    return;
  }
  const [gym] = await db.select().from(gymsTable).where(eq(gymsTable.id, booking.gymId));
  if (!gym || (req.auth!.role === "GYM_OWNER" && gym.ownerId !== req.auth!.id)) {
    failure(res, 403, "This pass does not belong to your gym", "WRONG_GYM");
    return;
  }
  const today = dateOnly(new Date());
  const validUntil = booking.validUntil ?? booking.expiresOn;
  if (booking.status !== "CONFIRMED" || booking.qrUsed || today < (booking.validFrom ?? booking.bookingDate) || today > validUntil) {
    failure(res, 409, "This QR pass is expired, cancelled, or already used", "QR_NOT_VALID");
    return;
  }
  const [claimed] = await db.update(bookingsTable).set({
    status: "CHECKED_IN",
    qrUsed: true,
    updatedAt: new Date(),
  }).where(and(eq(bookingsTable.id, booking.id), eq(bookingsTable.status, "CONFIRMED"), eq(bookingsTable.qrUsed, false))).returning();
  if (!claimed) {
    failure(res, 409, "This QR pass has already been used", "QR_ALREADY_USED");
    return;
  }
  await db.insert(checkinsTable).values({ bookingId: claimed.id, gymId: claimed.gymId, checkedInBy: req.auth!.id });
  logger.info({ bookingReference: claimed.reference, gymId: claimed.gymId, checkedInBy: req.auth!.id }, "Gym check-in recorded");
  success(res, { booking: await bookingData(claimed) }, "Check-in successful");
});

router.get("/owner/bookings", authenticate, requireRole("GYM_OWNER", "ADMIN"), async (req, res): Promise<void> => {
  const ownerGymIds = req.auth!.role === "ADMIN" ? undefined : (await db.select({ id: gymsTable.id }).from(gymsTable).where(eq(gymsTable.ownerId, req.auth!.id))).map((gym) => gym.id);
  if (ownerGymIds && !ownerGymIds.length) {
    success(res, pageData([], 0, 20, 0));
    return;
  }
  const conditions = ownerGymIds ? ownerGymIds.map((id) => eq(bookingsTable.gymId, id)) : [];
  const [bookings] = await Promise.all([
    conditions.length ? db.select().from(bookingsTable).where(or(...conditions)).orderBy(desc(bookingsTable.createdAt)) : db.select().from(bookingsTable).orderBy(desc(bookingsTable.createdAt)),
  ]);
  success(res, pageData(await Promise.all(bookings.map(bookingData)), 0, bookings.length || 20, bookings.length));
});

router.get("/owner/revenue", authenticate, requireRole("GYM_OWNER", "ADMIN"), async (req, res): Promise<void> => {
  const gymIds = req.auth!.role === "ADMIN" ? (await db.select({ id: gymsTable.id }).from(gymsTable)).map((gym) => gym.id) : (await db.select({ id: gymsTable.id }).from(gymsTable).where(eq(gymsTable.ownerId, req.auth!.id))).map((gym) => gym.id);
  const bookings = gymIds.length ? await db.select().from(bookingsTable).where(or(...gymIds.map((id) => eq(bookingsTable.gymId, id)))) : [];
  success(res, {
    grossRevenue: bookings.filter((b) => !["CANCELLED", "REFUNDED"].includes(b.status)).reduce((sum, b) => sum + b.amount, 0),
    platformRevenue: bookings.reduce((sum, b) => sum + b.platformCommission, 0),
    gymRevenue: bookings.reduce((sum, b) => sum + b.gymAmount, 0),
    bookingCount: bookings.length,
  });
});

router.get("/owner/payouts", authenticate, requireRole("GYM_OWNER", "ADMIN"), async (req, res) => {
  const gymIds = req.auth!.role === "ADMIN" ? (await db.select({ id: gymsTable.id }).from(gymsTable)).map((gym) => gym.id) : (await db.select({ id: gymsTable.id }).from(gymsTable).where(eq(gymsTable.ownerId, req.auth!.id))).map((gym) => gym.id);
  const payouts = gymIds.length ? await db.select().from(payoutsTable).where(or(...gymIds.map((id) => eq(payoutsTable.gymId, id)))).orderBy(desc(payoutsTable.createdAt)) : [];
  success(res, payouts);
});

export default router;