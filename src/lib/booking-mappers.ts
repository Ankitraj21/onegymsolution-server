import { db, bookingsTable, gymsTable, gymPassesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { gymSummary } from "./gym-mappers";

export async function bookingWithRelations(booking: typeof bookingsTable.$inferSelect) {
  const [[gym], [pass]] = await Promise.all([
    db.select().from(gymsTable).where(eq(gymsTable.id, booking.gymId)),
    db.select().from(gymPassesTable).where(eq(gymPassesTable.id, booking.passId)),
  ]);
  if (!gym || !pass) throw new Error("Booking references missing gym or pass");
  return {
    id: booking.id,
    reference: booking.reference,
    gym: await gymSummary(gym),
    pass,
    bookingDate: booking.bookingDate,
    expiresOn: booking.expiresOn,
    amount: booking.amount,
    status: booking.status,
    qrToken: booking.qrToken,
    qrUsed: booking.qrUsed,
    createdAt: booking.createdAt.toISOString(),
  };
}