import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, bookingsTable, gymsTable, gymPassesTable } from "@workspace/db";
import {
  CancelBookingParams,
  CancelBookingResponse,
  CheckInBookingBody,
  CheckInBookingParams,
  CheckInBookingResponse,
  CreateBookingBody,
  CreateBookingResponse,
  GetBookingParams,
  GetBookingResponse,
  ListBookingsResponse,
  GetOwnerSummaryResponse,
} from "@workspace/api-zod";
import { ensureSeed } from "../lib/seed";
import { bookingWithRelations } from "../lib/booking-mappers";

const router: IRouter = Router();

router.get("/bookings", async (_req, res): Promise<void> => {
  await ensureSeed();
  const bookings = await db.select().from(bookingsTable).orderBy(desc(bookingsTable.createdAt));
  res.json(ListBookingsResponse.parse(await Promise.all(bookings.map(bookingWithRelations))));
});

router.post("/bookings", async (req, res): Promise<void> => {
  await ensureSeed();
  const body = CreateBookingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [pass] = await db.select().from(gymPassesTable).where(eq(gymPassesTable.id, body.data.passId));
  if (!pass || !pass.active) {
    res.status(404).json({ error: "Pass not found or no longer available" });
    return;
  }
  const bookingDate = body.data.bookingDate.toISOString().slice(0, 10);
  const expires = new Date(body.data.bookingDate);
  expires.setDate(expires.getDate() + Math.max(0, pass.durationDays - 1));
  const expiresOn = expires.toISOString().slice(0, 10);
  const [booking] = await db.insert(bookingsTable).values({
    reference: `GP-${randomUUID().slice(0, 8).toUpperCase()}`,
    gymId: pass.gymId,
    passId: pass.id,
    customerName: body.data.customerName,
    customerPhone: body.data.customerPhone,
    customerEmail: body.data.customerEmail,
    bookingDate,
    expiresOn,
    amount: pass.price,
    status: "CONFIRMED",
    qrToken: randomUUID(),
    qrUsed: false,
  }).returning();
  res.status(201).json(CreateBookingResponse.parse(await bookingWithRelations(booking)));
});

router.get("/bookings/:reference", async (req, res): Promise<void> => {
  await ensureSeed();
  const params = GetBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.reference, params.data.reference));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  res.json(GetBookingResponse.parse(await bookingWithRelations(booking)));
});

router.post("/bookings/:reference/cancel", async (req, res): Promise<void> => {
  await ensureSeed();
  const params = CancelBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [booking] = await db.update(bookingsTable)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(eq(bookingsTable.reference, params.data.reference))
    .returning();
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  res.json(CancelBookingResponse.parse(await bookingWithRelations(booking)));
});

router.post("/bookings/:reference/checkin", async (req, res): Promise<void> => {
  await ensureSeed();
  const params = CheckInBookingParams.safeParse(req.params);
  const body = CheckInBookingBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.reference, params.data.reference));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (existing.qrToken !== body.data.qrToken || existing.qrUsed || existing.status !== "CONFIRMED") {
    res.status(409).json({ error: "This QR pass is invalid or has already been used" });
    return;
  }
  const [booking] = await db.update(bookingsTable)
    .set({ status: "CHECKED_IN", qrUsed: true, updatedAt: new Date() })
    .where(eq(bookingsTable.reference, params.data.reference))
    .returning();
  res.json(CheckInBookingResponse.parse({
    success: true,
    message: "Check-in successful",
    booking: await bookingWithRelations(booking),
  }));
});

router.get("/owner/summary", async (_req, res): Promise<void> => {
  await ensureSeed();
  const [gym] = await db.select().from(gymsTable).orderBy(gymsTable.id).limit(1);
  if (!gym) {
    res.status(404).json({ error: "Owner gym not found" });
    return;
  }
  const bookings = await db.select().from(bookingsTable).where(eq(bookingsTable.gymId, gym.id)).orderBy(desc(bookingsTable.createdAt));
  const customers = new Set(bookings.map((booking) => booking.customerEmail));
  const grossRevenue = bookings.reduce((sum, booking) => sum + booking.amount, 0);
  res.json(GetOwnerSummaryResponse.parse({
    gymName: gym.name,
    totalBookings: bookings.length,
    todaysBookings: bookings.filter((booking) => booking.bookingDate === new Date().toISOString().slice(0, 10)).length,
    totalCustomers: customers.size,
    grossRevenue,
    pendingPayout: grossRevenue * 0.8,
    rating: gym.rating,
    recentBookings: await Promise.all(bookings.slice(0, 5).map(bookingWithRelations)),
  }));
});

export default router;