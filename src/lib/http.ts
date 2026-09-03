import type { Response } from "express";

export function success<T>(res: Response, data: T, message = "Success", status = 200): void {
  res.status(status).json({
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  });
}

export function failure(
  res: Response,
  status: number,
  message: string,
  errorCode: string,
): void {
  res.status(status).json({
    success: false,
    message,
    errorCode,
    timestamp: new Date().toISOString(),
  });
}