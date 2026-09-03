import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, gymsTable, gymPassesTable, gymImagesTable } from "@workspace/db";
import { authenticate, requireRole } from "../middlewares/auth";
import { failure, success } from "../lib/http";
import { gymData, gymForOwner, integerParam, numberQuery, pageData, pageParams, passData, queryString } from "../lib/v1";
import { ensureSeed } from "../lib/seed";

const router: IRouter = Router();
const publicStatuses = ["APPROVED", "ACTIVE"];

function haversineDistanceKm(latitude: number, longitude: number, targetLatitude: number, targetLongitude: number): number {
  const earthRadiusKm = 6371;
  const latitudeDelta = (targetLatitude - latitude) * Math.PI / 180;
  const longitudeDelta = (targetLongitude - longitude) * Math.PI / 180;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude * Math.PI / 180) * Math.cos(targetLatitude * Math.PI / 180) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get("/gyms/nearby", async (req, res): Promise<void> => {
  await ensureSeed();
  const latitude = numberQuery(req.query.latitude);
  const longitude = numberQuery(req.query.longitude);
  const radiusKm = numberQuery(req.query.radius) ?? 5;
  if (latitude === undefined || latitude < -90 || latitude > 90 || longitude === undefined || longitude < -180 || longitude > 180) {
    failure(res, 422, "Valid latitude and longitude are required", "LOCATION_VALIDATION_ERROR");
    return;
  }
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50) {
    failure(res, 422, "Radius must be greater than 0 and no more than 50 km", "RADIUS_VALIDATION_ERROR");
    return;
  }

  const latitudeDelta = radiusKm / 111;
  const longitudeDelta = radiusKm / (111 * Math.max(Math.cos(latitude * Math.PI / 180), 0.01));
  const candidates = await db.select().from(gymsTable).where(and(
    inArray(gymsTable.status, publicStatuses),
    isNotNull(gymsTable.latitude),
    isNotNull(gymsTable.longitude),
    sql`${gymsTable.latitude} BETWEEN ${latitude - latitudeDelta} AND ${latitude + latitudeDelta}`,
    sql`${gymsTable.longitude} BETWEEN ${longitude - longitudeDelta} AND ${longitude + longitudeDelta}`,
  ));
  const gyms = candidates
    .map((gym) => {
      if (gym.latitude === null || gym.longitude === null) return null;
      const distanceKm = haversineDistanceKm(gym.latitude, gym.longitude, latitude, longitude);
      if (distanceKm > radiusKm) return null;
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
        startingPrice: gym.startingPrice,
        isOpen: gym.isOpen,
        openUntil: gym.openUntil,
        gymType: gym.gymType,
        facilities: gym.facilities,
        latitude: gym.latitude,
        longitude: gym.longitude,
        distanceKm: Number(distanceKm.toFixed(2)),
      };
    })
    .filter((gym): gym is NonNullable<typeof gym> => gym !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  success(res, { userLocation: { latitude, longitude }, radiusKm, gyms });
});

router.get("/gyms", async (req, res): Promise<void> => {
  await ensureSeed();
  const { page, size, offset } = pageParams(req);
  const city = queryString(req.query.city);
  const search = queryString(req.query.search);
  const facility = queryString(req.query.facility);
  const radius = numberQuery(req.query.radius);
  const minimumRating = numberQuery(req.query.minimumRating) ?? numberQuery(req.query.minRating);
  const maximumPrice = numberQuery(req.query.maximumPrice) ?? numberQuery(req.query.maxPrice);
  const openNow = req.query.openNow === "true";
  const sort = queryString(req.query.sort);
  const latitude = numberQuery(req.query.latitude);
  const longitude = numberQuery(req.query.longitude);
  const filters = [inArray(gymsTable.status, publicStatuses)];
  if (city) filters.push(ilike(gymsTable.city, `%${city}%`));
  if (search) {
    const term = `%${search}%`;
    filters.push(or(
      ilike(gymsTable.name, term),
      ilike(gymsTable.neighborhood, term),
      ilike(gymsTable.city, term),
      ilike(gymsTable.gymType, term),
      sql`array_to_string(${gymsTable.facilities}, ' ') ILIKE ${term}`,
    )!);
  }
  if (minimumRating !== undefined) filters.push(gte(gymsTable.rating, minimumRating));
  if (maximumPrice !== undefined) filters.push(lte(gymsTable.startingPrice, maximumPrice));
  if (openNow) filters.push(eq(gymsTable.isOpen, true));
  if (facility) filters.push(sql`${facility} = ANY(${gymsTable.facilities})`);
  if (radius !== undefined) filters.push(lte(gymsTable.distanceKm, radius));
  if (latitude !== undefined && longitude !== undefined) {
    filters.push(sql`(${gymsTable.latitude} IS NULL OR ABS(${gymsTable.latitude} - ${latitude}) <= ${Math.max(radius ?? 5, 1) / 111})`);
    filters.push(sql`(${gymsTable.longitude} IS NULL OR ABS(${gymsTable.longitude} - ${longitude}) <= ${Math.max(radius ?? 5, 1) / 111})`);
  }
  const where = and(...filters);
  let query = db.select().from(gymsTable).where(where).limit(size).offset(offset);
  if (sort === "rating") query = query.orderBy(desc(gymsTable.rating)) as typeof query;
  else if (sort === "price") query = query.orderBy(asc(gymsTable.startingPrice)) as typeof query;
  else query = query.orderBy(asc(gymsTable.distanceKm)) as typeof query;
  const [gyms, [{ value: total }]] = await Promise.all([
    query,
    db.select({ value: count() }).from(gymsTable).where(where),
  ]);
  success(res, pageData(gyms.map((gym) => ({
    ...gym,
    ownerId: undefined,
    status: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  })), page, size, Number(total)));
});

router.get("/gyms/:id", async (req, res): Promise<void> => {
  await ensureSeed();
  const id = integerParam(req.params.id);
  if (!id) {
    failure(res, 400, "Gym id must be a positive integer", "VALIDATION_ERROR");
    return;
  }
  const [gym] = await db.select().from(gymsTable).where(and(eq(gymsTable.id, id), inArray(gymsTable.status, publicStatuses)));
  if (!gym) {
    failure(res, 404, "Gym not found", "GYM_NOT_FOUND");
    return;
  }
  success(res, await gymData(gym));
});

router.post("/owner/gyms", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const body = req.body;
  if (!body || typeof body.name !== "string" || body.name.trim().length < 2 || typeof body.address !== "string" || typeof body.city !== "string" || typeof body.phone !== "string") {
    failure(res, 422, "Name, address, city, and phone are required", "VALIDATION_ERROR");
    return;
  }
  const slug = `${body.name}-${body.city}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + `-${Date.now().toString(36)}`;
  const [gym] = await db.insert(gymsTable).values({
    ownerId: req.auth!.id,
    slug,
    name: body.name.trim(),
    neighborhood: typeof body.neighborhood === "string" ? body.neighborhood : body.city,
    city: body.city.trim(),
    address: body.address.trim(),
    state: typeof body.state === "string" ? body.state.trim() : null,
    pincode: typeof body.pincode === "string" ? body.pincode.trim() : null,
    latitude: numberQuery(body.latitude) ?? null,
    longitude: numberQuery(body.longitude) ?? null,
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : "",
    gallery: Array.isArray(body.gallery) ? body.gallery.filter((item: unknown): item is string => typeof item === "string") : [],
    description: typeof body.description === "string" ? body.description : "",
    phone: body.phone.trim(),
    email: typeof body.email === "string" ? body.email.trim() : null,
    gymType: typeof body.gymType === "string" ? body.gymType : "Fitness gym",
    facilities: Array.isArray(body.facilities) ? body.facilities.filter((item: unknown): item is string => typeof item === "string") : [],
    status: "PENDING_APPROVAL",
    isOpen: false,
    openUntil: "",
  }).returning();
  success(res, await gymData(gym), "Gym submitted for approval", 201);
});

router.get("/owner/gyms", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const gyms = await db.select().from(gymsTable).where(eq(gymsTable.ownerId, req.auth!.id));
  success(res, await Promise.all(gyms.map(gymData)));
});

router.get("/owner/gyms/:id", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const gym = id ? await gymForOwner(req.auth!.id, id) : null;
  if (!gym) {
    failure(res, 404, "Owned gym not found", "GYM_NOT_FOUND");
    return;
  }
  success(res, await gymData(gym));
});

router.put("/owner/gyms/:id", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const gym = id ? await gymForOwner(req.auth!.id, id) : null;
  if (!gym) {
    failure(res, 404, "Owned gym not found", "GYM_NOT_FOUND");
    return;
  }
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const update = Object.fromEntries(Object.entries({
    name: body.name,
    description: body.description,
    address: body.address,
    city: body.city,
    state: body.state,
    pincode: body.pincode,
    phone: body.phone,
    email: body.email,
    imageUrl: body.imageUrl,
    gallery: Array.isArray(body.gallery) ? body.gallery : undefined,
    facilities: Array.isArray(body.facilities) ? body.facilities : undefined,
    latitude: numberQuery(body.latitude),
    longitude: numberQuery(body.longitude),
    updatedAt: new Date(),
  }).filter(([, value]) => value !== undefined));
  const [updated] = await db.update(gymsTable).set(update).where(eq(gymsTable.id, gym.id)).returning();
  success(res, await gymData(updated));
});

router.post("/owner/gyms/:id/images", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const gym = id ? await gymForOwner(req.auth!.id, id) : null;
  if (!gym || typeof req.body?.imageUrl !== "string" || !req.body.imageUrl.trim()) {
    failure(res, 422, "Owned gym and imageUrl are required", "VALIDATION_ERROR");
    return;
  }
  const [image] = await db.insert(gymImagesTable).values({
    gymId: gym.id,
    imageUrl: req.body.imageUrl.trim(),
    displayOrder: numberQuery(req.body.displayOrder) ?? 0,
  }).returning();
  success(res, image, "Image added", 201);
});

router.delete("/owner/gyms/:id/images/:imageId", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  const imageId = integerParam(req.params.imageId);
  const gym = gymId ? await gymForOwner(req.auth!.id, gymId) : null;
  if (!gym || !imageId) {
    failure(res, 404, "Image not found", "IMAGE_NOT_FOUND");
    return;
  }
  const deleted = await db.delete(gymImagesTable).where(and(eq(gymImagesTable.id, imageId), eq(gymImagesTable.gymId, gym.id))).returning({ id: gymImagesTable.id });
  if (!deleted.length) {
    failure(res, 404, "Image not found", "IMAGE_NOT_FOUND");
    return;
  }
  success(res, null, "Image removed");
});

router.post("/owner/gyms/:id/passes", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  const gym = gymId ? await gymForOwner(req.auth!.id, gymId) : null;
  const body = req.body;
  if (!gym || !body || typeof body.name !== "string" || numberQuery(body.durationInDays) === undefined || numberQuery(body.visitCount) === undefined || numberQuery(body.price) === undefined || numberQuery(body.price)! <= 0) {
    failure(res, 422, "Owned gym, name, durationInDays, visitCount, and positive price are required", "VALIDATION_ERROR");
    return;
  }
  const [pass] = await db.insert(gymPassesTable).values({
    gymId: gym.id,
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description : "",
    durationDays: Math.floor(numberQuery(body.durationInDays)!),
    visitCount: Math.floor(numberQuery(body.visitCount)!),
    price: numberQuery(body.price)!,
    active: body.active !== false,
    popular: body.popular === true,
  }).returning();
  success(res, passData(pass), "Pass created", 201);
});

router.put("/owner/gyms/:id/passes/:passId", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  const passId = integerParam(req.params.passId);
  const gym = gymId ? await gymForOwner(req.auth!.id, gymId) : null;
  if (!gym || !passId) {
    failure(res, 404, "Pass not found", "PASS_NOT_FOUND");
    return;
  }
  const [pass] = await db.select().from(gymPassesTable).where(and(eq(gymPassesTable.id, passId), eq(gymPassesTable.gymId, gym.id)));
  if (!pass) {
    failure(res, 404, "Pass not found", "PASS_NOT_FOUND");
    return;
  }
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const update = Object.fromEntries(Object.entries({
    name: typeof body.name === "string" ? body.name.trim() : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    durationDays: numberQuery(body.durationInDays) !== undefined ? Math.floor(numberQuery(body.durationInDays)!) : undefined,
    visitCount: numberQuery(body.visitCount) !== undefined ? Math.floor(numberQuery(body.visitCount)!) : undefined,
    price: numberQuery(body.price),
    active: typeof body.active === "boolean" ? body.active : undefined,
    popular: typeof body.popular === "boolean" ? body.popular : undefined,
    updatedAt: new Date(),
  }).filter(([, value]) => value !== undefined));
  const [updated] = await db.update(gymPassesTable).set(update).where(eq(gymPassesTable.id, pass.id)).returning();
  success(res, passData(updated));
});

router.delete("/owner/gyms/:id/passes/:passId", authenticate, requireRole("GYM_OWNER"), async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  const passId = integerParam(req.params.passId);
  const gym = gymId ? await gymForOwner(req.auth!.id, gymId) : null;
  if (!gym || !passId) {
    failure(res, 404, "Pass not found", "PASS_NOT_FOUND");
    return;
  }
  const [pass] = await db.update(gymPassesTable).set({ active: false, updatedAt: new Date() }).where(and(eq(gymPassesTable.id, passId), eq(gymPassesTable.gymId, gym.id))).returning();
  if (!pass) {
    failure(res, 404, "Pass not found", "PASS_NOT_FOUND");
    return;
  }
  success(res, null, "Pass archived");
});

export default router;