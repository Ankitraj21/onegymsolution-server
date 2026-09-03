import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, gte, gt, ilike, inArray, isNull, lte, lt, or, sql } from "drizzle-orm";
import {
  bodyMeasurementsTable,
  db,
  fitnessGoalsTable,
  fitnessProfilesTable,
  gymsTable,
  trainerAvailabilitiesTable,
  trainerAuditLogsTable,
  trainerCertificationsTable,
  trainerClientsTable,
  trainerEarningsTable,
  trainerGymsTable,
  trainerNotificationsTable,
  trainerProfilesTable,
  trainerPrivacyGrantsTable,
  trainerReviewsTable,
  trainerSessionsTable,
  trainerVisibilitySettingsTable,
  usersTable,
  workoutSessionsTable,
} from "@workspace/db";
import { failure, success } from "../lib/http";
import { authenticate, requireRole } from "../middlewares/auth";
import { integerParam, numberQuery, pageData, pageParams, queryString } from "../lib/v1";

const router: IRouter = Router();
const trainerOnly = [authenticate, requireRole("TRAINER")] as const;
const adminOnly = [authenticate, requireRole("ADMIN")] as const;
const activeSessionStatuses = ["CONFIRMED", "IN_PROGRESS", "COMPLETED"] as const;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function parseDateTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringList(value: unknown, max = 30): string[] | null {
  if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === "string" && item.trim())) return null;
  return value.map((item) => item.trim());
}

function integerValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

async function trainerForUser(userId: number) {
  const [trainer] = await db.select().from(trainerProfilesTable).where(eq(trainerProfilesTable.userId, userId));
  return trainer ?? null;
}

async function trainerById(id: number) {
  const [trainer] = await db.select().from(trainerProfilesTable).where(eq(trainerProfilesTable.id, id));
  return trainer ?? null;
}

async function trainerUser(trainerId: number) {
  const [result] = await db.select({ profile: trainerProfilesTable, user: usersTable })
    .from(trainerProfilesTable)
    .innerJoin(usersTable, eq(usersTable.id, trainerProfilesTable.userId))
    .where(eq(trainerProfilesTable.id, trainerId));
  return result ?? null;
}

async function visibilityFor(trainerId: number) {
  const [visibility] = await db.select().from(trainerVisibilitySettingsTable).where(eq(trainerVisibilitySettingsTable.trainerId, trainerId));
  return visibility ?? {
    trainerId,
    showProfileToMembers: true,
    showRatingToMembers: true,
    showExperienceToMembers: true,
    showCertificationsToMembers: true,
    showLanguagesToMembers: true,
    showSessionCountToMembers: true,
    showClientCountToMembers: true,
    showSpecializationsToMembers: true,
    showAvailabilityToMembers: true,
    showPricingToMembers: true,
    showReviewsToMembers: true,
  };
}

async function trainerMetrics(trainerId: number) {
  const [sessionTotal, completed, activeClients, reviews, rating] = await Promise.all([
    db.select({ value: count() }).from(trainerSessionsTable).where(eq(trainerSessionsTable.trainerId, trainerId)),
    db.select({ value: count() }).from(trainerSessionsTable).where(and(eq(trainerSessionsTable.trainerId, trainerId), eq(trainerSessionsTable.status, "COMPLETED"))),
    db.select({ value: count() }).from(trainerClientsTable).where(and(eq(trainerClientsTable.trainerId, trainerId), eq(trainerClientsTable.status, "ACTIVE"))),
    db.select({ value: count() }).from(trainerReviewsTable).where(and(eq(trainerReviewsTable.trainerId, trainerId), eq(trainerReviewsTable.moderationStatus, "VISIBLE"))),
    db.select({ value: sql<number>`coalesce(avg(${trainerReviewsTable.rating}), 0)` }).from(trainerReviewsTable).where(and(eq(trainerReviewsTable.trainerId, trainerId), eq(trainerReviewsTable.moderationStatus, "VISIBLE"))),
  ]);
  return {
    totalSessions: Number(sessionTotal[0]?.value ?? 0),
    completedSessions: Number(completed[0]?.value ?? 0),
    activeClients: Number(activeClients[0]?.value ?? 0),
    totalReviews: Number(reviews[0]?.value ?? 0),
    rating: Number(rating[0]?.value ?? 0),
  };
}

async function publicTrainer(trainerId: number) {
  const result = await trainerUser(trainerId);
  if (!result || result.profile.status !== "ACTIVE" || result.profile.adminVerificationStatus !== "VERIFIED") return null;
  const [certifications, visibility, metrics] = await Promise.all([
    db.select().from(trainerCertificationsTable).where(and(eq(trainerCertificationsTable.trainerId, trainerId), eq(trainerCertificationsTable.verificationStatus, "VERIFIED"))),
    visibilityFor(trainerId),
    trainerMetrics(trainerId),
  ]);
  if (!visibility.showProfileToMembers) return null;
  return {
    id: result.profile.id,
    userId: result.user.id,
    name: result.user.name,
    profilePhotoUrl: result.profile.profilePhotoStatus === "APPROVED" ? result.profile.profilePhotoUrl : null,
    city: result.profile.city,
    address: result.profile.address,
    bio: result.profile.bio,
    expertise: result.profile.expertise,
    trainingStyle: result.profile.trainingStyle,
    trainingLocation: result.profile.trainingLocation,
    specializations: visibility.showSpecializationsToMembers ? result.profile.specializations : [],
    languages: visibility.showLanguagesToMembers ? result.profile.languages : [],
    yearsExperience: visibility.showExperienceToMembers ? result.profile.yearsExperience : null,
    pricePerSessionMinor: visibility.showPricingToMembers ? result.profile.pricePerSessionMinor : null,
    rating: visibility.showRatingToMembers ? Number(metrics.rating.toFixed(2)) : null,
    reviewCount: visibility.showRatingToMembers ? metrics.totalReviews : null,
    sessionCount: visibility.showSessionCountToMembers ? metrics.completedSessions : null,
    clientCount: visibility.showClientCountToMembers ? metrics.activeClients : null,
    certifications: visibility.showCertificationsToMembers ? certifications.map((certification) => ({
      id: certification.id,
      name: certification.name,
      issuingOrganization: certification.issuingOrganization,
      issueDate: certification.issueDate,
      expiryDate: certification.expiryDate,
      verificationStatus: certification.verificationStatus,
    })) : [],
    availabilityVisible: visibility.showAvailabilityToMembers,
    createdAt: result.profile.createdAt.toISOString(),
  };
}

async function activeTrainerGym(trainerId: number, gymId: number) {
  const [result] = await db.select({ association: trainerGymsTable, gym: gymsTable })
    .from(trainerGymsTable)
    .innerJoin(gymsTable, eq(gymsTable.id, trainerGymsTable.gymId))
    .where(and(
      eq(trainerGymsTable.trainerId, trainerId),
      eq(trainerGymsTable.gymId, gymId),
      eq(trainerGymsTable.status, "ACTIVE"),
      inArray(gymsTable.status, ["APPROVED", "ACTIVE"]),
    ));
  return result ?? null;
}

async function publicTrainerAtGym(trainerId: number, gymId: number) {
  const [trainer, association] = await Promise.all([publicTrainer(trainerId), activeTrainerGym(trainerId, gymId)]);
  if (!trainer || !association) return null;
  const availability = await db.select().from(trainerAvailabilitiesTable).where(and(
    eq(trainerAvailabilitiesTable.trainerId, trainerId),
    eq(trainerAvailabilitiesTable.gymId, gymId),
    eq(trainerAvailabilitiesTable.active, true),
  )).orderBy(asc(trainerAvailabilitiesTable.dayOfWeek));
  return {
    ...trainer,
    gym: { id: association.gym.id, name: association.gym.name, slug: association.gym.slug, city: association.gym.city, address: association.gym.address },
    gymAssociationId: association.association.id,
    isPrimaryGym: association.association.isPrimaryGym,
    sessionPriceMinor: association.association.sessionPriceMinor,
    currency: association.association.currency,
    availability,
  };
}

async function requireActiveTrainer(req: Parameters<typeof authenticate>[0], res: Parameters<typeof authenticate>[1]) {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) {
    failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND");
    return null;
  }
  if (trainer.status !== "ACTIVE") {
    failure(res, 403, "Your trainer profile is awaiting approval or is not active", "TRAINER_NOT_ACTIVE");
    return null;
  }
  return trainer;
}

function sessionData(session: typeof trainerSessionsTable.$inferSelect, clientName?: string, gymName?: string) {
  return {
    id: session.id,
    trainerId: session.trainerId,
    clientId: session.clientId,
    clientName: clientName ?? null,
    gymId: session.gymId,
    gymName: gymName ?? null,
    sessionPriceMinor: session.sessionPriceMinor,
    currency: session.currency,
    title: session.title,
    scheduledStart: session.scheduledStart.toISOString(),
    scheduledEnd: session.scheduledEnd.toISOString(),
    durationMinutes: session.durationMinutes,
    status: session.status,
    startedAt: iso(session.startedAt),
    completedAt: iso(session.completedAt),
    cancelledAt: iso(session.cancelledAt),
    cancellationReason: session.cancellationReason,
    exercises: session.exercises,
    sharedNotes: session.sharedNotes,
    clientFeedback: session.clientFeedback,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

async function sessionWithNames(session: typeof trainerSessionsTable.$inferSelect) {
  const [[client], [gym]] = await Promise.all([
    db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, session.clientId)),
    session.gymId ? db.select({ name: gymsTable.name }).from(gymsTable).where(eq(gymsTable.id, session.gymId)) : Promise.resolve([]),
  ]);
  return sessionData(session, client?.name, gym?.name);
}

router.get("/trainer/profile", ...trainerOnly, async (req, res): Promise<void> => {
  const result = await trainerUser((await trainerForUser(req.auth!.id))?.id ?? 0);
  if (!result) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const [certifications, gyms, visibility, metrics] = await Promise.all([
    db.select().from(trainerCertificationsTable).where(eq(trainerCertificationsTable.trainerId, result.profile.id)).orderBy(desc(trainerCertificationsTable.createdAt)),
    db.select({ association: trainerGymsTable, gym: gymsTable }).from(trainerGymsTable).innerJoin(gymsTable, eq(gymsTable.id, trainerGymsTable.gymId)).where(eq(trainerGymsTable.trainerId, result.profile.id)),
    visibilityFor(result.profile.id),
    trainerMetrics(result.profile.id),
  ]);
  success(res, {
    ...result.profile,
    user: { id: result.user.id, name: result.user.name, email: result.user.email, phone: result.user.phone, role: result.user.role },
    certifications,
    gyms: gyms.map(({ association, gym }) => ({ ...association, gym: { id: gym.id, name: gym.name, city: gym.city, address: gym.address } })),
    visibility,
    metrics,
  });
});

router.put("/trainer/profile", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const update: Partial<typeof trainerProfilesTable.$inferInsert> = { updatedAt: new Date() };
  const simpleText = ["profilePhotoUrl", "gender", "city", "address", "expertise", "trainingStyle", "qualification", "bio", "trainingLocation"] as const;
  for (const key of simpleText) if (body[key] !== undefined) {
    if (typeof body[key] !== "string" || (key === "city" && !body[key].trim())) { failure(res, 422, `${key} must be valid`, "VALIDATION_ERROR"); return; }
    update[key] = body[key].trim();
  }
  const specializations = body.specializations === undefined ? undefined : stringList(body.specializations);
  const languages = body.languages === undefined ? undefined : stringList(body.languages);
  if (body.specializations !== undefined && (!specializations || !specializations.length)) { failure(res, 422, "At least one specialization is required", "VALIDATION_ERROR"); return; }
  if (body.languages !== undefined && (!languages || !languages.length)) { failure(res, 422, "At least one language is required", "VALIDATION_ERROR"); return; }
  if (specializations) { update.specializations = specializations; update.specialization = specializations[0]; }
  if (languages) update.languages = languages;
  if (body.yearsExperience !== undefined) {
    const years = integerValue(body.yearsExperience, -1);
    if (years < 0 || years > 60) { failure(res, 422, "Experience must be between 0 and 60 years", "VALIDATION_ERROR"); return; }
    update.yearsExperience = years;
  }
  if (body.pricePerSessionMinor !== undefined) {
    const price = integerValue(body.pricePerSessionMinor, -1);
    if (price < 0) { failure(res, 422, "Price must be a non-negative integer amount in minor units", "VALIDATION_ERROR"); return; }
    update.pricePerSessionMinor = price;
  }
  const [updated] = await db.update(trainerProfilesTable).set(update).where(eq(trainerProfilesTable.id, trainer.id)).returning();
  success(res, updated, "Trainer profile updated");
});

router.get("/trainer/certifications", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const certifications = await db.select().from(trainerCertificationsTable).where(eq(trainerCertificationsTable.trainerId, trainer.id)).orderBy(desc(trainerCertificationsTable.createdAt));
  success(res, certifications);
});

router.post("/trainer/certifications", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  if (!trainer || typeof body.name !== "string" || typeof body.issuingOrganization !== "string") { failure(res, 422, "Certification name and issuing organization are required", "VALIDATION_ERROR"); return; }
  const [certification] = await db.insert(trainerCertificationsTable).values({
    trainerId: trainer.id,
    name: body.name.trim(),
    issuingOrganization: body.issuingOrganization.trim(),
    certificationId: typeof body.certificationId === "string" ? body.certificationId.trim() : null,
    issueDate: typeof body.issueDate === "string" ? body.issueDate : null,
    expiryDate: typeof body.expiryDate === "string" ? body.expiryDate : null,
    documentPath: typeof body.documentPath === "string" ? body.documentPath : null,
  }).returning();
  success(res, certification, "Certification submitted for verification", 201);
});

router.get("/trainer/gyms", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const gyms = await db.select({ association: trainerGymsTable, gym: gymsTable })
    .from(trainerGymsTable)
    .innerJoin(gymsTable, eq(gymsTable.id, trainerGymsTable.gymId))
    .where(eq(trainerGymsTable.trainerId, trainer.id))
    .orderBy(desc(trainerGymsTable.isPrimaryGym), asc(gymsTable.name));
  success(res, gyms.map(({ association, gym }) => ({ ...association, gym: { id: gym.id, name: gym.name, slug: gym.slug, city: gym.city, address: gym.address } })));
});

router.post("/trainer/gyms", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await requireActiveTrainer(req, res);
  const gymId = integerParam(req.body?.gymId);
  if (!trainer || !gymId) { failure(res, 422, "An approved gym is required", "VALIDATION_ERROR"); return; }
  const [gym] = await db.select({ id: gymsTable.id }).from(gymsTable).where(and(eq(gymsTable.id, gymId), inArray(gymsTable.status, ["APPROVED", "ACTIVE"])));
  if (!gym) { failure(res, 404, "Gym not found", "GYM_NOT_FOUND"); return; }
  const price = integerValue(req.body?.sessionPriceMinor, -1);
  if (price < 0) { failure(res, 422, "A non-negative session price is required", "VALIDATION_ERROR"); return; }
  const [association] = await db.insert(trainerGymsTable).values({
    trainerId: trainer.id,
    gymId,
    sessionPriceMinor: price,
    currency: typeof req.body?.currency === "string" ? req.body.currency.trim().toUpperCase() : "INR",
    isPrimaryGym: req.body?.isPrimaryGym === true,
    status: "ACTIVE",
  }).returning();
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action: "TRAINER_GYM_ADDED", targetType: "TRAINER_GYM", targetId: association.id, metadata: { gymId } });
  success(res, association, "Gym association added", 201);
});

router.put("/trainer/gyms/:gymId", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await requireActiveTrainer(req, res);
  const gymId = integerParam(req.params.gymId);
  if (!trainer || !gymId) { failure(res, 422, "A valid gym is required", "VALIDATION_ERROR"); return; }
  const price = integerValue(req.body?.sessionPriceMinor, -1);
  if (price < 0) { failure(res, 422, "A non-negative session price is required", "VALIDATION_ERROR"); return; }
  const [association] = await db.update(trainerGymsTable).set({
    sessionPriceMinor: price,
    currency: typeof req.body?.currency === "string" ? req.body.currency.trim().toUpperCase() : "INR",
    isPrimaryGym: req.body?.isPrimaryGym === true,
    status: req.body?.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    leftAt: req.body?.status === "INACTIVE" ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(trainerGymsTable.trainerId, trainer.id), eq(trainerGymsTable.gymId, gymId))).returning();
  if (!association) { failure(res, 404, "Gym association not found", "TRAINER_GYM_NOT_FOUND"); return; }
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action: "TRAINER_GYM_UPDATED", targetType: "TRAINER_GYM", targetId: association.id, metadata: { gymId } });
  success(res, association, "Gym association updated");
});

router.get("/trainer/availability", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const gymId = integerParam(req.query.gymId);
  const filters = [eq(trainerAvailabilitiesTable.trainerId, trainer.id)];
  if (gymId) filters.push(eq(trainerAvailabilitiesTable.gymId, gymId));
  success(res, await db.select().from(trainerAvailabilitiesTable).where(and(...filters)).orderBy(asc(trainerAvailabilitiesTable.dayOfWeek)));
});

router.post("/trainer/availability", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await requireActiveTrainer(req, res);
  if (!trainer) return;
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const gymId = integerParam(body.gymId);
  const dayOfWeek = integerValue(body.dayOfWeek, -1);
  const startTime = typeof body.startTime === "string" ? body.startTime : "";
  const endTime = typeof body.endTime === "string" ? body.endTime : "";
  if (!gymId || !(await activeTrainerGym(trainer.id, gymId)) || dayOfWeek < 0 || dayOfWeek > 6 || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) {
    failure(res, 422, "A valid day and non-overlapping start/end time are required", "VALIDATION_ERROR"); return;
  }
  const values = {
    trainerId: trainer.id,
    gymId,
    dayOfWeek,
    startTime,
    endTime,
    breakStart: typeof body.breakStart === "string" ? body.breakStart : null,
    breakEnd: typeof body.breakEnd === "string" ? body.breakEnd : null,
    sessionDurationMinutes: integerValue(body.sessionDurationMinutes, 60),
    maxSessionsPerDay: integerValue(body.maxSessionsPerDay, 8),
    advanceBookingDays: integerValue(body.advanceBookingDays, 30),
    cancellationWindowHours: integerValue(body.cancellationWindowHours, 12),
    active: body.active !== false,
    updatedAt: new Date(),
  };
  const [existing] = await db.select({ id: trainerAvailabilitiesTable.id }).from(trainerAvailabilitiesTable).where(and(eq(trainerAvailabilitiesTable.trainerId, trainer.id), eq(trainerAvailabilitiesTable.gymId, gymId), eq(trainerAvailabilitiesTable.dayOfWeek, dayOfWeek)));
  const [availability] = existing
    ? await db.update(trainerAvailabilitiesTable).set(values).where(eq(trainerAvailabilitiesTable.id, existing.id)).returning()
    : await db.insert(trainerAvailabilitiesTable).values(values).returning();
  success(res, availability, existing ? "Availability updated" : "Availability created", existing ? 200 : 201);
});

router.get("/trainer/clients", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const { page, size, offset } = pageParams(req);
  const rows = await db.select({ relationship: trainerClientsTable, user: usersTable })
    .from(trainerClientsTable)
    .innerJoin(usersTable, eq(usersTable.id, trainerClientsTable.clientId))
    .where(eq(trainerClientsTable.trainerId, trainer.id))
    .orderBy(desc(trainerClientsTable.updatedAt))
    .limit(size).offset(offset);
  const [{ value: total }] = await db.select({ value: count() }).from(trainerClientsTable).where(eq(trainerClientsTable.trainerId, trainer.id));
  const items = await Promise.all(rows.map(async ({ relationship, user }) => {
    const [latestWorkout] = await db.select({ completedAt: workoutSessionsTable.completedAt }).from(workoutSessionsTable).where(eq(workoutSessionsTable.userId, user.id)).orderBy(desc(workoutSessionsTable.completedAt)).limit(1);
    return { id: relationship.id, clientId: user.id, name: user.name, status: relationship.status, startDate: relationship.startDate.toISOString(), lastSession: latestWorkout?.completedAt?.toISOString() ?? null };
  }));
  success(res, pageData(items, page, size, Number(total)));
});

router.get("/trainer/clients/:clientId", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  const clientId = integerParam(req.params.clientId);
  if (!trainer || !clientId) { failure(res, 404, "Client not found", "CLIENT_NOT_FOUND"); return; }
  const [relationship] = await db.select().from(trainerClientsTable).where(and(eq(trainerClientsTable.trainerId, trainer.id), eq(trainerClientsTable.clientId, clientId), eq(trainerClientsTable.status, "ACTIVE")));
  if (!relationship) { failure(res, 403, "You do not have an active relationship with this client", "CLIENT_ACCESS_DENIED"); return; }
  const [client] = await db.select({ id: usersTable.id, name: usersTable.name, createdAt: usersTable.createdAt }).from(usersTable).where(eq(usersTable.id, clientId));
  if (!client) { failure(res, 404, "Client not found", "CLIENT_NOT_FOUND"); return; }
  const grants = await db.select().from(trainerPrivacyGrantsTable).where(and(eq(trainerPrivacyGrantsTable.trainerId, trainer.id), eq(trainerPrivacyGrantsTable.clientId, clientId), eq(trainerPrivacyGrantsTable.allowed, true)));
  const fields = new Set(grants.map((grant) => grant.field));
  const [profile] = fields.has("profile") ? await db.select({ goal: fitnessProfilesTable.fitnessGoal, level: fitnessProfilesTable.trainingExperience, weightKg: fitnessProfilesTable.weightKg, targetWeightKg: fitnessProfilesTable.targetWeightKg }).from(fitnessProfilesTable).where(eq(fitnessProfilesTable.userId, clientId)) : [];
  const workouts = fields.has("workoutHistory") ? await db.select().from(workoutSessionsTable).where(eq(workoutSessionsTable.userId, clientId)).orderBy(desc(workoutSessionsTable.completedAt)).limit(20) : [];
  const measurements = fields.has("bodyMeasurements") ? await db.select().from(bodyMeasurementsTable).where(eq(bodyMeasurementsTable.userId, clientId)).orderBy(desc(bodyMeasurementsTable.recordedAt)).limit(20) : [];
  const goals = fields.has("goals") ? await db.select().from(fitnessGoalsTable).where(eq(fitnessGoalsTable.userId, clientId)).orderBy(desc(fitnessGoalsTable.updatedAt)) : [];
  const sessions = await db.select().from(trainerSessionsTable).where(and(eq(trainerSessionsTable.trainerId, trainer.id), eq(trainerSessionsTable.clientId, clientId))).orderBy(desc(trainerSessionsTable.scheduledStart)).limit(30);
  success(res, { client, relationship, sharedFields: [...fields], profile: profile ?? null, workouts, measurements, goals, sessions: await Promise.all(sessions.map((session) => sessionWithNames(session))) });
});

router.get("/trainer/sessions", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const status = queryString(req.query.status);
  const filters = [eq(trainerSessionsTable.trainerId, trainer.id)];
  if (status && ["REQUESTED", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED_BY_MEMBER", "CANCELLED_BY_TRAINER", "NO_SHOW"].includes(status)) filters.push(eq(trainerSessionsTable.status, status));
  const sessions = await db.select().from(trainerSessionsTable).where(and(...filters)).orderBy(desc(trainerSessionsTable.scheduledStart)).limit(100);
  success(res, await Promise.all(sessions.map((session) => sessionWithNames(session))));
});

router.post("/trainer/sessions", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await requireActiveTrainer(req, res);
  if (!trainer) return;
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const clientId = integerParam(body.clientId);
  const start = parseDateTime(body.scheduledStart);
  const end = parseDateTime(body.scheduledEnd);
  if (!clientId || !start || !end || end <= start || typeof body.title !== "string" || body.title.trim().length < 2) {
    failure(res, 422, "Client, title, and a valid session time are required", "VALIDATION_ERROR"); return;
  }
  const [relationship] = await db.select().from(trainerClientsTable).where(and(eq(trainerClientsTable.trainerId, trainer.id), eq(trainerClientsTable.clientId, clientId), eq(trainerClientsTable.status, "ACTIVE")));
  if (!relationship) { failure(res, 403, "An active trainer-client relationship is required", "CLIENT_ACCESS_DENIED"); return; }
  const conflict = await db.select({ id: trainerSessionsTable.id }).from(trainerSessionsTable).where(and(
    eq(trainerSessionsTable.trainerId, trainer.id),
    inArray(trainerSessionsTable.status, activeSessionStatuses as unknown as string[]),
    lt(trainerSessionsTable.scheduledStart, end),
    gt(trainerSessionsTable.scheduledEnd, start),
  )).limit(1);
  if (conflict.length) { failure(res, 409, "This time overlaps another session", "SESSION_CONFLICT"); return; }
  const [session] = await db.insert(trainerSessionsTable).values({
    trainerId: trainer.id,
    clientId,
    gymId: integerParam(body.gymId),
    title: body.title.trim(),
    scheduledStart: start,
    scheduledEnd: end,
    durationMinutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)),
    status: "CONFIRMED",
    trainerPrivateNotes: typeof body.trainerPrivateNotes === "string" ? body.trainerPrivateNotes.trim() : null,
    sharedNotes: typeof body.sharedNotes === "string" ? body.sharedNotes.trim() : null,
  }).returning();
  success(res, await sessionWithNames(session), "Session created", 201);
});

router.post("/trainers/:id/book", authenticate, requireRole("CUSTOMER"), async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  const gymId = integerParam(req.body?.gymId);
  const start = parseDateTime(req.body?.scheduledStart);
  const end = parseDateTime(req.body?.scheduledEnd);
  if (!trainerId || !gymId || !start || !end || end <= start) { failure(res, 422, "Trainer, gym, and a valid session time are required", "VALIDATION_ERROR"); return; }
  const trainer = await trainerById(trainerId);
  const association = trainer ? await activeTrainerGym(trainerId, gymId) : null;
  if (!trainer || trainer.status !== "ACTIVE" || trainer.adminVerificationStatus !== "VERIFIED" || !association) { failure(res, 404, "Trainer is not available at this gym", "TRAINER_UNAVAILABLE"); return; }
  const scheduledDay = start.getUTCDay();
  const [availability] = await db.select().from(trainerAvailabilitiesTable).where(and(
    eq(trainerAvailabilitiesTable.trainerId, trainerId),
    eq(trainerAvailabilitiesTable.gymId, gymId),
    eq(trainerAvailabilitiesTable.dayOfWeek, scheduledDay),
    eq(trainerAvailabilitiesTable.active, true),
  ));
  const startTime = start.toISOString().slice(11, 16);
  const endTime = end.toISOString().slice(11, 16);
  if (!availability || startTime < availability.startTime || endTime > availability.endTime) {
    failure(res, 409, "That time is outside the trainer's availability at this gym", "TIME_NOT_AVAILABLE");
    return;
  }
  const conflict = await db.select({ id: trainerSessionsTable.id }).from(trainerSessionsTable).where(and(eq(trainerSessionsTable.trainerId, trainerId), inArray(trainerSessionsTable.status, activeSessionStatuses as unknown as string[]), lt(trainerSessionsTable.scheduledStart, end), gt(trainerSessionsTable.scheduledEnd, start))).limit(1);
  if (conflict.length) { failure(res, 409, "That trainer is already booked for this time", "SESSION_CONFLICT"); return; }
  const result = await db.transaction(async (tx) => {
    const [relationship] = await tx.select().from(trainerClientsTable).where(and(eq(trainerClientsTable.trainerId, trainerId), eq(trainerClientsTable.clientId, req.auth!.id)));
    if (!relationship) {
      await tx.insert(trainerClientsTable).values({ trainerId, clientId: req.auth!.id, assignedBy: req.auth!.id, status: "ACTIVE" });
    } else if (relationship.status !== "ACTIVE") {
      await tx.update(trainerClientsTable).set({ status: "ACTIVE", endDate: null, updatedAt: new Date() }).where(eq(trainerClientsTable.id, relationship.id));
    }
    const [session] = await tx.insert(trainerSessionsTable).values({
      trainerId, clientId: req.auth!.id, gymId, sessionPriceMinor: association.association.sessionPriceMinor, currency: association.association.currency,
      title: typeof req.body?.title === "string" ? req.body.title.trim() : "Personal training session",
      scheduledStart: start, scheduledEnd: end, durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000), status: "REQUESTED",
    }).returning();
    await tx.insert(trainerNotificationsTable).values({ trainerId, type: "NEW_BOOKING", title: "New session request", body: "A member requested a personal training session." });
    return session;
  });
  success(res, await sessionWithNames(result), "Session request submitted", 201);
});

router.get("/gyms/:id/trainers", async (req, res): Promise<void> => {
  const gymId = integerParam(req.params.id);
  if (!gymId) { failure(res, 400, "Gym id must be a positive integer", "VALIDATION_ERROR"); return; }
  const gym = await db.select({ id: gymsTable.id, name: gymsTable.name, slug: gymsTable.slug, city: gymsTable.city, address: gymsTable.address })
    .from(gymsTable).where(and(eq(gymsTable.id, gymId), inArray(gymsTable.status, ["APPROVED", "ACTIVE"])));
  if (!gym.length) { failure(res, 404, "Gym not found", "GYM_NOT_FOUND"); return; }
  const specialization = queryString(req.query.specialization)?.toLowerCase();
  const language = queryString(req.query.language)?.toLowerCase();
  const minRating = numberQuery(req.query.ratingMin) ?? numberQuery(req.query.minRating);
  const minExperience = numberQuery(req.query.minExperience);
  const maxPrice = numberQuery(req.query.maxPrice);
  const availableToday = req.query.availableToday === "true";
  const sort = queryString(req.query.sort);
  const associations = await db.select({ association: trainerGymsTable, profile: trainerProfilesTable, user: usersTable })
    .from(trainerGymsTable)
    .innerJoin(trainerProfilesTable, eq(trainerProfilesTable.id, trainerGymsTable.trainerId))
    .innerJoin(usersTable, eq(usersTable.id, trainerProfilesTable.userId))
    .where(and(eq(trainerGymsTable.gymId, gymId), eq(trainerGymsTable.status, "ACTIVE"), eq(trainerProfilesTable.status, "ACTIVE"), eq(trainerProfilesTable.adminVerificationStatus, "VERIFIED")));
  const items = [];
  for (const row of associations) {
    if (specialization && !row.profile.specializations.some((item) => item.toLowerCase() === specialization)) continue;
    if (language && !row.profile.languages.some((item) => item.toLowerCase() === language)) continue;
    if (minExperience !== undefined && row.profile.yearsExperience < minExperience) continue;
    if (maxPrice !== undefined && (row.association.sessionPriceMinor ?? Number.MAX_SAFE_INTEGER) > maxPrice) continue;
    const item = await publicTrainerAtGym(row.profile.id, gymId);
    if (!item || (minRating !== undefined && (item.rating ?? 0) < minRating)) continue;
    if (availableToday && !item.availability.some((window) => window.dayOfWeek === new Date().getUTCDay())) continue;
    items.push({ ...item, gym: gym[0] });
  }
  items.sort((a, b) => {
    if (sort === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
    if (sort === "experience") return (b.yearsExperience ?? 0) - (a.yearsExperience ?? 0);
    if (sort === "sessions") return (b.sessionCount ?? 0) - (a.sessionCount ?? 0);
    if (sort === "price") return (a.sessionPriceMinor ?? Number.MAX_SAFE_INTEGER) - (b.sessionPriceMinor ?? Number.MAX_SAFE_INTEGER);
    return a.name.localeCompare(b.name);
  });
  success(res, { gym: gym[0], items, total: items.length });
});

router.put("/trainer/sessions/:id", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  const sessionId = integerParam(req.params.id);
  const nextStatus = req.body?.status;
  if (!trainer || !sessionId || !["CONFIRMED", "CANCELLED_BY_TRAINER", "NO_SHOW"].includes(nextStatus)) { failure(res, 422, "A valid session status is required", "VALIDATION_ERROR"); return; }
  const [session] = await db.select().from(trainerSessionsTable).where(and(eq(trainerSessionsTable.id, sessionId), eq(trainerSessionsTable.trainerId, trainer.id)));
  if (!session) { failure(res, 404, "Session not found", "SESSION_NOT_FOUND"); return; }
  if (nextStatus === "CONFIRMED" && session.status !== "REQUESTED") { failure(res, 409, "Only requested sessions can be accepted", "INVALID_SESSION_TRANSITION"); return; }
  if (nextStatus !== "CONFIRMED" && !["REQUESTED", "CONFIRMED"].includes(session.status)) { failure(res, 409, "This session can no longer be cancelled", "INVALID_SESSION_TRANSITION"); return; }
  const [updated] = await db.update(trainerSessionsTable).set({ status: nextStatus, cancelledAt: nextStatus.startsWith("CANCELLED") || nextStatus === "NO_SHOW" ? new Date() : null, cancellationReason: typeof req.body.reason === "string" ? req.body.reason.trim() : null, updatedAt: new Date() }).where(eq(trainerSessionsTable.id, session.id)).returning();
  success(res, await sessionWithNames(updated), "Session updated");
});

router.post("/trainer/sessions/:id/start", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await requireActiveTrainer(req, res);
  const sessionId = integerParam(req.params.id);
  if (!trainer || !sessionId) return;
  const [session] = await db.update(trainerSessionsTable).set({ status: "IN_PROGRESS", startedAt: new Date(), updatedAt: new Date() }).where(and(eq(trainerSessionsTable.id, sessionId), eq(trainerSessionsTable.trainerId, trainer.id), eq(trainerSessionsTable.status, "CONFIRMED"))).returning();
  if (!session) { failure(res, 409, "Only confirmed sessions can be started", "INVALID_SESSION_TRANSITION"); return; }
  success(res, await sessionWithNames(session), "Session started");
});

router.post("/trainer/sessions/:id/complete", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await requireActiveTrainer(req, res);
  const sessionId = integerParam(req.params.id);
  if (!trainer || !sessionId) return;
  const [session] = await db.update(trainerSessionsTable).set({
    status: "COMPLETED",
    completedAt: new Date(),
    exercises: Array.isArray(req.body?.exercises) ? req.body.exercises : [],
    trainerPrivateNotes: typeof req.body?.trainerPrivateNotes === "string" ? req.body.trainerPrivateNotes.trim() : undefined,
    sharedNotes: typeof req.body?.sharedNotes === "string" ? req.body.sharedNotes.trim() : undefined,
    clientFeedback: typeof req.body?.clientFeedback === "string" ? req.body.clientFeedback.trim() : undefined,
    updatedAt: new Date(),
  }).where(and(eq(trainerSessionsTable.id, sessionId), eq(trainerSessionsTable.trainerId, trainer.id), eq(trainerSessionsTable.status, "IN_PROGRESS"))).returning();
  if (!session) { failure(res, 409, "Only in-progress sessions can be completed", "INVALID_SESSION_TRANSITION"); return; }
  if (trainer.pricePerSessionMinor && trainer.pricePerSessionMinor > 0) await db.insert(trainerEarningsTable).values({ trainerId: trainer.id, sessionId: session.id, amountMinor: trainer.pricePerSessionMinor, status: "PENDING" });
  success(res, await sessionWithNames(session), "Session completed");
});

router.post("/trainer/sessions/:id/cancel", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  const sessionId = integerParam(req.params.id);
  if (!trainer || !sessionId) { failure(res, 404, "Session not found", "SESSION_NOT_FOUND"); return; }
  const [session] = await db.update(trainerSessionsTable).set({ status: "CANCELLED_BY_TRAINER", cancelledAt: new Date(), cancellationReason: typeof req.body?.reason === "string" ? req.body.reason.trim() : "Cancelled by trainer", updatedAt: new Date() }).where(and(eq(trainerSessionsTable.id, sessionId), eq(trainerSessionsTable.trainerId, trainer.id), inArray(trainerSessionsTable.status, ["REQUESTED", "CONFIRMED"]))).returning();
  if (!session) { failure(res, 409, "This session can no longer be cancelled", "INVALID_SESSION_TRANSITION"); return; }
  success(res, await sessionWithNames(session), "Session cancelled");
});

router.get("/trainer/statistics", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const weekStart = new Date(now); weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [metrics, month, week, today, statuses, earnings] = await Promise.all([
    trainerMetrics(trainer.id),
    db.select({ value: count() }).from(trainerSessionsTable).where(and(eq(trainerSessionsTable.trainerId, trainer.id), gte(trainerSessionsTable.scheduledStart, monthStart))),
    db.select({ value: count() }).from(trainerSessionsTable).where(and(eq(trainerSessionsTable.trainerId, trainer.id), gte(trainerSessionsTable.scheduledStart, weekStart))),
    db.select({ value: count() }).from(trainerSessionsTable).where(and(eq(trainerSessionsTable.trainerId, trainer.id), gte(trainerSessionsTable.scheduledStart, todayStart), lt(trainerSessionsTable.scheduledStart, new Date(todayStart.getTime() + 86400000)))),
    db.select({ status: trainerSessionsTable.status, value: count() }).from(trainerSessionsTable).where(eq(trainerSessionsTable.trainerId, trainer.id)).groupBy(trainerSessionsTable.status),
    db.select({ value: sql<number>`coalesce(sum(${trainerEarningsTable.amountMinor}), 0)` }).from(trainerEarningsTable).where(eq(trainerEarningsTable.trainerId, trainer.id)),
  ]);
  success(res, {
    ...metrics,
    experienceYears: trainer.yearsExperience,
    thisMonth: Number(month[0]?.value ?? 0),
    thisWeek: Number(week[0]?.value ?? 0),
    today: Number(today[0]?.value ?? 0),
    statuses: Object.fromEntries(statuses.map((item) => [item.status, Number(item.value)])),
    totalEarningsMinor: Number(earnings[0]?.value ?? 0),
  });
});

router.get("/trainer/earnings", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  const earnings = await db.select().from(trainerEarningsTable).where(eq(trainerEarningsTable.trainerId, trainer.id)).orderBy(desc(trainerEarningsTable.createdAt)).limit(100);
  success(res, earnings.map((earning) => ({ ...earning, createdAt: earning.createdAt.toISOString(), paidAt: iso(earning.paidAt) })));
});

router.get("/trainer/notifications", ...trainerOnly, async (req, res): Promise<void> => {
  const trainer = await trainerForUser(req.auth!.id);
  if (!trainer) { failure(res, 404, "Trainer profile not found", "TRAINER_NOT_FOUND"); return; }
  success(res, await db.select().from(trainerNotificationsTable).where(eq(trainerNotificationsTable.trainerId, trainer.id)).orderBy(desc(trainerNotificationsTable.createdAt)).limit(100));
});

router.get("/trainers", async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const city = queryString(req.query.city);
  const specialization = queryString(req.query.specialization)?.toLowerCase();
  const language = queryString(req.query.language)?.toLowerCase();
  const search = queryString(req.query.search);
  const minExperience = numberQuery(req.query.minExperience);
  const minRating = numberQuery(req.query.minRating);
  const profiles = await db.select().from(trainerProfilesTable).where(eq(trainerProfilesTable.status, "ACTIVE")).orderBy(asc(trainerProfilesTable.id));
  const matching = [];
  for (const profile of profiles) {
    if (city && profile.city.toLowerCase() !== city.toLowerCase()) continue;
    if (specialization && !profile.specializations.some((item) => item.toLowerCase() === specialization)) continue;
    if (language && !profile.languages.some((item) => item.toLowerCase() === language)) continue;
    if (search && ![profile.city, profile.bio ?? "", profile.expertise ?? "", ...profile.specializations].some((item) => item.toLowerCase().includes(search.toLowerCase()))) continue;
    if (minExperience !== undefined && profile.yearsExperience < minExperience) continue;
    const item = await publicTrainer(profile.id);
    if (!item || (minRating !== undefined && (item.rating ?? 0) < minRating)) continue;
    matching.push(item);
  }
  const sort = queryString(req.query.sort);
  matching.sort((a, b) => sort === "rating" ? (b.rating ?? 0) - (a.rating ?? 0) : sort === "experience" ? (b.yearsExperience ?? 0) - (a.yearsExperience ?? 0) : (a.name.localeCompare(b.name)));
  success(res, pageData(matching.slice(offset, offset + size), page, size, matching.length));
});

router.get("/trainers/:id", async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  if (!trainerId) { failure(res, 400, "Trainer id is invalid", "VALIDATION_ERROR"); return; }
  const gymId = integerParam(req.query.gymId);
  const trainer = gymId ? await publicTrainerAtGym(trainerId, gymId) : await publicTrainer(trainerId);
  if (!trainer) { failure(res, 404, "Trainer not found", "TRAINER_NOT_FOUND"); return; }
  const visibility = await visibilityFor(trainerId);
  const [reviews, availability] = await Promise.all([
    visibility.showReviewsToMembers ? db.select().from(trainerReviewsTable).where(and(eq(trainerReviewsTable.trainerId, trainerId), eq(trainerReviewsTable.moderationStatus, "VISIBLE"))).orderBy(desc(trainerReviewsTable.createdAt)).limit(50) : Promise.resolve([]),
    gymId ? db.select().from(trainerAvailabilitiesTable).where(and(eq(trainerAvailabilitiesTable.trainerId, trainerId), eq(trainerAvailabilitiesTable.gymId, gymId), eq(trainerAvailabilitiesTable.active, true))).orderBy(asc(trainerAvailabilitiesTable.dayOfWeek)) : visibility.showAvailabilityToMembers ? db.select().from(trainerAvailabilitiesTable).where(and(eq(trainerAvailabilitiesTable.trainerId, trainerId), eq(trainerAvailabilitiesTable.active, true))).orderBy(asc(trainerAvailabilitiesTable.dayOfWeek)) : Promise.resolve([]),
  ]);
  success(res, { ...trainer, reviews, availability });
});

router.get("/trainers/:id/availability", async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  if (!trainerId || !(await publicTrainer(trainerId))) { failure(res, 404, "Trainer not found", "TRAINER_NOT_FOUND"); return; }
  const visibility = await visibilityFor(trainerId);
  if (!visibility.showAvailabilityToMembers) { failure(res, 404, "Trainer availability is not public", "NOT_AVAILABLE"); return; }
  const gymId = integerParam(req.query.gymId);
  if (gymId && !(await activeTrainerGym(trainerId, gymId))) { failure(res, 404, "Trainer is not available at this gym", "TRAINER_GYM_NOT_FOUND"); return; }
  const filters = [eq(trainerAvailabilitiesTable.trainerId, trainerId), eq(trainerAvailabilitiesTable.active, true)];
  if (gymId) filters.push(eq(trainerAvailabilitiesTable.gymId, gymId));
  success(res, await db.select().from(trainerAvailabilitiesTable).where(and(...filters)).orderBy(asc(trainerAvailabilitiesTable.dayOfWeek)));
});

router.post("/sessions/:id/rate", authenticate, requireRole("CUSTOMER"), async (req, res): Promise<void> => {
  const sessionId = integerParam(req.params.id);
  const rating = integerValue(req.body?.rating, 0);
  if (!sessionId || rating < 1 || rating > 5) { failure(res, 422, "A rating from 1 to 5 is required", "VALIDATION_ERROR"); return; }
  const [session] = await db.select().from(trainerSessionsTable).where(and(eq(trainerSessionsTable.id, sessionId), eq(trainerSessionsTable.clientId, req.auth!.id), eq(trainerSessionsTable.status, "COMPLETED")));
  if (!session) { failure(res, 404, "Only your completed sessions can be rated", "SESSION_NOT_ELIGIBLE"); return; }
  const [existing] = await db.select({ id: trainerReviewsTable.id }).from(trainerReviewsTable).where(eq(trainerReviewsTable.sessionId, session.id));
  if (existing) { failure(res, 409, "This session has already been rated", "DUPLICATE_REVIEW"); return; }
  const [review] = await db.insert(trainerReviewsTable).values({
    trainerId: session.trainerId, clientId: req.auth!.id, sessionId: session.id, rating,
    knowledgeRating: req.body.knowledgeRating ? integerValue(req.body.knowledgeRating) : null,
    communicationRating: req.body.communicationRating ? integerValue(req.body.communicationRating) : null,
    professionalismRating: req.body.professionalismRating ? integerValue(req.body.professionalismRating) : null,
    motivationRating: req.body.motivationRating ? integerValue(req.body.motivationRating) : null,
    review: typeof req.body.review === "string" ? req.body.review.trim() : null,
  }).returning();
  await db.insert(trainerNotificationsTable).values({ trainerId: session.trainerId, type: "RATING_RECEIVED", title: "New trainer rating", body: "A member rated one of your completed sessions." });
  success(res, review, "Rating submitted", 201);
});

router.get("/admin/trainers", ...adminOnly, async (req, res): Promise<void> => {
  const { page, size, offset } = pageParams(req);
  const status = queryString(req.query.status);
  const where = status ? and(eq(trainerProfilesTable.status, status)) : undefined;
  const rows = await db.select({ profile: trainerProfilesTable, user: usersTable }).from(trainerProfilesTable).innerJoin(usersTable, eq(usersTable.id, trainerProfilesTable.userId)).where(where).orderBy(desc(trainerProfilesTable.createdAt)).limit(size).offset(offset);
  const [{ value: total }] = await db.select({ value: count() }).from(trainerProfilesTable).where(where);
  success(res, pageData(rows.map(({ profile, user }) => ({ ...profile, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } })), page, size, Number(total)));
});

async function adminTrainerStatus(req: Parameters<typeof authenticate>[0], res: Parameters<typeof authenticate>[1], status: string, action: string) {
  const trainerId = integerParam(req.params.id);
  if (!trainerId) { failure(res, 400, "Trainer id is invalid", "VALIDATION_ERROR"); return; }
  const [updated] = await db.update(trainerProfilesTable).set({ status, adminVerificationStatus: status === "ACTIVE" ? "VERIFIED" : status === "REJECTED" ? "REJECTED" : "PENDING", updatedAt: new Date() }).where(eq(trainerProfilesTable.id, trainerId)).returning();
  if (!updated) { failure(res, 404, "Trainer not found", "TRAINER_NOT_FOUND"); return; }
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action, targetType: "TRAINER", targetId: trainerId, metadata: {} });
  success(res, updated, `Trainer ${status.toLowerCase()}`);
}

router.put("/admin/trainers/:id/approve", ...adminOnly, async (req, res) => adminTrainerStatus(req, res, "ACTIVE", "TRAINER_APPROVED"));
router.put("/admin/trainers/:id/reject", ...adminOnly, async (req, res) => adminTrainerStatus(req, res, "REJECTED", "TRAINER_REJECTED"));
router.put("/admin/trainers/:id/suspend", ...adminOnly, async (req, res) => adminTrainerStatus(req, res, "SUSPENDED", "TRAINER_SUSPENDED"));
router.put("/admin/trainers/:id/reactivate", ...adminOnly, async (req, res) => adminTrainerStatus(req, res, "ACTIVE", "TRAINER_REACTIVATED"));

router.put("/admin/trainers/:id/verify-photo", ...adminOnly, async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  const status = req.body?.status;
  if (!trainerId || !["APPROVED", "REJECTED", "PENDING_REVIEW"].includes(status)) { failure(res, 422, "A valid photo status is required", "VALIDATION_ERROR"); return; }
  const [updated] = await db.update(trainerProfilesTable).set({ profilePhotoStatus: status, updatedAt: new Date() }).where(eq(trainerProfilesTable.id, trainerId)).returning();
  if (!updated) { failure(res, 404, "Trainer not found", "TRAINER_NOT_FOUND"); return; }
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action: `PHOTO_${status}`, targetType: "TRAINER", targetId: trainerId, metadata: {} });
  success(res, { trainerId, profilePhotoStatus: status }, "Trainer photo status updated");
});

router.put("/admin/trainers/:id/verify-certification", ...adminOnly, async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  const certificationId = integerParam(req.body?.certificationId);
  const status = req.body?.verificationStatus;
  if (!trainerId || !certificationId || !["VERIFIED", "REJECTED", "PENDING"].includes(status)) { failure(res, 422, "Trainer, certification, and a valid verification status are required", "VALIDATION_ERROR"); return; }
  const [certification] = await db.update(trainerCertificationsTable).set({ verificationStatus: status, verificationNote: typeof req.body.note === "string" ? req.body.note.trim() : null, verifiedAt: status === "VERIFIED" ? new Date() : null, updatedAt: new Date() }).where(and(eq(trainerCertificationsTable.id, certificationId), eq(trainerCertificationsTable.trainerId, trainerId))).returning();
  if (!certification) { failure(res, 404, "Certification not found", "CERTIFICATION_NOT_FOUND"); return; }
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action: "CERTIFICATION_" + status, targetType: "CERTIFICATION", targetId: certificationId, metadata: {} });
  success(res, certification, "Certification verification updated");
});

router.put("/admin/trainers/:id/visibility", ...adminOnly, async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  if (!trainerId || !await trainerById(trainerId)) { failure(res, 404, "Trainer not found", "TRAINER_NOT_FOUND"); return; }
  const allowed = ["showProfileToMembers", "showRatingToMembers", "showExperienceToMembers", "showCertificationsToMembers", "showLanguagesToMembers", "showSessionCountToMembers", "showClientCountToMembers", "showSpecializationsToMembers", "showAvailabilityToMembers", "showPricingToMembers", "showReviewsToMembers"] as const;
  const update: Partial<Record<typeof allowed[number], boolean>> = {};
  for (const key of allowed) if (typeof req.body?.[key] === "boolean") update[key] = req.body[key];
  const [visibility] = await db.insert(trainerVisibilitySettingsTable).values({ trainerId, ...update }).onConflictDoUpdate({ target: trainerVisibilitySettingsTable.trainerId, set: update }).returning();
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action: "VISIBILITY_CHANGED", targetType: "TRAINER", targetId: trainerId, metadata: update });
  success(res, visibility, "Trainer visibility updated");
});

router.get("/admin/trainers/:id/statistics", ...adminOnly, async (req, res): Promise<void> => {
  const trainerId = integerParam(req.params.id);
  if (!trainerId || !await trainerById(trainerId)) { failure(res, 404, "Trainer not found", "TRAINER_NOT_FOUND"); return; }
  success(res, await trainerMetrics(trainerId));
});

router.get("/admin/trainer-reviews", ...adminOnly, async (_req, res): Promise<void> => {
  success(res, await db.select().from(trainerReviewsTable).orderBy(desc(trainerReviewsTable.createdAt)).limit(200));
});

router.put("/admin/trainer-reviews/:id", ...adminOnly, async (req, res): Promise<void> => {
  const reviewId = integerParam(req.params.id);
  const moderationStatus = req.body?.moderationStatus;
  if (!reviewId || !["VISIBLE", "HIDDEN", "FLAGGED"].includes(moderationStatus)) { failure(res, 422, "A valid moderation status is required", "VALIDATION_ERROR"); return; }
  const [review] = await db.update(trainerReviewsTable).set({ moderationStatus, moderatedAt: new Date(), updatedAt: new Date() }).where(eq(trainerReviewsTable.id, reviewId)).returning();
  if (!review) { failure(res, 404, "Review not found", "REVIEW_NOT_FOUND"); return; }
  await db.insert(trainerAuditLogsTable).values({ actorId: req.auth!.id, action: "REVIEW_" + moderationStatus, targetType: "REVIEW", targetId: reviewId, metadata: {} });
  success(res, review, "Review moderation updated");
});

export default router;