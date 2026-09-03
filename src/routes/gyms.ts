import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, lte, gte, or, sql } from "drizzle-orm";
import { db, gymsTable, gymPassesTable } from "@workspace/db";
import {
  GetFeaturedGymsResponse,
  GetGymParams,
  GetGymResponse,
  GetPassParams,
  GetPassResponse,
  ListGymsQueryParams,
  ListGymsResponse,
} from "@workspace/api-zod";
import { ensureSeed } from "../lib/seed";
import { gymDetail, gymSummary } from "../lib/gym-mappers";

const router: IRouter = Router();

router.get("/gyms", async (req, res): Promise<void> => {
  await ensureSeed();
  const query = ListGymsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(gymsTable.status, "APPROVED")];
  if (query.data.city) filters.push(ilike(gymsTable.city, `%${query.data.city}%`));
  if (query.data.search) {
    const term = `%${query.data.search}%`;
    filters.push(or(
      ilike(gymsTable.name, term),
      ilike(gymsTable.neighborhood, term),
      ilike(gymsTable.city, term),
      ilike(gymsTable.gymType, term),
      sql`array_to_string(${gymsTable.facilities}, ' ') ILIKE ${term}`,
    )!);
  }
  if (query.data.maxPrice !== undefined) filters.push(lte(gymsTable.startingPrice, query.data.maxPrice));
  if (query.data.minRating !== undefined) filters.push(gte(gymsTable.rating, query.data.minRating));
  if (query.data.openNow) filters.push(eq(gymsTable.isOpen, true));

  let gymsQuery = db.select().from(gymsTable).where(and(...filters));
  if (query.data.sort === "rating") gymsQuery = gymsQuery.orderBy(desc(gymsTable.rating)) as typeof gymsQuery;
  if (query.data.sort === "price") gymsQuery = gymsQuery.orderBy(asc(gymsTable.startingPrice)) as typeof gymsQuery;
  if (query.data.sort === "distance" || !query.data.sort) gymsQuery = gymsQuery.orderBy(asc(gymsTable.distanceKm)) as typeof gymsQuery;
  const gyms = await gymsQuery;
  res.json(ListGymsResponse.parse(await Promise.all(gyms.map(gymSummary))));
});

router.get("/gyms/featured", async (_req, res): Promise<void> => {
  await ensureSeed();
  const gyms = await db.select().from(gymsTable).where(eq(gymsTable.status, "APPROVED"));
  const summaries = await Promise.all(gyms.map(gymSummary));
  res.json(GetFeaturedGymsResponse.parse({
    nearby: [...summaries].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 4),
    popular: [...summaries].sort((a, b) => b.reviewCount - a.reviewCount).slice(0, 4),
    bestRated: [...summaries].sort((a, b) => b.rating - a.rating).slice(0, 4),
    affordable: [...summaries].sort((a, b) => a.startingPrice - b.startingPrice).slice(0, 4),
  }));
});

router.get("/gyms/:slug", async (req, res): Promise<void> => {
  await ensureSeed();
  const params = GetGymParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [gym] = await db.select().from(gymsTable).where(eq(gymsTable.slug, params.data.slug));
  if (!gym) {
    res.status(404).json({ error: "Gym not found" });
    return;
  }
  res.json(GetGymResponse.parse(await gymDetail(gym)));
});

router.get("/passes/:id", async (req, res): Promise<void> => {
  await ensureSeed();
  const params = GetPassParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [pass] = await db.select().from(gymPassesTable).where(eq(gymPassesTable.id, params.data.id));
  if (!pass) {
    res.status(404).json({ error: "Pass not found" });
    return;
  }
  res.json(GetPassResponse.parse(pass));
});

export default router;