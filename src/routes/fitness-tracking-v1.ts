import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  bookingsTable,
  bodyMeasurementsTable,
  db,
  fitnessGoalsTable,
  fitnessProfilesTable,
  gymVisitsTable,
  gymPassesTable,
  gymsTable,
  workoutSessionsTable,
} from "@workspace/db";
import { authenticate } from "../middlewares/auth";
import { failure, success } from "../lib/http";
import { dateOnly, integerParam, numberQuery, queryString } from "../lib/v1";

const router: IRouter = Router();
const publicGymStatuses = ["APPROVED", "ACTIVE"];
const DAY_MS = 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;
type WorkoutExercise = {
  name: string;
  sets: number;
  reps: number | string;
  weightKg?: number;
  volume?: number;
  muscleGroup?: string;
};

function objectBody(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function stringValue(value: unknown, max = 500): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function stringList(value: unknown, maxItems = 12): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, maxItems)
    : [];
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function serializeWorkout(workout: typeof workoutSessionsTable.$inferSelect) {
  return {
    ...workout,
    startedAt: workout.startedAt.toISOString(),
    completedAt: workout.completedAt.toISOString(),
    createdAt: workout.createdAt.toISOString(),
  };
}

function serializeMeasurement(measurement: typeof bodyMeasurementsTable.$inferSelect) {
  return { ...measurement, recordedAt: measurement.recordedAt.toISOString(), createdAt: measurement.createdAt.toISOString() };
}

function serializeGoal(goal: typeof fitnessGoalsTable.$inferSelect) {
  return {
    ...goal,
    startDate: goal.startDate.toISOString(),
    targetDate: goal.targetDate?.toISOString() ?? null,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

function serializeVisit(visit: typeof gymVisitsTable.$inferSelect, gym?: {
  id: number;
  name: string;
  slug: string;
  city: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
} | null) {
  return {
    ...visit,
    checkInTime: visit.checkInTime.toISOString(),
    checkOutTime: visit.checkOutTime?.toISOString() ?? null,
    createdAt: visit.createdAt.toISOString(),
    gym: gym ? {
      id: gym.id,
      name: gym.name,
      slug: gym.slug,
      city: gym.city,
      address: gym.address ?? null,
      latitude: gym.latitude ?? null,
      longitude: gym.longitude ?? null,
    } : null,
  };
}

function numericReps(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(String(value).match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseExercises(value: unknown): WorkoutExercise[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((item) => {
    const record = objectBody(item);
    const name = stringValue(record?.name, 120);
    const sets = finiteNumber(record?.sets, 1, 100);
    const reps = typeof record?.reps === "string"
      ? stringValue(record.reps, 30)
      : finiteNumber(record?.reps, 1, 1000);
    if (!name || sets === undefined || reps === undefined) return [];
    const weightKg = finiteNumber(record?.weightKg, 0, 1000);
    const volume = weightKg === undefined ? undefined : Number((sets * numericReps(reps) * weightKg).toFixed(2));
    return [{ name, sets: Math.round(sets), reps, ...(weightKg === undefined ? {} : { weightKg }), ...(volume === undefined ? {} : { volume }), muscleGroup: stringValue(record?.muscleGroup, 80) }];
  });
}

function exerciseHistory(workouts: Array<typeof workoutSessionsTable.$inferSelect>) {
  const history = new Map<string, { maxWeight: number; maxVolume: number }>();
  for (const workout of workouts) {
    if (!Array.isArray(workout.exercises)) continue;
    for (const exercise of parseExercises(workout.exercises)) {
      const key = exercise.name.toLowerCase();
      const existing = history.get(key) ?? { maxWeight: 0, maxVolume: 0 };
      history.set(key, {
        maxWeight: Math.max(existing.maxWeight, exercise.weightKg ?? 0),
        maxVolume: Math.max(existing.maxVolume, exercise.volume ?? 0),
      });
    }
  }
  return history;
}

function calculatePersonalRecords(exercises: WorkoutExercise[], history: Map<string, { maxWeight: number; maxVolume: number }>) {
  return exercises.flatMap((exercise) => {
    const previous = history.get(exercise.name.toLowerCase());
    if (!previous) return exercise.weightKg && exercise.weightKg > 0 ? [{ exercise: exercise.name, metric: "weight", value: exercise.weightKg, unit: "kg" }] : [];
    const records: Array<{ exercise: string; metric: string; value: number; unit: string }> = [];
    if (exercise.weightKg && exercise.weightKg > previous.maxWeight) records.push({ exercise: exercise.name, metric: "weight", value: exercise.weightKg, unit: "kg" });
    if (exercise.volume && exercise.volume > previous.maxVolume) records.push({ exercise: exercise.name, metric: "volume", value: exercise.volume, unit: "kg" });
    return records;
  });
}

function activityDates(workouts: Array<typeof workoutSessionsTable.$inferSelect>, visits: Array<typeof gymVisitsTable.$inferSelect>) {
  return new Set([...workouts.map((item) => dateOnly(item.completedAt)), ...visits.map((item) => dateOnly(item.checkInTime))]);
}

function activityCounts(workouts: Array<typeof workoutSessionsTable.$inferSelect>, visits: Array<typeof gymVisitsTable.$inferSelect>) {
  const counts = new Map<string, number>();
  for (const date of workouts.map((item) => dateOnly(item.completedAt))) counts.set(date, (counts.get(date) ?? 0) + 1);
  for (const date of visits.map((item) => dateOnly(item.checkInTime))) counts.set(date, (counts.get(date) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-365).map(([date, count]) => ({ date, count }));
}

function strengthRecords(workouts: Array<typeof workoutSessionsTable.$inferSelect>) {
  const records: Array<{ exercise: string; value: number; unit: string; achievedAt: string; metric: string }> = [];
  const maxes = new Map<string, { weight: number; volume: number }>();
  for (const workout of [...workouts].sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime())) {
    for (const exercise of parseExercises(workout.exercises)) {
      const key = exercise.name.toLowerCase();
      const previous = maxes.get(key) ?? { weight: 0, volume: 0 };
      if ((exercise.weightKg ?? 0) > previous.weight) {
        records.push({ exercise: exercise.name, value: exercise.weightKg ?? 0, unit: "kg", achievedAt: dateOnly(workout.completedAt), metric: "weight" });
      }
      if ((exercise.volume ?? 0) > previous.volume) {
        records.push({ exercise: exercise.name, value: exercise.volume ?? 0, unit: "kg volume", achievedAt: dateOnly(workout.completedAt), metric: "volume" });
      }
      maxes.set(key, {
        weight: Math.max(previous.weight, exercise.weightKg ?? 0),
        volume: Math.max(previous.volume, exercise.volume ?? 0),
      });
    }
  }
  return records.sort((a, b) => b.achievedAt.localeCompare(a.achievedAt)).slice(0, 16);
}

function muscleAnalytics(workouts: Array<typeof workoutSessionsTable.$inferSelect>) {
  const details = new Map<string, { count: number; volume: number; lastTrained: string; sets: number }>();
  for (const workout of workouts) {
    const exercises = parseExercises(workout.exercises);
    const muscles = new Set<string>();
    for (const bodyPart of workout.bodyParts ?? []) {
      const normalized = bodyPart.trim();
      if (normalized) muscles.add(normalized);
    }
    for (const exercise of exercises) {
      if (exercise.muscleGroup) muscles.add(exercise.muscleGroup);
    }
    for (const muscle of muscles) {
      const key = muscle.toLowerCase();
      const previous = details.get(key) ?? { count: 0, volume: 0, lastTrained: dateOnly(workout.completedAt), sets: 0 };
      details.set(key, {
        count: previous.count + 1,
        volume: previous.volume + exercises
          .filter((exercise) => exercise.muscleGroup?.toLowerCase() === key)
          .reduce((sum, exercise) => sum + (exercise.volume ?? 0), 0),
        lastTrained: previous.lastTrained > dateOnly(workout.completedAt) ? previous.lastTrained : dateOnly(workout.completedAt),
        sets: previous.sets + exercises.filter((exercise) => exercise.muscleGroup?.toLowerCase() === key).reduce((sum, exercise) => sum + exercise.sets, 0),
      });
    }
  }
  return [...details.entries()]
    .map(([name, detail]) => ({ name, ...detail }))
    .sort((a, b) => b.count - a.count || b.volume - a.volume);
}

function streaks(dates: Set<string>, today = new Date()) {
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  if (sorted.length === 0) return { current: 0, longest: 0 };
  const dayNumbers = sorted.map((value) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / DAY_MS));
  let longest = 1;
  let run = 1;
  for (let index = 1; index < dayNumbers.length; index += 1) {
    if (dayNumbers[index - 1] - dayNumbers[index] === 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }
  const todayNumber = Math.floor(new Date(dateOnly(today)).getTime() / DAY_MS);
  const current = dayNumbers[0] >= todayNumber - 1
    ? (() => {
        let count = 1;
        for (let index = 1; index < dayNumbers.length && dayNumbers[index - 1] - dayNumbers[index] === 1; index += 1) count += 1;
        return count;
      })()
    : 0;
  return { current, longest };
}

function daySeries(workouts: Array<typeof workoutSessionsTable.$inferSelect>, days: number) {
  const today = new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getTime() - (days - index - 1) * DAY_MS);
    const key = dateOnly(date);
    const matches = workouts.filter((item) => dateOnly(item.completedAt) === key);
    return {
      date: key,
      workouts: matches.length,
      minutes: matches.reduce((sum, item) => sum + item.durationMinutes, 0),
      volume: Number(matches.reduce((sum, item) => sum + (item.totalVolume ?? 0), 0).toFixed(2)),
    };
  });
}

function monthSeries(workouts: Array<typeof workoutSessionsTable.$inferSelect>, months: number) {
  const now = new Date();
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - index - 1), 1));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const matches = workouts.filter((item) => {
      const completed = item.completedAt;
      return completed.getUTCFullYear() === year && completed.getUTCMonth() === month;
    });
    return {
      month: date.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }),
      workouts: matches.length,
      minutes: matches.reduce((sum, item) => sum + item.durationMinutes, 0),
    };
  });
}

async function getUserWorkouts(userId: number, since?: Date) {
  return db.select().from(workoutSessionsTable).where(since
    ? and(eq(workoutSessionsTable.userId, userId), gte(workoutSessionsTable.completedAt, since))
    : eq(workoutSessionsTable.userId, userId)).orderBy(desc(workoutSessionsTable.completedAt));
}

router.get("/fitness/overview", authenticate, async (req, res): Promise<void> => {
  const userId = req.auth!.id;
  const since = new Date(Date.now() - 365 * DAY_MS);
  const [workouts, visits, measurements, goals, profile, bookings] = await Promise.all([
    getUserWorkouts(userId),
    db.select().from(gymVisitsTable).where(eq(gymVisitsTable.userId, userId)).orderBy(desc(gymVisitsTable.checkInTime)),
    db.select().from(bodyMeasurementsTable).where(eq(bodyMeasurementsTable.userId, userId)).orderBy(desc(bodyMeasurementsTable.recordedAt)).limit(30),
    db.select().from(fitnessGoalsTable).where(and(eq(fitnessGoalsTable.userId, userId), eq(fitnessGoalsTable.status, "ACTIVE"))).orderBy(desc(fitnessGoalsTable.updatedAt)).limit(10),
    db.select().from(fitnessProfilesTable).where(eq(fitnessProfilesTable.userId, userId)).then((rows) => rows[0] ?? null),
    db.select().from(bookingsTable).where(eq(bookingsTable.userId, userId)).orderBy(desc(bookingsTable.createdAt)).limit(50),
  ]);
  const relatedGymIds = [...new Set([...visits.map((visit) => visit.gymId), ...bookings.map((booking) => booking.gymId)])];
  const passIds = [...new Set(bookings.map((booking) => booking.passId))];
  const [relatedGyms, relatedPasses] = await Promise.all([
    relatedGymIds.length
      ? db.select({
          id: gymsTable.id,
          name: gymsTable.name,
          slug: gymsTable.slug,
          city: gymsTable.city,
          address: gymsTable.address,
          latitude: gymsTable.latitude,
          longitude: gymsTable.longitude,
          status: gymsTable.status,
        }).from(gymsTable).where(and(inArray(gymsTable.id, relatedGymIds), inArray(gymsTable.status, publicGymStatuses)))
      : Promise.resolve([]),
    passIds.length
      ? db.select({ id: gymPassesTable.id, name: gymPassesTable.name }).from(gymPassesTable).where(inArray(gymPassesTable.id, passIds))
      : Promise.resolve([]),
  ]);
  const gymsById = new Map(relatedGyms.map((gym) => [gym.id, gym]));
  const passesById = new Map(relatedPasses.map((pass) => [pass.id, pass]));
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const monthStart = new Date(now.getTime() - 30 * DAY_MS);
  const weekWorkouts = workouts.filter((item) => item.completedAt >= weekStart);
  const monthWorkouts = workouts.filter((item) => item.completedAt >= monthStart);
  const monthVisits = visits.filter((item) => item.checkInTime >= monthStart);
  const activeDates = activityDates(workouts, visits);
  const weekVisits = visits.filter((item) => item.checkInTime >= weekStart);
  const weekActiveDates = activityDates(weekWorkouts, weekVisits);
  const recentDays = weekActiveDates.size;
  const recoveryScore = Math.max(0, Math.min(100, 100 - Math.max(0, weekWorkouts.length - 4) * 12 - Math.max(0, recentDays - 5) * 8));
  const latestMeasurement = measurements[0] ?? null;
  const heightCm = latestMeasurement?.heightCm ?? profile?.heightCm;
  const weightKg = latestMeasurement?.weightKg ?? profile?.weightKg;
  const bmi = heightCm && weightKg ? Number((weightKg / ((heightCm / 100) ** 2)).toFixed(1)) : null;
  const muscleData = muscleAnalytics(monthWorkouts);
  const muscleGroups = muscleData.map(({ name, count }) => ({ name, count }));
  const totalTrainingMinutes = workouts.reduce((sum, item) => sum + item.durationMinutes, 0);
  const totalVolume = workouts.reduce((sum, item) => sum + (item.totalVolume ?? 0), 0);
  const consistencyScore = Math.min(100, (new Set(monthWorkouts.map((item) => dateOnly(item.completedAt))).size / 12) * 100);
  const frequencyScore = Math.min(100, (monthWorkouts.length / 12) * 100);
  const loadScore = totalVolume > 0
    ? Math.min(100, (totalVolume / 6000) * 100)
    : Math.min(100, (totalTrainingMinutes / 240) * 100);
  const fitnessScore = Math.round(consistencyScore * 0.35 + frequencyScore * 0.25 + loadScore * 0.2 + recoveryScore * 0.2);
  const gymCounts = new Map<number, number>();
  for (const visit of visits) gymCounts.set(visit.gymId, (gymCounts.get(visit.gymId) ?? 0) + 1);
  const gymMapPoints = [...gymCounts.entries()]
    .map(([gymId, visitCount]) => {
      const gym = gymsById.get(gymId);
      return gym && gym.latitude !== null && gym.latitude !== undefined && gym.longitude !== null && gym.longitude !== undefined
        ? { gymId, name: gym.name, city: gym.city, visits: visitCount, latitude: gym.latitude, longitude: gym.longitude }
        : null;
    })
    .filter((point): point is NonNullable<typeof point> => Boolean(point))
    .sort((a, b) => b.visits - a.visits);
  const sortedGymVisits = [...gymCounts.entries()].sort(([, a], [, b]) => b - a);
  const favoriteGym = sortedGymVisits[0] ? gymsById.get(sortedGymVisits[0][0]) : undefined;
  const totalSessions = workouts.length;
  const today = dateOnly(now);
  const activeBooking = bookings.find((booking) => {
    const validUntil = booking.validUntil ?? booking.expiresOn;
    const startsOn = booking.validFrom ?? booking.bookingDate;
    return ["CONFIRMED", "CHECKED_IN", "COMPLETED"].includes(booking.status) && startsOn <= today && validUntil >= today;
  });
  const activePass = activeBooking
    ? {
        name: passesById.get(activeBooking.passId)?.name ?? "Active gym pass",
        gymName: gymsById.get(activeBooking.gymId)?.name ?? "Partner gym",
        expiresAt: activeBooking.validUntil ?? activeBooking.expiresOn,
        remainingDays: Math.max(0, Math.ceil((new Date(`${activeBooking.validUntil ?? activeBooking.expiresOn}T23:59:59Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY_MS)),
        status: activeBooking.status,
      }
    : null;
  const prHistory = strengthRecords(workouts).map(({ exercise, value, unit, achievedAt, metric }) => ({ exercise, value, unit, achievedAt, metric }));
  const bodyTrends = measurements.slice(0, 12).reverse().map((measurement) => ({
    date: dateOnly(measurement.recordedAt),
    weightKg: measurement.weightKg ?? null,
    bodyFatPercentage: measurement.bodyFatPercentage ?? null,
  }));
  const timeline = [
    ...workouts.slice(0, 8).map((workout) => ({
      date: workout.completedAt.toISOString(),
      title: `${workout.workoutType} session`,
      detail: `${workout.durationMinutes} min${workout.bodyParts.length ? ` · ${workout.bodyParts.slice(0, 2).join(", ")}` : ""}`,
      type: "workout",
    })),
    ...visits.slice(0, 8).map((visit) => ({
      date: visit.checkInTime.toISOString(),
      title: `Checked in at ${gymsById.get(visit.gymId)?.name ?? "a partner gym"}`,
      detail: visit.durationMinutes ? `${visit.durationMinutes} min visit` : "Visit in progress",
      type: "visit",
    })),
    ...measurements.slice(0, 4).map((measurement) => ({
      date: measurement.recordedAt.toISOString(),
      title: "Body check-in recorded",
      detail: measurement.weightKg ? `${measurement.weightKg} kg bodyweight` : "Progress marker added",
      type: "measurement",
    })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const insights = [
    monthWorkouts.length === 0
      ? { title: "Start with one repeatable session", body: "A single logged workout gives your plan a useful baseline." }
      : { title: `${monthWorkouts.length} sessions in your last 30 days`, body: `${Math.round(consistencyScore)}% consistency signal from your active training days.` },
    recoveryScore < 60
      ? { title: "Protect your recovery window", body: "Keep the next session lighter and prioritise sleep, hydration, and mobility." }
      : { title: "Your recovery signal is supportive", body: "You have room for a focused session if your body feels ready." },
  ];
  const journeyStartedAt = visits.length ? visits[visits.length - 1].checkInTime.toISOString() : null;
  const journeyProgress = Math.min(100, Math.round((visits.length / 10) * 100));

  success(res, {
    stats: {
      workoutsThisWeek: weekWorkouts.length,
      workoutsThisMonth: monthWorkouts.length,
      minutesThisWeek: weekWorkouts.reduce((sum, item) => sum + item.durationMinutes, 0),
      volumeThisWeek: Number(weekWorkouts.reduce((sum, item) => sum + (item.totalVolume ?? 0), 0).toFixed(2)),
      gymVisitsThisMonth: monthVisits.length,
      activeDays: weekActiveDates.size,
      activeDaysTotal: activeDates.size,
      currentStreak: streaks(activeDates).current,
      longestStreak: streaks(activeDates).longest,
      consistency: Math.round(Math.min(100, (new Set(monthWorkouts.map((item) => dateOnly(item.completedAt))).size / 12) * 100)),
      recoveryScore,
      recoveryLabel: recoveryScore >= 75 ? "Ready to train" : recoveryScore >= 45 ? "Manage your load" : "Prioritise recovery",
      bmi,
      totalGymSessions: visits.length,
      totalTrainingMinutes,
      averageSessionMinutes: totalSessions ? Math.round(totalTrainingMinutes / totalSessions) : 0,
      gymsVisited: gymCounts.size,
      favoriteGymName: favoriteGym?.name ?? null,
      favoriteGymVisits: sortedGymVisits[0]?.[1] ?? 0,
      lastVisitAt: visits[0]?.checkInTime.toISOString() ?? null,
      lastVisitDurationMinutes: visits[0]?.durationMinutes ?? null,
      fitnessScore,
      scoreBreakdown: {
        consistency: Math.round(consistencyScore),
        frequency: Math.round(frequencyScore),
        load: Math.round(loadScore),
        recovery: recoveryScore,
        weights: { consistency: 35, frequency: 25, load: 20, recovery: 20 },
      },
    },
    weekly: daySeries(workouts, 7),
    monthly: monthSeries(workouts, 6),
    activityCalendar: activityCounts(workouts.filter((item) => item.completedAt >= since), visits.filter((item) => item.checkInTime >= since)),
    muscleGroups,
    recentWorkouts: workouts.slice(0, 8).map(serializeWorkout),
    recentVisits: visits.slice(0, 8).map((visit) => serializeVisit(visit, gymsById.get(visit.gymId))),
    measurements: measurements.map(serializeMeasurement),
    goals: goals.map(serializeGoal),
    profile,
    fitnessScore,
    gymJourney: {
      current: visits.length ? `${visits.length} gym ${visits.length === 1 ? "session" : "sessions"} logged` : "Your journey starts here",
      next: favoriteGym ? "Keep building your weekly rhythm" : "Check into your first partner gym",
      progress: journeyProgress,
      startedAt: journeyStartedAt,
    },
    gymMapPoints,
    muscleAnalytics: muscleData,
    streaks: { current: streaks(activeDates).current, longest: streaks(activeDates).longest, activeDays: activeDates.size },
    badges: [
      ...(totalSessions >= 1 ? [{ name: "First session", description: "Logged your first workout", earnedAt: workouts[workouts.length - 1]?.completedAt.toISOString() ?? null }] : []),
      ...(streaks(activeDates).longest >= 7 ? [{ name: "Seven-day rhythm", description: "Built a seven-day activity streak", earnedAt: null }] : []),
      ...(visits.length >= 10 ? [{ name: "Gym regular", description: "Completed ten gym visits", earnedAt: visits[9]?.checkInTime.toISOString() ?? null }] : []),
      ...(totalVolume >= 1000 ? [{ name: "Moving weight", description: "Logged more than 1,000 kg of training volume", earnedAt: null }] : []),
    ],
    prHistory,
    bodyTrends,
    todayRecommendation: {
      type: activeDates.has(today) ? "Recovery note" : recoveryScore < 60 ? "Keep it light" : "Today’s focus",
      title: activeDates.has(today) ? "You showed up today. Let the work settle." : recoveryScore < 60 ? "Choose mobility or an easy walk." : "A focused session fits your current rhythm.",
      description: activeDates.has(today) ? "A complete day includes recovery. Come back when your body is ready." : "Open AI Coach for a session shaped around your goals and available energy.",
    },
    aiInsights: insights,
    timeline,
    activePass,
  });
});

router.get("/fitness/workouts", authenticate, async (req, res): Promise<void> => {
  const requestedSize = Math.floor(numberQuery(req.query.size) ?? 30);
  const size = Math.min(100, Math.max(1, requestedSize));
  const workouts = await getUserWorkouts(req.auth!.id);
  success(res, { items: workouts.slice(0, size).map(serializeWorkout), totalItems: workouts.length, page: 0, size });
});

router.post("/fitness/workouts", authenticate, async (req, res): Promise<void> => {
  const body = objectBody(req.body);
  const workoutType = stringValue(body?.workoutType, 80);
  const durationMinutes = finiteNumber(body?.durationMinutes, 1, 1440);
  const completedAt = parseDate(body?.completedAt) ?? new Date();
  if (!body || !workoutType || durationMinutes === undefined) {
    failure(res, 422, "workoutType and durationMinutes are required", "VALIDATION_ERROR");
    return;
  }
  const exercises = parseExercises(body.exercises);
  const totalVolume = exercises.reduce((sum, exercise) => sum + (exercise.volume ?? 0), 0);
  const history = exerciseHistory(await getUserWorkouts(req.auth!.id));
  const personalRecords = calculatePersonalRecords(exercises, history);
  const gymId = integerParam(body.gymId);
  if (gymId) {
    const [gym] = await db.select({ id: gymsTable.id }).from(gymsTable).where(and(eq(gymsTable.id, gymId), inArray(gymsTable.status, publicGymStatuses)));
    if (!gym) {
      failure(res, 404, "Gym is not available", "GYM_NOT_FOUND");
      return;
    }
  }
  const [created] = await db.insert(workoutSessionsTable).values({
    userId: req.auth!.id,
    gymId: gymId ?? null,
    workoutType,
    bodyParts: stringList(body.bodyParts),
    durationMinutes: Math.round(durationMinutes),
    caloriesBurned: finiteNumber(body.caloriesBurned, 0, 20_000),
    totalVolume: totalVolume || undefined,
    exercises,
    personalRecords,
    notes: stringValue(body.notes, 1000),
    status: "COMPLETED",
    startedAt: parseDate(body.startedAt) ?? new Date(completedAt.getTime() - durationMinutes * 60_000),
    completedAt,
  }).returning();
  success(res, serializeWorkout(created), "Workout logged", 201);
});

router.get("/fitness/visits", authenticate, async (req, res): Promise<void> => {
  const visits = await db.select().from(gymVisitsTable).where(eq(gymVisitsTable.userId, req.auth!.id)).orderBy(desc(gymVisitsTable.checkInTime)).limit(100);
  const gymIds = [...new Set(visits.map((visit) => visit.gymId))];
  const gyms = gymIds.length ? await db.select({ id: gymsTable.id, name: gymsTable.name, slug: gymsTable.slug, city: gymsTable.city }).from(gymsTable).where(inArray(gymsTable.id, gymIds)) : [];
  const gymsById = new Map(gyms.map((gym) => [gym.id, gym]));
  success(res, visits.map((visit) => serializeVisit(visit, gymsById.get(visit.gymId))));
});

router.post("/fitness/visits/check-in", authenticate, async (req, res): Promise<void> => {
  const gymId = integerParam(req.body?.gymId);
  if (!gymId) {
    failure(res, 422, "gymId is required", "VALIDATION_ERROR");
    return;
  }
  const [gym] = await db.select({ id: gymsTable.id, name: gymsTable.name, slug: gymsTable.slug, city: gymsTable.city }).from(gymsTable).where(and(eq(gymsTable.id, gymId), inArray(gymsTable.status, publicGymStatuses)));
  if (!gym) {
    failure(res, 404, "Gym is not available", "GYM_NOT_FOUND");
    return;
  }
  const [openVisit] = await db.select().from(gymVisitsTable).where(and(eq(gymVisitsTable.userId, req.auth!.id), isNull(gymVisitsTable.checkOutTime))).orderBy(desc(gymVisitsTable.checkInTime)).limit(1);
  if (openVisit) {
    failure(res, 409, "Check out of your current visit first", "VISIT_ALREADY_OPEN");
    return;
  }
  const [created] = await db.insert(gymVisitsTable).values({
    userId: req.auth!.id,
    gymId,
    checkInMethod: stringValue(req.body?.checkInMethod, 30) ?? "Manual",
  }).returning();
  success(res, serializeVisit(created, gym), "Checked in", 201);
});

router.post("/fitness/visits/:id/check-out", authenticate, async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  if (!id) {
    failure(res, 422, "Invalid visit", "VALIDATION_ERROR");
    return;
  }
  const [visit] = await db.select().from(gymVisitsTable).where(and(eq(gymVisitsTable.id, id), eq(gymVisitsTable.userId, req.auth!.id)));
  if (!visit) {
    failure(res, 404, "Visit not found", "VISIT_NOT_FOUND");
    return;
  }
  if (visit.checkOutTime) {
    failure(res, 409, "This visit is already closed", "VISIT_ALREADY_CLOSED");
    return;
  }
  const checkOutTime = new Date();
  const durationMinutes = Math.max(1, Math.round((checkOutTime.getTime() - visit.checkInTime.getTime()) / 60_000));
  const [updated] = await db.update(gymVisitsTable).set({ checkOutTime, durationMinutes }).where(and(eq(gymVisitsTable.id, id), eq(gymVisitsTable.userId, req.auth!.id))).returning();
  const [gym] = await db.select({ id: gymsTable.id, name: gymsTable.name, slug: gymsTable.slug, city: gymsTable.city }).from(gymsTable).where(eq(gymsTable.id, updated.gymId));
  success(res, serializeVisit(updated, gym), "Checked out");
});

router.get("/fitness/measurements", authenticate, async (req, res): Promise<void> => {
  const measurements = await db.select().from(bodyMeasurementsTable).where(eq(bodyMeasurementsTable.userId, req.auth!.id)).orderBy(desc(bodyMeasurementsTable.recordedAt)).limit(100);
  success(res, measurements.map(serializeMeasurement));
});

router.post("/fitness/measurements", authenticate, async (req, res): Promise<void> => {
  const body = objectBody(req.body);
  const values = {
    userId: req.auth!.id,
    recordedAt: parseDate(body?.recordedAt) ?? new Date(),
    weightKg: finiteNumber(body?.weightKg, 20, 500),
    heightCm: finiteNumber(body?.heightCm, 80, 260),
    bodyFatPercentage: finiteNumber(body?.bodyFatPercentage, 1, 70),
    chestCm: finiteNumber(body?.chestCm, 20, 250),
    waistCm: finiteNumber(body?.waistCm, 20, 250),
    armsCm: finiteNumber(body?.armsCm, 5, 100),
    thighsCm: finiteNumber(body?.thighsCm, 10, 150),
    hipsCm: finiteNumber(body?.hipsCm, 20, 250),
    note: stringValue(body?.note, 500),
  };
  const measurementFields = [values.weightKg, values.heightCm, values.bodyFatPercentage, values.chestCm, values.waistCm, values.armsCm, values.thighsCm, values.hipsCm];
  if (measurementFields.filter((value) => value !== undefined && value !== null).length === 0) {
    failure(res, 422, "Add at least one body measurement", "VALIDATION_ERROR");
    return;
  }
  const [created] = await db.insert(bodyMeasurementsTable).values(values).returning();
  success(res, serializeMeasurement(created), "Measurement saved", 201);
});

router.get("/fitness/goals", authenticate, async (req, res): Promise<void> => {
  const goals = await db.select().from(fitnessGoalsTable).where(eq(fitnessGoalsTable.userId, req.auth!.id)).orderBy(desc(fitnessGoalsTable.updatedAt)).limit(50);
  success(res, goals.map(serializeGoal));
});

router.post("/fitness/goals", authenticate, async (req, res): Promise<void> => {
  const body = objectBody(req.body);
  const type = stringValue(body?.type, 40);
  const title = stringValue(body?.title, 120);
  const targetValue = finiteNumber(body?.targetValue, 0, 1_000_000);
  const unit = stringValue(body?.unit, 30);
  if (!body || !type || !title || targetValue === undefined || !unit) {
    failure(res, 422, "type, title, targetValue, and unit are required", "VALIDATION_ERROR");
    return;
  }
  const [created] = await db.insert(fitnessGoalsTable).values({
    userId: req.auth!.id,
    type,
    title,
    targetValue,
    currentValue: finiteNumber(body.currentValue, 0, 1_000_000) ?? 0,
    unit,
    startDate: parseDate(body.startDate) ?? new Date(),
    targetDate: parseDate(body.targetDate),
    status: "ACTIVE",
  }).returning();
  success(res, serializeGoal(created), "Goal created", 201);
});

router.patch("/fitness/goals/:id", authenticate, async (req, res): Promise<void> => {
  const id = integerParam(req.params.id);
  const body = objectBody(req.body);
  if (!id || !body) {
    failure(res, 422, "A valid goal update is required", "VALIDATION_ERROR");
    return;
  }
  const [updated] = await db.update(fitnessGoalsTable).set({
    ...(finiteNumber(body.currentValue, 0, 1_000_000) === undefined ? {} : { currentValue: finiteNumber(body.currentValue, 0, 1_000_000) }),
    ...(stringValue(body.status, 20) ? { status: stringValue(body.status, 20) } : {}),
    updatedAt: new Date(),
  }).where(and(eq(fitnessGoalsTable.id, id), eq(fitnessGoalsTable.userId, req.auth!.id))).returning();
  if (!updated) {
    failure(res, 404, "Goal not found", "GOAL_NOT_FOUND");
    return;
  }
  success(res, serializeGoal(updated), "Goal updated");
});

export default router;