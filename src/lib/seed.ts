import { eq } from "drizzle-orm";
import { db, gymsTable, gymPassesTable, platformSettingsTable, reviewsTable, usersTable } from "@workspace/db";
import { hashPassword } from "./auth";

const gymSeeds = [
  {
    slug: "iron-works-koramangala",
    name: "Iron Works Fitness",
    neighborhood: "Koramangala",
    city: "Bengaluru",
    address: "80 Feet Road, 5th Block, Koramangala",
    latitude: 12.9352,
    longitude: 77.6245,
    imageUrl: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=85", "https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?auto=format&fit=crop&w=1200&q=85"],
    description: "A serious training floor with everything you need for strength, conditioning, and a focused session.",
    phone: "+91 80 4123 8800",
    rating: 4.8,
    reviewCount: 124,
    distanceKm: 1.2,
    startingPrice: 199,
    isOpen: true,
    openUntil: "11:00 PM",
    gymType: "Strength & conditioning",
    facilities: ["Free weights", "Machines", "Cardio", "AC", "Locker", "Parking"],
  },
  {
    slug: "cult-fit-indiranagar",
    name: "Cult.fit Indiranagar",
    neighborhood: "Indiranagar",
    city: "Bengaluru",
    address: "100 Feet Road, HAL 2nd Stage, Indiranagar",
    latitude: 12.9784,
    longitude: 77.6408,
    imageUrl: "https://images.unsplash.com/photo-1571902943202-507ec2618e8f?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1571902943202-507ec2618e8f?auto=format&fit=crop&w=1200&q=85", "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=1200&q=85"],
    description: "Bright, high-energy training with group classes, modern equipment, and coaches who keep you moving.",
    phone: "+91 80 4040 2020",
    rating: 4.6,
    reviewCount: 89,
    distanceKm: 2.7,
    startingPrice: 249,
    isOpen: true,
    openUntil: "10:30 PM",
    gymType: "Fitness studio",
    facilities: ["Cardio", "Group classes", "Personal training", "Shower", "AC"],
  },
  {
    slug: "powerhouse-hsr-layout",
    name: "Powerhouse HSR",
    neighborhood: "HSR Layout",
    city: "Bengaluru",
    address: "27th Main Road, Sector 2, HSR Layout",
    latitude: 12.9116,
    longitude: 77.6389,
    imageUrl: "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=1200&q=85"],
    description: "Big lifts, open space, and a welcoming local community for every kind of athlete.",
    phone: "+91 80 4999 3322",
    rating: 4.7,
    reviewCount: 76,
    distanceKm: 4.1,
    startingPrice: 149,
    isOpen: false,
    openUntil: "10:00 PM",
    gymType: "Strength gym",
    facilities: ["Free weights", "Machines", "CrossFit", "Locker", "Parking"],
  },
  {
    slug: "fitstop-whitefield",
    name: "Fitstop Whitefield",
    neighborhood: "Whitefield",
    city: "Bengaluru",
    address: "ITPL Main Road, Whitefield",
    latitude: 12.9698,
    longitude: 77.7499,
    imageUrl: "https://images.unsplash.com/photo-1593079831268-3381b0db4a77?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1593079831268-3381b0db4a77?auto=format&fit=crop&w=1200&q=85"],
    description: "A spacious neighborhood gym built for consistent training before or after work.",
    phone: "+91 80 4001 1200",
    rating: 4.4,
    reviewCount: 42,
    distanceKm: 8.9,
    startingPrice: 179,
    isOpen: true,
    openUntil: "11:00 PM",
    gymType: "Full-service gym",
    facilities: ["Cardio", "Machines", "Personal training", "AC", "Shower"],
  },
  {
    slug: "the-barbell-club-jayanagar",
    name: "The Barbell Club",
    neighborhood: "Jayanagar",
    city: "Bengaluru",
    address: "11th Main, 4th Block, Jayanagar",
    latitude: 12.9250,
    longitude: 77.5938,
    imageUrl: "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=1200&q=85"],
    description: "A barbell-first training club for people who love the process as much as the result.",
    phone: "+91 80 2671 8090",
    rating: 4.9,
    reviewCount: 156,
    distanceKm: 5.4,
    startingPrice: 299,
    isOpen: true,
    openUntil: "10:30 PM",
    gymType: "Strength gym",
    facilities: ["Free weights", "Power racks", "Personal training", "Parking"],
  },
  {
    slug: "evolve-fitness-bellandur",
    name: "Evolve Fitness",
    neighborhood: "Bellandur",
    city: "Bengaluru",
    address: "Outer Ring Road, Bellandur",
    latitude: 12.9290,
    longitude: 77.6780,
    imageUrl: "https://images.unsplash.com/photo-1540497077202-7c8a3999166f?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1540497077202-7c8a3999166f?auto=format&fit=crop&w=1200&q=85"],
    description: "A polished, calm space with premium equipment and flexible passes for busy schedules.",
    phone: "+91 80 4610 3131",
    rating: 4.5,
    reviewCount: 61,
    distanceKm: 7.8,
    startingPrice: 225,
    isOpen: true,
    openUntil: "11:00 PM",
    gymType: "Full-service gym",
    facilities: ["Cardio", "Machines", "AC", "Locker", "Shower"],
  },
  {
    slug: "lift-lab-malleswaram",
    name: "Lift Lab Malleswaram",
    neighborhood: "Malleswaram",
    city: "Bengaluru",
    address: "8th Cross, Malleswaram",
    latitude: 13.0031,
    longitude: 77.5682,
    imageUrl: "https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?auto=format&fit=crop&w=1200&q=85"],
    description: "A compact and friendly training studio with expert help when you want it.",
    phone: "+91 80 2334 7766",
    rating: 4.3,
    reviewCount: 28,
    distanceKm: 6.2,
    startingPrice: 129,
    isOpen: false,
    openUntil: "9:30 PM",
    gymType: "Training studio",
    facilities: ["Free weights", "Machines", "Personal training", "AC"],
  },
  {
    slug: "zenith-fitness-marathahalli",
    name: "Zenith Fitness",
    neighborhood: "Marathahalli",
    city: "Bengaluru",
    address: "Outer Ring Road, Marathahalli",
    latitude: 12.9591,
    longitude: 77.6974,
    imageUrl: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=85"],
    description: "A complete training floor with plenty of room for a focused, no-fuss workout.",
    phone: "+91 80 4200 1900",
    rating: 4.2,
    reviewCount: 35,
    distanceKm: 9.4,
    startingPrice: 159,
    isOpen: true,
    openUntil: "10:00 PM",
    gymType: "Full-service gym",
    facilities: ["Cardio", "Free weights", "Machines", "Locker"],
  },
  {
    slug: "forge-fitness-kalyan-nagar",
    name: "Forge Fitness",
    neighborhood: "Kalyan Nagar",
    city: "Bengaluru",
    address: "HRBR Layout, Kalyan Nagar",
    latitude: 13.0294,
    longitude: 77.6412,
    imageUrl: "https://images.unsplash.com/photo-1571902943202-507ec2618e8f?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1571902943202-507ec2618e8f?auto=format&fit=crop&w=1200&q=85"],
    description: "A neighborhood favorite with strong equipment, clean facilities, and a supportive vibe.",
    phone: "+91 80 4122 8844",
    rating: 4.6,
    reviewCount: 53,
    distanceKm: 5.9,
    startingPrice: 189,
    isOpen: true,
    openUntil: "10:30 PM",
    gymType: "Strength & conditioning",
    facilities: ["CrossFit", "Free weights", "Cardio", "Parking", "AC"],
  },
  {
    slug: "corecraft-richmond-town",
    name: "CoreCraft Studio",
    neighborhood: "Richmond Town",
    city: "Bengaluru",
    address: "Richmond Road, Richmond Town",
    latitude: 12.9634,
    longitude: 77.5911,
    imageUrl: "https://images.unsplash.com/photo-1593079831268-3381b0db4a77?auto=format&fit=crop&w=1200&q=85",
    gallery: ["https://images.unsplash.com/photo-1593079831268-3381b0db4a77?auto=format&fit=crop&w=1200&q=85"],
    description: "A design-led studio for strength, mobility, and better movement in the city.",
    phone: "+91 80 4011 7234",
    rating: 4.7,
    reviewCount: 67,
    distanceKm: 2.4,
    startingPrice: 279,
    isOpen: true,
    openUntil: "9:30 PM",
    gymType: "Fitness studio",
    facilities: ["Personal training", "Cardio", "Shower", "AC", "Locker"],
  },
];

const passTemplates = [
  { name: "1 Day Pass", description: "A full day of access. Perfect for trying a new space.", durationDays: 1, visitCount: 1, price: 199, popular: false },
  { name: "3 Day Pass", description: "Three flexible visits across one week.", durationDays: 3, visitCount: 3, price: 499, popular: true },
  { name: "7 Day Pass", description: "A full week to make your training consistent.", durationDays: 7, visitCount: 7, price: 899, popular: false },
  { name: "5 Visit Pass", description: "Five visits to use when your schedule allows.", durationDays: 30, visitCount: 5, price: 799, popular: false },
];

let seedPromise: Promise<void> | undefined;

export function ensureSeed(): Promise<void> {
  seedPromise ??= (async () => {
    const [commissionSetting] = await db.select({ id: platformSettingsTable.id }).from(platformSettingsTable).where(
      eq(platformSettingsTable.key, "platformCommissionPercentage"),
    );
    if (!commissionSetting) {
      await db.insert(platformSettingsTable).values({
        key: "platformCommissionPercentage",
        value: process.env.PLATFORM_COMMISSION_PERCENTAGE ?? "20",
      });
    }
    if (process.env.ADMIN_BOOTSTRAP_EMAIL && process.env.ADMIN_BOOTSTRAP_PASSWORD) {
      const [admin] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, process.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()));
      if (!admin) {
        await db.insert(usersTable).values({
          name: process.env.ADMIN_BOOTSTRAP_NAME ?? "OneGymSolution Admin",
          email: process.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase(),
          phone: process.env.ADMIN_BOOTSTRAP_PHONE ?? "+910000000000",
          passwordHash: await hashPassword(process.env.ADMIN_BOOTSTRAP_PASSWORD),
          role: "ADMIN",
          status: "ACTIVE",
        });
      }
    }
    for (const seed of gymSeeds) {
      const [existingGym] = await db.select({
        id: gymsTable.id,
        ownerId: gymsTable.ownerId,
        latitude: gymsTable.latitude,
        longitude: gymsTable.longitude,
      }).from(gymsTable).where(eq(gymsTable.slug, seed.slug));
      if (existingGym?.ownerId === null && (existingGym.latitude === null || existingGym.longitude === null)) {
        await db.update(gymsTable)
          .set({ latitude: seed.latitude, longitude: seed.longitude, updatedAt: new Date() })
          .where(eq(gymsTable.id, existingGym.id));
      }
    }
    const existing = await db.select({ id: gymsTable.id }).from(gymsTable).limit(1);
    if (existing.length > 0) return;

    const gyms = await db.insert(gymsTable).values(gymSeeds).returning();
    await db.insert(gymPassesTable).values(
      gyms.flatMap((gym, gymIndex) =>
        passTemplates.map((pass, passIndex) => ({
          ...pass,
          gymId: gym.id,
          price: Math.max(99, pass.price + (gymIndex % 4) * 20 + (passIndex === 0 ? (gymIndex % 3) * 10 : 0)),
        })),
      ),
    );
    await db.insert(reviewsTable).values(
      gyms.slice(0, 6).map((gym, index) => ({
        gymId: gym.id,
        author: ["Rhea S.", "Arjun K.", "Meera P.", "Vikram N.", "Sana R.", "Nikhil M."][index],
        rating: Math.min(5, 4 + (index % 2)),
        comment: ["Great equipment and easy check-in.", "The space is clean, bright, and well maintained.", "Exactly what I needed for a flexible week.", "Friendly staff and a solid training floor.", "Loved the variety of equipment.", "Good value for a drop-in session."][index],
        date: "2026-08-" + String(18 - index).padStart(2, "0"),
      })),
    );
  })();
  return seedPromise;
}