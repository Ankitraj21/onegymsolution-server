import type { NextFunction, Request, Response } from "express";
import { failure } from "../lib/http";

const attempts = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(options: { windowMs: number; max: number }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (current.count >= options.max) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      failure(res, 429, "Too many requests. Please try again later.", "RATE_LIMITED");
      return;
    }
    current.count += 1;
    next();
  };
}