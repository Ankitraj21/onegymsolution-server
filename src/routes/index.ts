import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gymsRouter from "./gyms";
import bookingsRouter from "./bookings";
import authV1Router from "./auth-v1";
import usersV1Router from "./users-v1";
import gymsV1Router from "./gyms-v1";
import bookingsV1Router from "./bookings-v1";
import socialV1Router from "./social-v1";
import adminV1Router from "./admin-v1";
import docsV1Router from "./docs-v1";
import fitnessAiV1Router from "./fitness-ai-v1";
import fitnessTrackingV1Router from "./fitness-tracking-v1";

const router: IRouter = Router();

router.use(healthRouter);
router.use(gymsRouter);
router.use(bookingsRouter);
router.use("/v1", authV1Router);
router.use("/v1", usersV1Router);
router.use("/v1", gymsV1Router);
router.use("/v1", bookingsV1Router);
router.use("/v1", socialV1Router);
router.use("/v1", docsV1Router);
router.use("/v1", fitnessAiV1Router);
router.use("/v1", fitnessTrackingV1Router);
router.use("/v1", adminV1Router);

export default router;
