import { db, gymsTable, gymPassesTable, reviewsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function gymSummary(gym: typeof gymsTable.$inferSelect) {
  return {
    id: gym.id,
    slug: gym.slug,
    name: gym.name,
    neighborhood: gym.neighborhood,
    city: gym.city,
    address: gym.address,
    imageUrl: gym.imageUrl,
    rating: gym.rating,
    reviewCount: gym.reviewCount,
    distanceKm: gym.distanceKm,
    startingPrice: gym.startingPrice,
    isOpen: gym.isOpen,
    openUntil: gym.openUntil,
    gymType: gym.gymType,
    facilities: gym.facilities,
  };
}

export async function gymDetail(gym: typeof gymsTable.$inferSelect) {
  const [passes, reviews] = await Promise.all([
    db.select().from(gymPassesTable).where(eq(gymPassesTable.gymId, gym.id)),
    db.select().from(reviewsTable).where(eq(reviewsTable.gymId, gym.id)),
  ]);
  return {
    ...(await gymSummary(gym)),
    description: gym.description,
    phone: gym.phone,
    hours: ["Monday - Friday", "Saturday", "Sunday"].map((day) => ({ day, hours: day === "Sunday" ? "7:00 AM - 8:00 PM" : "6:00 AM - 11:00 PM" })),
    gallery: gym.gallery,
    passes,
    reviews,
  };
}