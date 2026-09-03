import { createHmac, timingSafeEqual } from "node:crypto";

export type ProviderOrder = {
  id: string;
  amount: number;
  currency: string;
  provider: "RAZORPAY" | "DEMO";
};

export async function createPaymentOrder(input: {
  amount: number;
  receipt: string;
}): Promise<ProviderOrder> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    if (process.env.NODE_ENV === "production" || process.env.PAYMENT_PROVIDER === "razorpay") {
      throw new Error("Razorpay credentials are not configured");
    }
    return {
      id: `demo_order_${input.receipt.toLowerCase()}`,
      amount: Math.round(input.amount * 100),
      currency: "INR",
      provider: "DEMO",
    };
  }
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: Math.round(input.amount * 100),
      currency: "INR",
      receipt: input.receipt,
      payment_capture: 1,
    }),
  });
  if (!response.ok) throw new Error(`Razorpay order creation failed with status ${response.status}`);
  const order = await response.json() as { id: string; amount: number; currency: string };
  return { id: order.id, amount: order.amount, currency: order.currency, provider: "RAZORPAY" };
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return process.env.NODE_ENV !== "production" && !secret;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}