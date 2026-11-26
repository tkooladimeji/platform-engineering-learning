import { z } from "zod";

export const productInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().toUpperCase().min(1).max(64).regex(/^[A-Z0-9_-]+$/),
  description: z.string().trim().max(1000).default(""),
});

export const quantityInput = z.strictObject({
  quantity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const createProductInput = productInput.extend({
  quantity: quantityInput.shape.quantity,
});

export const productRecord = productInput.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const stockRecord = quantityInput.extend({
  productId: z.uuid(),
  updatedAt: z.iso.datetime(),
});

export const stockedProductRecord = productRecord.extend({
  quantity: quantityInput.shape.quantity,
  stockUpdatedAt: z.iso.datetime(),
});
