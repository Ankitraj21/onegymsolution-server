import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, bookingsTable, favoritesTable, gymsTable, reviewsTable, usersTable } from "@workspace/db";
import { authenticate, requireRole } from "../middlewares/auth";
import { failure, success } from "../lib/http";
import { integerParam, isDate, paramString } from "../lib/v1";

const router: IRouter = Router();

async function refreshGymRating(gymId: number): Promise<void> {
  const reviews = await db.select({ rating: reviewsTable.rating }).from(reviewsTable).where(eq(reviewsTable.gymId, gymId));
  const rating = reviews.length ? Number((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length).toFixed(1)) : 0;
  await db.update(gymsTable).set({ rating, reviewCount: reviews.length, updatedAt: new Date() }).where(eq(gymsTable.id, gymId));
}

function reviewData(review: typeof reviewsTable.$inferSelect) {
  return {
    id: review.id,
    gymId: review.gymId,
    bookingReference: undefined,
    author: review.author,
    rating: review.rating,
    comment: review.comment,
    date: review.date,
  };
}

router.get("/gyms/:id/reviews", async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  if (!gymId) {
    failure(res, 400, "Gym id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [gym] = await db.select({ id: gymsTable.id }).from(gymsTable).where(and(eq(gymsTable.id, gymId), inArray(gymsTable.status, ["APPROVED", "ACTIVE"])));
  if (!gym) {
    failure(res, 404, "Gym not found", "GYM_NOT_FOUND");
    return;
  }
  const reviews = await db.select().from(reviewsTable).where(eq(reviewsTable.gymId, gymId)).orderBy(desc(reviewsTable.date));
  success(res, reviews.map(reviewData));
});

router.post("/gyms/:id/reviews", authenticate, requireRole("CUSTOMER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  const rating = Number(req.body?.rating);
  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
  const reference = typeof req.body?.bookingReference === "string" ? req.body.bookingReference : "";
  if (!gymId || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length < 3 || !reference) {
    failure(res, 422, "bookingReference, rating from 1 to 5, and a comment are required", "VALIDATION_ERROR");
    return;
  }
  const [booking] = await db.select().from(bookingsTable).where(and(eq(bookingsTable.reference, reference), eq(bookingsTable.userId, req.auth!.id), eq(bookingsTable.gymId, gymId)));
  if (!booking || !["CHECKED_IN", "COMPLETED"].includes(booking.status)) {
    failure(res, 422, "A completed or checked-in booking is required to review this gym", "REVIEW_NOT_ELIGIBLE");
    return;
  }
  const [existing] = await db.select({ id: reviewsTable.id }).from(reviewsTable).where(and(eq(reviewsTable.userId, req.auth!.id), eq(reviewsTable.bookingId, booking.id)));
  if (existing) {
    failure(res, 409, "This booking has already been reviewed", "DUPLICATE_REVIEW");
    return;
  }
  const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, req.auth!.id));
  const [review] = await db.insert(reviewsTable).values({
    gymId,
    userId: req.auth!.id,
    bookingId: booking.id,
    author: user?.name ?? "GymPass member",
    rating,
    comment,
    date: isDate(booking.bookingDate) ? booking.bookingDate : new Date().toISOString().slice(0, 10),
  }).returning();
  await refreshGymRating(gymId);
  success(res, reviewData(review), "Review submitted", 201);
});

router.put("/reviews/:id", authenticate, async (req, res): Promise<void> => {
  const reviewId = integerParam(req.params.id);
  const rating = Number(req.body?.rating);
  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
  if (!reviewId || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length < 3) {
    failure(res, 422, "Rating from 1 to 5 and a comment are required", "VALIDATION_ERROR");
    return;
  }
  const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, reviewId));
  if (!review || (req.auth!.role !== "ADMIN" && review.userId !== req.auth!.id)) {
    failure(res, 404, "Review not found", "REVIEW_NOT_FOUND");
    return;
  }
  const [updated] = await db.update(reviewsTable).set({ rating, comment, updatedAt: new Date() }).where(eq(reviewsTable.id, reviewId)).returning();
  await refreshGymRating(review.gymId);
  success(res, reviewData(updated));
});

router.delete("/reviews/:id", authenticate, async (req, res): Promise<void> => {
  const reviewId = integerParam(req.params.id);
  if (!reviewId) {
    failure(res, 400, "Review id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [review] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, reviewId));
  if (!review || (req.auth!.role !== "ADMIN" && review.userId !== req.auth!.id)) {
    failure(res, 404, "Review not found", "REVIEW_NOT_FOUND");
    return;
  }
  await db.delete(reviewsTable).where(eq(reviewsTable.id, reviewId));
  await refreshGymRating(review.gymId);
  success(res, null, "Review deleted");
});

router.post("/favorites/:gymId", authenticate, requireRole("CUSTOMER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.gymId);
  if (!gymId) {
    failure(res, 400, "Gym id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [gym] = await db.select({ id: gymsTable.id }).from(gymsTable).where(and(eq(gymsTable.id, gymId), inArray(gymsTable.status, ["APPROVED", "ACTIVE"])));
  if (!gym) {
    failure(res, 404, "Gym not found", "GYM_NOT_FOUND");
    return;
  }
  const [favorite] = await db.insert(favoritesTable).values({ userId: req.auth!.id, gymId }).onConflictDoNothing().returning();
  success(res, favorite ?? { gymId, alreadyFavorite: true }, favorite ? "Gym added to favorites" : "Gym is already a favorite", favorite ? 201 : 200);
});

router.delete("/favorites/:gymId", authenticate, requireRole("CUSTOMER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.gymId);
  if (!gymId) {
    failure(res, 400, "Gym id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  await db.delete(favoritesTable).where(and(eq(favoritesTable.userId, req.auth!.id), eq(favoritesTable.gymId, gymId)));
  success(res, null, "Favorite removed");
});

router.get("/favorites", authenticate, requireRole("CUSTOMER"), async (req, res): Promise<void> => {
  const favorites = await db.select({ favorite: favoritesTable, gym: gymsTable })
    .from(favoritesTable)
    .innerJoin(gymsTable, eq(favoritesTable.gymId, gymsTable.id))
    .where(eq(favoritesTable.userId, req.auth!.id))
    .orderBy(desc(favoritesTable.createdAt));
  success(res, favorites.map(({ favorite, gym }) => ({
    id: favorite.id,
    createdAt: favorite.createdAt.toISOString(),
    gym: { id: gym.id, slug: gym.slug, name: gym.name, city: gym.city, address: gym.address, imageUrl: gym.imageUrl, rating: gym.rating },
  })));
});

export default router;