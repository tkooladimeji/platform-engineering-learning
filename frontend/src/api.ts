import type { CreateProductInput, ProductInput } from "../../shared/contracts";
import { z } from "zod";
import { stockedProductRecord } from "../../shared/schemas";

async function request<T>(
  path: string, schema: z.ZodType<T>, method = "GET", body?: unknown, signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Cannot reach the API gateway. Check that all three backend services are running.", { cause: error });
  }
  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed (${response.status}). Check the backend service logs.`;
    try {
      const payload: unknown = JSON.parse(text);
      if (typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string") {
        message = payload.error;
        if ("details" in payload && Array.isArray(payload.details)) {
          message += `: ${payload.details.filter((detail): detail is string => typeof detail === "string").join("; ")}`;
        }
      }
    } catch {
      // Vite's proxy can return a non-JSON error when the gateway is offline.
      console.error("Non-JSON API error", response.status, text);
    }
    throw new Error(message);
  }
  const result = schema.safeParse(response.status === 204 ? undefined : await response.json());
  if (!result.success) {
    console.error("Invalid API response", result.error);
    throw new Error("The API returned invalid data. Check the backend service logs.");
  }
  return result.data;
}

export const api = {
  list: (signal?: AbortSignal) => request("/products", stockedProductRecord.array(), "GET", undefined, signal),
  create: (input: CreateProductInput) => request("/products", stockedProductRecord, "POST", input),
  update: (id: string, input: ProductInput) => request(`/products/${id}`, stockedProductRecord, "PUT", input),
  quantity: (id: string, quantity: number) => request(`/products/${id}/quantity`, stockedProductRecord, "PUT", { quantity }),
  remove: (id: string) => request(`/products/${id}`, z.undefined(), "DELETE"),
};
