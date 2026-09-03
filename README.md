# GymPass India API

This package is the production-oriented TypeScript modular monolith for GymPass
India. It uses Express 5, PostgreSQL, and Drizzle ORM. The existing `/api`
routes remain available for the MVP web client; the authenticated contract is
under `/api/v1`.

## Run locally

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Copy the root `.env.example` to your environment and set secrets through
   the workspace secret manager.
3. Push the Drizzle schema:

   ```sh
   pnpm --filter @workspace/db run push
   ```

4. Start the API:

   ```sh
   pnpm --filter @workspace/api-server run dev
   ```

The first discovery request seeds development gyms, passes, reviews, and the
configurable commission setting. Optional `ADMIN_BOOTSTRAP_*` variables create
an admin account without putting credentials in source control.

## Authentication

Register and login return a short-lived JWT access token plus a rotating
refresh token:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/users/me`

Send the access token as `Authorization: Bearer <token>`. Customer, gym-owner,
and admin resources enforce ownership and role checks at the route boundary.
Gym-owner self-registration requires `OWNER_REGISTRATION_CODE`.

## Core API groups

- Public discovery: `GET /api/v1/gyms`, `GET /api/v1/gyms/{id}`
- Customer bookings: create, list, cancel, QR retrieval
- Payments: order creation and signed Razorpay webhook processing
- Owner: gyms, passes, bookings, revenue, payouts, QR verification
- Customer social: reviews and favorites
- Admin: users, gym approvals, bookings, payments, reviews, commission,
  payouts, and dashboard analytics

In development, orders use a deterministic demo provider when Razorpay
credentials are absent. Production requires Razorpay credentials and a valid
webhook secret; payment success is never accepted from the browser.