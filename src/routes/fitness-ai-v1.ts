import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  aiChatMessagesTable,
  aiChatSessionsTable,
  db,
  fitnessPlansTable,
  fitnessProfilesTable,
  fitnessProgressTable,
  bodyMeasurementsTable,
  fitnessGoalsTable,
  gymVisitsTable,
  gymsTable,
  usersTable,
  workoutSessionsTable,
} from "@workspace/db";
import { createDirectOpenAIClient } from "@workspace/integrations-openai-ai-server/fallback";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rate-limit";
import { failure, success } from "../lib/http";
import { integerParam } from "../lib/v1";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const aiRateLimit = rateLimit({ windowMs: 60_000, max: 15 });
const publicGymStatuses = ["APPROVED", "ACTIVE"];

type JsonRecord = Record<string, unknown>;
type GymRow = typeof gymsTable.$inferSelect;

const profileFields = [
  "age", "gender", "heightCm", "weightKg", "targetWeightKg", "fitnessGoal",
  "activityLevel", "trainingExperience", "preferredTrainingDays",
  "workoutDurationMinutes", "dietaryPreference", "foodAllergies",
  "foodRestrictions", "preferredFoods", "foodsToAvoid", "budgetMonthly",
  "preferredGymDistanceKm", "preferredWorkoutType", "availableEquipment",
  "injuriesOrLimitations",
] as const;

const systemPrompt = `You are OneGym AI, a practical Indian fitness assistant inside OneGymSolution.
Use the user's stored fitness profile and the conversation context. Prefer familiar Indian foods and metric units.
Never diagnose disease, prescribe medication or treatment, encourage extreme dieting, or pretend to be a doctor or physiotherapist.
For pain, injury, pregnancy, eating disorders, medical conditions, or alarming symptoms, give conservative general guidance and recommend an appropriate qualified professional.
Nutrition advice is general guidance. Mention professional support when allergies, medical nutrition needs, or eating disorders are relevant.
Never invent gyms. You may only recommend gyms included in the supplied REAL_GYMS data, using their exact numeric IDs.
Be concise, supportive, specific, and honest about uncertainty.`;

function objectBody(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown, max = 5000): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 30);
}

function cleanProfileInput(body: JsonRecord): Partial<typeof fitnessProfilesTable.$inferInsert> {
  const result: JsonRecord = {};
  for (const field of profileFields) {
    const value = body[field];
    if (["foodAllergies", "foodRestrictions", "preferredFoods", "foodsToAvoid", "availableEquipment", "injuriesOrLimitations"].includes(field)) {
      const list = stringList(value);
      if (list) result[field] = list;
    } else if (["age", "preferredTrainingDays", "workoutDurationMinutes", "budgetMonthly"].includes(field)) {
      const number = finiteNumber(value, 0, field === "age" ? 120 : field === "budgetMonthly" ? 1_000_000 : 1000);
      if (number !== undefined) result[field] = Math.round(number);
    } else if (["heightCm", "weightKg", "targetWeightKg", "preferredGymDistanceKm"].includes(field)) {
      const number = finiteNumber(value, 0, field === "heightCm" ? 260 : field === "preferredGymDistanceKm" ? 100 : 500);
      if (number !== undefined) result[field] = number;
    } else {
      const valueText = text(value, 200);
      if (valueText) result[field] = valueText;
    }
  }
  return result as Partial<typeof fitnessProfilesTable.$inferInsert>;
}

async function profileFor(userId: number) {
  const [profile] = await db.select().from(fitnessProfilesTable).where(eq(fitnessProfilesTable.userId, userId));
  return profile ?? null;
}

async function trackingContextFor(userId: number): Promise<JsonRecord> {
  const [workouts, visits, measurements, goals] = await Promise.all([
    db.select().from(workoutSessionsTable).where(eq(workoutSessionsTable.userId, userId)).orderBy(desc(workoutSessionsTable.completedAt)).limit(20),
    db.select().from(gymVisitsTable).where(eq(gymVisitsTable.userId, userId)).orderBy(desc(gymVisitsTable.checkInTime)).limit(20),
    db.select().from(bodyMeasurementsTable).where(eq(bodyMeasurementsTable.userId, userId)).orderBy(desc(bodyMeasurementsTable.recordedAt)).limit(10),
    db.select().from(fitnessGoalsTable).where(eq(fitnessGoalsTable.userId, userId)).orderBy(desc(fitnessGoalsTable.updatedAt)).limit(10),
  ]);
  const monthStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentMonthWorkouts = workouts.filter((workout) => workout.completedAt.getTime() >= monthStart);
  const activeDays = new Set(recentMonthWorkouts.map((workout) => workout.completedAt.toISOString().slice(0, 10)));
  const muscleCounts = new Map<string, number>();
  for (const workout of recentMonthWorkouts) {
    for (const bodyPart of workout.bodyParts ?? []) {
      const muscle = bodyPart.trim();
      if (muscle) muscleCounts.set(muscle, (muscleCounts.get(muscle) ?? 0) + 1);
    }
  }
  const personalRecords = workouts.flatMap((workout) => Array.isArray(workout.personalRecords)
    ? workout.personalRecords.filter((record): record is JsonRecord => Boolean(record && typeof record === "object" && !Array.isArray(record))).slice(0, 20)
    : []).slice(0, 12);
  return {
    recentWorkouts: workouts,
    recentGymVisits: visits,
    recentMeasurements: measurements,
    fitnessGoals: goals,
    dashboardSignals: {
      fitnessScore: Math.round(Math.min(100, (activeDays.size / 12) * 60 + (recentMonthWorkouts.length / 12) * 40)),
      activeDaysThisMonth: activeDays.size,
      muscleBalance: [...muscleCounts.entries()].sort(([, a], [, b]) => b - a).slice(0, 8).map(([name, sessions]) => ({ name, sessions })),
      bodyTrends: measurements.slice(0, 8).reverse().map((measurement) => ({
        date: measurement.recordedAt.toISOString().slice(0, 10),
        weightKg: measurement.weightKg ?? null,
        bodyFatPercentage: measurement.bodyFatPercentage ?? null,
      })),
      personalRecords,
      todayRecommendation: recentMonthWorkouts.some((workout) => workout.completedAt.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10))
        ? "Recovery is part of today's training."
        : "Suggest a practical session that fits today's available energy.",
    },
  };
}

function distanceKm(gym: GymRow, latitude?: number, longitude?: number): number | null {
  if (latitude === undefined || longitude === undefined || gym.latitude === null || gym.longitude === null) return null;
  const radius = 6371;
  const dLat = (gym.latitude - latitude) * Math.PI / 180;
  const dLon = (gym.longitude - longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(latitude * Math.PI / 180) * Math.cos(gym.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Number((radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
}

async function realGyms(latitude?: number, longitude?: number) {
  const gyms = await db.select().from(gymsTable)
    .where(inArray(gymsTable.status, publicGymStatuses))
    .orderBy(desc(gymsTable.rating))
    .limit(40);
  return gyms.map((gym) => ({
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
    facilities: gym.facilities,
    gymType: gym.gymType,
    isOpen: gym.isOpen,
    openUntil: gym.openUntil,
    latitude: gym.latitude,
    longitude: gym.longitude,
    distanceKm: distanceKm(gym, latitude, longitude),
  })).sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
    return b.rating - a.rating;
  });
}

function parseJson(content: string): JsonRecord {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AI returned an invalid structured response");
  return parsed as JsonRecord;
}

function providerFailure(res: Parameters<typeof failure>[0], error: unknown, operation: string): void {
  logger.error({ err: error, operation }, "AI provider request failed");
  failure(res, 502, "Your AI Coach is temporarily unavailable. Please try again.", "AI_PROVIDER_ERROR");
}

async function completeJson(instruction: string, context: JsonRecord): Promise<JsonRecord> {
  const usingDirectProvider = Boolean(process.env.OPENAI_API_KEY);
  const client = usingDirectProvider
    ? createDirectOpenAIClient(process.env.OPENAI_API_KEY!)
    : (await import("@workspace/integrations-openai-ai-server")).openai;
  const model = process.env.OPENAI_MODEL || (usingDirectProvider ? "gpt-5.4" : "gpt-5.6-terra");
  logger.info({ provider: usingDirectProvider ? "openai_direct" : "replit_managed", model }, "AI provider selected");
  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${instruction}\n\nCONTEXT:\n${JSON.stringify(context)}` },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("AI response was empty");
  return parseJson(content);
}

async function upsertProfile(userId: number, input: Partial<typeof fitnessProfilesTable.$inferInsert>) {
  const existing = await profileFor(userId);
  if (existing) {
    const [updated] = await db.update(fitnessProfilesTable)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(fitnessProfilesTable.userId, userId))
      .returning();
    return updated;
  }
  const [created] = await db.insert(fitnessProfilesTable).values({ userId, ...input }).returning();
  return created;
}

router.get("/fitness-profile", authenticate, async (req, res) => {
  const [profile, user] = await Promise.all([
    profileFor(req.auth!.id),
    db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, req.auth!.id)).then((rows) => rows[0]),
  ]);
  success(res, profile ?? { userId: req.auth!.id, name: user?.name ?? "", foodAllergies: [], foodRestrictions: [], preferredFoods: [], foodsToAvoid: [], availableEquipment: [], injuriesOrLimitations: [] });
});

router.put("/fitness-profile", authenticate, async (req, res): Promise<void> => {
  const body = objectBody(req.body);
  if (!body) return failure(res, 422, "A fitness profile object is required", "VALIDATION_ERROR");
  success(res, await upsertProfile(req.auth!.id, cleanProfileInput(body)), "Fitness profile saved");
});

router.get("/progress", authenticate, async (req, res) => {
  const entries = await db.select().from(fitnessProgressTable)
    .where(eq(fitnessProgressTable.userId, req.auth!.id))
    .orderBy(desc(fitnessProgressTable.recordedAt))
    .limit(100);
  success(res, entries);
});

router.post("/progress", authenticate, async (req, res): Promise<void> => {
  const body = objectBody(req.body);
  if (!body) return failure(res, 422, "Progress values are required", "VALIDATION_ERROR");
  const values = {
    userId: req.auth!.id,
    weightKg: finiteNumber(body.weightKg, 20, 500),
    calories: finiteNumber(body.calories, 0, 20_000),
    proteinGrams: finiteNumber(body.proteinGrams, 0, 1000),
    steps: finiteNumber(body.steps, 0, 200_000),
    workoutsCompleted: finiteNumber(body.workoutsCompleted, 0, 100),
    note: text(body.note, 1000),
  };
  if (Object.values(values).filter((value) => value !== undefined).length <= 1) {
    return failure(res, 422, "Add at least one progress measurement", "VALIDATION_ERROR");
  }
  const [entry] = await db.insert(fitnessProgressTable).values(values).returning();
  success(res, entry, "Progress recorded", 201);
});

router.get("/ai/sessions", authenticate, async (req, res) => {
  const sessions = await db.select().from(aiChatSessionsTable)
    .where(eq(aiChatSessionsTable.userId, req.auth!.id))
    .orderBy(desc(aiChatSessionsTable.updatedAt))
    .limit(30);
  success(res, sessions);
});

router.get("/ai/sessions/:id/messages", authenticate, async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  if (!id) return failure(res, 422, "Invalid conversation", "VALIDATION_ERROR");
  const [session] = await db.select().from(aiChatSessionsTable)
    .where(and(eq(aiChatSessionsTable.id, id), eq(aiChatSessionsTable.userId, req.auth!.id)));
  if (!session) return failure(res, 404, "Conversation not found", "NOT_FOUND");
  const messages = await db.select().from(aiChatMessagesTable)
    .where(and(eq(aiChatMessagesTable.sessionId, id), eq(aiChatMessagesTable.userId, req.auth!.id)))
    .orderBy(aiChatMessagesTable.createdAt);
  success(res, { session, messages });
});

router.delete("/ai/sessions/:id", authenticate, async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  if (!id) return failure(res, 422, "Invalid conversation", "VALIDATION_ERROR");
  const deleted = await db.delete(aiChatSessionsTable)
    .where(and(eq(aiChatSessionsTable.id, id), eq(aiChatSessionsTable.userId, req.auth!.id)))
    .returning({ id: aiChatSessionsTable.id });
  if (!deleted.length) return failure(res, 404, "Conversation not found", "NOT_FOUND");
  success(res, { id }, "Conversation deleted");
});

router.post("/ai/chat", authenticate, aiRateLimit, async (req, res): Promise<void> => {
  const body = objectBody(req.body);
  const message = text(body?.message);
  if (!message) return failure(res, 422, "Message is required", "VALIDATION_ERROR");
  let sessionId = integerParam(body?.sessionId);
  let session = sessionId
    ? (await db.select().from(aiChatSessionsTable).where(and(eq(aiChatSessionsTable.id, sessionId), eq(aiChatSessionsTable.userId, req.auth!.id))))[0]
    : undefined;
  if (!session) {
    const [created] = await db.insert(aiChatSessionsTable).values({ userId: req.auth!.id, title: message.slice(0, 70) }).returning();
    session = created;
    sessionId = created.id;
  }
  const resolvedSessionId = session.id;
  await db.insert(aiChatMessagesTable).values({ sessionId: resolvedSessionId, userId: req.auth!.id, role: "user", content: message });
  const history = await db.select({ role: aiChatMessagesTable.role, content: aiChatMessagesTable.content })
    .from(aiChatMessagesTable)
    .where(and(eq(aiChatMessagesTable.sessionId, resolvedSessionId), eq(aiChatMessagesTable.userId, req.auth!.id)))
    .orderBy(desc(aiChatMessagesTable.createdAt))
    .limit(12);
  const latitude = finiteNumber(body?.latitude, -90, 90);
  const longitude = finiteNumber(body?.longitude, -180, 180);
  const wantsGym = /\bgym|near me|nearby|trainer|pool|bodybuilding\b/i.test(message);
  const [profile, gyms, fitnessActivity] = await Promise.all([
    profileFor(req.auth!.id),
    wantsGym ? realGyms(latitude, longitude) : Promise.resolve([]),
    trackingContextFor(req.auth!.id),
  ]);
  let answer: JsonRecord;
  try {
    answer = await completeJson(
      `Reply to the latest message. Return JSON with keys: reply (string), responseType ("chat"|"gym_recommendation"), profileUpdates (object containing only clearly stated profile facts, otherwise {}), gymRecommendations (array of {gymId, reason}, only when relevant).`,
      { profile, fitnessActivity, recentMessages: history.reverse(), latestMessage: message, realGyms: gyms },
    );
  } catch (error) {
    providerFailure(res, error, "chat");
    return;
  }
  const reply = text(answer.reply, 12_000) ?? "I could not prepare a response. Please try again.";
  const updates = objectBody(answer.profileUpdates);
  if (updates && Object.keys(updates).length) await upsertProfile(req.auth!.id, cleanProfileInput(updates));
  const recommendations = Array.isArray(answer.gymRecommendations)
    ? answer.gymRecommendations.flatMap((item) => {
      const record = objectBody(item);
      const gymId = finiteNumber(record?.gymId, 1, Number.MAX_SAFE_INTEGER);
      const gym = gyms.find((candidate) => candidate.id === gymId);
      return gym ? [{ gym, reason: text(record?.reason, 600) ?? "A strong match for your preferences." }] : [];
    }).slice(0, 5)
    : [];
  const structuredData = recommendations.length ? { gymRecommendations: recommendations } : null;
  const [saved] = await db.insert(aiChatMessagesTable).values({
    sessionId: resolvedSessionId,
    userId: req.auth!.id,
    role: "assistant",
    content: reply,
    responseType: recommendations.length ? "gym_recommendation" : "chat",
    structuredData,
  }).returning();
  await db.update(aiChatSessionsTable).set({ updatedAt: new Date() }).where(eq(aiChatSessionsTable.id, resolvedSessionId));
  success(res, { sessionId: resolvedSessionId, message: saved, reply, gymRecommendations: recommendations });
});

router.post("/ai/diet/generate", authenticate, aiRateLimit, async (req, res): Promise<void> => {
  const body = objectBody(req.body) ?? {};
  const profile = { ...(await profileFor(req.auth!.id)), ...cleanProfileInput(body) };
  if (!profile.weightKg || !profile.heightCm || !profile.age || !profile.fitnessGoal) {
    return failure(res, 422, "Age, height, weight, and fitness goal are required", "PROFILE_INCOMPLETE");
  }
  let plan: JsonRecord;
  try {
    plan = await completeJson(
      `Create a safe, practical Indian diet plan. Return JSON with goal, dailyCalories, proteinGrams, carbsGrams, fatGrams, mealsPerDay, hydrationLitres, guidance, disclaimer, and meals. Each meal needs name, timing, foods; each food needs name, quantity, calories, proteinGrams, carbsGrams, fatGrams. Include dailyTotals. Do not use extreme calorie deficits.`,
      { profile },
    );
  } catch (error) {
    providerFailure(res, error, "diet_generation");
    return;
  }
  const [saved] = await db.insert(fitnessPlansTable).values({ userId: req.auth!.id, type: "diet", title: `${profile.fitnessGoal} diet plan`, content: plan }).returning();
  success(res, { id: saved.id, ...plan }, "Diet plan generated", 201);
});

router.post("/ai/workout/generate", authenticate, aiRateLimit, async (req, res): Promise<void> => {
  const body = objectBody(req.body) ?? {};
  const profile = { ...(await profileFor(req.auth!.id)), ...cleanProfileInput(body) };
  if (!profile.fitnessGoal || !profile.preferredTrainingDays || !profile.workoutDurationMinutes) {
    return failure(res, 422, "Fitness goal, training days, and workout duration are required", "PROFILE_INCOMPLETE");
  }
  let plan: JsonRecord;
  try {
    plan = await completeJson(
      `Create a progressive workout plan. Return JSON with goal, experienceLevel, daysPerWeek, durationMinutes, overview, safetyNote, and program. Each day needs day, focus, warmup, exercises, cooldown. Each exercise needs name, sets, reps, restSeconds, tempo, instructions, muscleGroups, alternatives. Respect injuries and available equipment; never prescribe injury treatment.`,
      { profile },
    );
  } catch (error) {
    providerFailure(res, error, "workout_generation");
    return;
  }
  const [saved] = await db.insert(fitnessPlansTable).values({ userId: req.auth!.id, type: "workout", title: `${profile.fitnessGoal} workout plan`, content: plan }).returning();
  success(res, { id: saved.id, ...plan }, "Workout plan generated", 201);
});

router.post("/ai/gym/recommend", authenticate, aiRateLimit, async (req, res): Promise<void> => {
  const body = objectBody(req.body) ?? {};
  const latitude = finiteNumber(body.latitude, -90, 90);
  const longitude = finiteNumber(body.longitude, -180, 180);
  const gyms = await realGyms(latitude, longitude);
  const profile = await profileFor(req.auth!.id);
  const preferences = text(body.query, 1000) ?? "Recommend the best matching gyms.";
  let ranked: JsonRecord;
  try {
    ranked = await completeJson(
      `Rank the supplied real gyms for the request. Return JSON with summary and recommendations, an array of {gymId, reason}. Never include an ID absent from REAL_GYMS.`,
      { profile, preferences, realGyms: gyms },
    );
  } catch (error) {
    providerFailure(res, error, "gym_recommendation");
    return;
  }
  const recommendations = Array.isArray(ranked.recommendations)
    ? ranked.recommendations.flatMap((item) => {
      const record = objectBody(item);
      const gymId = finiteNumber(record?.gymId, 1, Number.MAX_SAFE_INTEGER);
      const gym = gyms.find((candidate) => candidate.id === gymId);
      return gym ? [{ gym, reason: text(record?.reason, 600) ?? "A strong match." }] : [];
    }).slice(0, 8)
    : [];
  success(res, { summary: text(ranked.summary, 2000), recommendations });
});

router.post("/ai/progress/analyze", authenticate, aiRateLimit, async (req, res) => {
  const [profile, progress, fitnessActivity] = await Promise.all([
    profileFor(req.auth!.id),
    db.select().from(fitnessProgressTable).where(eq(fitnessProgressTable.userId, req.auth!.id)).orderBy(desc(fitnessProgressTable.recordedAt)).limit(30),
    trackingContextFor(req.auth!.id),
  ]);
  let analysis: JsonRecord;
  try {
    analysis = await completeJson(
      `Analyze the supplied user-entered progress without diagnosing. Return JSON with summary, wins (array), patterns (array), suggestions (array), safetyNote. Be honest when there is insufficient data.`,
      { profile, progress: progress.reverse(), fitnessActivity, question: text(objectBody(req.body)?.question, 1000) },
    );
  } catch (error) {
    providerFailure(res, error, "progress_analysis");
    return;
  }
  success(res, analysis);
});

router.get("/plans", authenticate, async (req, res) => {
  const plans = await db.select().from(fitnessPlansTable)
    .where(eq(fitnessPlansTable.userId, req.auth!.id))
    .orderBy(desc(fitnessPlansTable.updatedAt))
    .limit(30);
  success(res, plans);
});

export default router;