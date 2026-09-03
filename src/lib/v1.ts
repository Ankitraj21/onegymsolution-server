import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db, gymsTable, gymPassesTable, reviewsTable, usersTable } from "@workspace/db";

export function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function paramString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function numberQuery(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function integerParam(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function pageParams(req: Request) {
  const page = Math.max(0, Math.floor(numberQuery(req.query.page) ?? 0));
  const size = Math.min(100, Math.max(1, Math.floor(numberQuery(req.query.size) ?? 20)));
  return { page, size, offset: page * size };
}

export function pageData<T>(items: T[], page: number, size: number, total: number) {
  return {
    items,
    page,
    size,
    totalItems: total,
    totalPages: Math.ceil(total / size),
  };
}

export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return dateOnly(result);
}

export function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

export async function gymForOwner(userId: number, gymId: number) {
  const [gym] = await db.select().from(gymsTable).where(eq(gymsTable.id, gymId));
  return gym?.ownerId === userId ? gym : null;
}

export function passData(pass: typeof gymPassesTable.$inferSelect) {
  return {
    id: pass.id,
    gymId: pass.gymId,
    name: pass.name,
    description: pass.description,
    durationInDays: pass.durationDays,
    visitCount: pass.visitCount,
    price: pass.price,
    active: pass.active,
    popular: pass.popular,
  };
}

export async function gymData(gym: typeof gymsTable.$inferSelect) {
  const [passes, reviews] = await Promise.all([
    db.select().from(gymPassesTable).where(eq(gymPassesTable.gymId, gym.id)),
    db.select().from(reviewsTable).where(eq(reviewsTable.gymId, gym.id)),
  ]);
  return {
    id: gym.id,
    slug: gym.slug,
    ownerId: gym.ownerId,
    name: gym.name,
    description: gym.description,
    address: gym.address,
    neighborhood: gym.neighborhood,
    city: gym.city,
    state: gym.state,
    pincode: gym.pincode,
    latitude: gym.latitude,
    longitude: gym.longitude,
    phone: gym.phone,
    email: gym.email,
    rating: gym.rating,
    reviewCount: gym.reviewCount,
    status: gym.status,
    imageUrl: gym.imageUrl,
    gallery: gym.gallery,
    facilities: gym.facilities,
    isOpen: gym.isOpen,
    openUntil: gym.openUntil,
    gymType: gym.gymType,
    hours: ["Monday - Friday", "Saturday", "Sunday"].map((day) => ({
      day,
      hours: day === "Sunday" ? "7:00 AM - 8:00 PM" : "6:00 AM - 11:00 PM",
    })),
    passes: passes.filter((pass) => pass.active).map(passData),
    reviews: reviews.map((review) => ({
      id: review.id,
      author: review.author,
      rating: review.rating,
      comment: review.comment,
      date: review.date,
    })),
  };
}

export function userData(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}