import { Router, type IRouter } from "express";

const router: IRouter = Router();

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "GymPass India API",
    version: "1.0.0",
    description: "Authenticated modular-monolith API for gym discovery, bookings, payments, and check-in.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/auth/register": { post: { summary: "Register a customer or invited gym owner" } },
    "/auth/login": { post: { summary: "Login and receive access and refresh tokens" } },
    "/auth/refresh": { post: { summary: "Rotate a refresh token" } },
    "/auth/logout": { post: { summary: "Revoke a refresh token" } },
    "/users/me": { get: { summary: "Get the authenticated user" } },
    "/gyms": { get: { summary: "List active gyms with filters and pagination" } },
    "/gyms/{id}": { get: { summary: "Get an active gym and available passes" } },
    "/bookings": { get: { summary: "List the authenticated customer's bookings" }, post: { summary: "Create a booking and payment order" } },
    "/bookings/{reference}": { get: { summary: "Get an owned booking" } },
    "/bookings/{reference}/cancel": { post: { summary: "Cancel an owned booking" } },
    "/bookings/{reference}/qr": { get: { summary: "Get a confirmed booking QR token" } },
    "/payments/create-order": { post: { summary: "Create or retrieve a payment order" } },
    "/payments/webhook": { post: { summary: "Process a signed Razorpay webhook", security: [] } },
    "/checkins/verify": { post: { summary: "Atomically verify and consume a gym QR pass" } },
    "/favorites": { get: { summary: "List the customer's favorite gyms" } },
    "/favorites/{gymId}": { post: { summary: "Favorite a gym" }, delete: { summary: "Remove a favorite" } },
    "/gyms/{id}/reviews": { get: { summary: "List gym reviews" }, post: { summary: "Review an eligible completed booking" } },
    "/owner/gyms": { get: { summary: "List owned gyms" }, post: { summary: "Submit a gym for approval" } },
    "/owner/bookings": { get: { summary: "List bookings for owned gyms" } },
    "/owner/revenue": { get: { summary: "View owned gym revenue" } },
    "/admin/dashboard": { get: { summary: "View platform analytics" } },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
};

router.get("/openapi.json", (_req, res) => {
  res.json(openapi);
});

router.get("/docs", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><title>GymPass India API</title><meta charset="utf-8"></head><body style="font-family:system-ui;max-width:760px;margin:48px auto;padding:0 20px"><h1>GymPass India API</h1><p>OpenAPI contract: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p><p>Use an Authorization Bearer token for protected routes. Razorpay webhooks authenticate with their signature header.</p></body></html>`);
});

export default router;