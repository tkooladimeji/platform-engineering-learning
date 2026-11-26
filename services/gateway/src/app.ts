import type { Product, Stock, StockedProduct } from "../../../shared/contracts.js";
import { z } from "zod";
import { productRecord, stockRecord } from "../../../shared/schemas.js";
import {
  createApp, createProductInput, finishApp, HttpError, productId, productInput, quantityInput,
} from "../../../shared/http.js";

interface GatewayOptions {
  catalogUrl: string;
  inventoryUrl: string;
  timeoutMs?: number;
}

export function createGatewayApp({ catalogUrl, inventoryUrl, timeoutMs = 3000 }: GatewayOptions) {
  const app = createApp("gateway");

  async function request<T>(
    base: string, path: string, schema: z.ZodType<T>, method = "GET", body?: unknown,
  ): Promise<T> {
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const payload: unknown = await response.json();
        const message = typeof payload === "object" && payload !== null && "error" in payload
          && typeof payload.error === "string" ? payload.error : "Data service rejected the request";
        throw new HttpError(response.status >= 500 ? 502 : response.status, message);
      }
      return schema.parse(response.status === 204 ? undefined : await response.json());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error(`Downstream ${method} ${base}${path} failed`, error);
      throw new HttpError(502, "A data service is unavailable or returned invalid data; the operation may not have completed");
    }
  }

  // One gateway serializes reads and writes to hide intermediate multi-service changes.
  // This is local coordination, not a distributed transaction or multi-replica lock.
  let tail: Promise<void> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function withStock(product: Product): Promise<StockedProduct> {
    let stock: Stock;
    try {
      stock = await request(inventoryUrl, `/inventory/${product.id}`, stockRecord);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new HttpError(502, "Product has no stock record. Restart all services to reset the local stores.");
      }
      throw error;
    }
    return { ...product, quantity: stock.quantity, stockUpdatedAt: stock.updatedAt };
  }

  app.get("/ready", async (_request, response) => {
    await Promise.all([
      request(catalogUrl, "/health", z.object({ status: z.literal("ok") })),
      request(inventoryUrl, "/health", z.object({ status: z.literal("ok") })),
    ]);
    response.json({ service: "gateway", status: "ready" });
  });

  app.get("/api/products", async (_request, response) => {
    const products = await serial(async () => {
      const [catalog, inventory] = await Promise.all([
        request(catalogUrl, "/products", productRecord.array()),
        request(inventoryUrl, "/inventory", stockRecord.array()),
      ]);
      const stockById = new Map(inventory.map((stock) => [stock.productId, stock]));
      return catalog.map((product): StockedProduct => {
        const stock = stockById.get(product.id);
        if (!stock) {
          throw new HttpError(502, "Product has no stock record. Restart all services to reset the local stores.");
        }
        return { ...product, quantity: stock.quantity, stockUpdatedAt: stock.updatedAt };
      });
    });
    response.json(products);
  });

  app.post("/api/products", async (req, response) => {
    const { quantity, ...input } = createProductInput.parse(req.body);
    const product = await serial(async () => {
      const created = await request(catalogUrl, "/products", productRecord, "POST", input);
      try {
        const stock = await request(inventoryUrl, `/inventory/${created.id}`, stockRecord, "PUT", { quantity });
        return { ...created, quantity: stock.quantity, stockUpdatedAt: stock.updatedAt };
      } catch (error) {
        // A timed-out inventory write has an uncertain outcome; never claim atomicity.
        try {
          await request(catalogUrl, `/products/${created.id}`, z.undefined(), "DELETE");
        } catch (rollbackError) {
          console.error("Product creation rollback failed", { error, rollbackError, productId: created.id });
          throw new HttpError(502, "Creation and cleanup failed. Restart all services to reset the local stores.");
        }
        throw error;
      }
    });
    response.status(201).json(product);
  });

  app.put("/api/products/:id", async (req, response) => {
    const id = productId(req);
    const input = productInput.parse(req.body);
    const product = await serial(async () => {
      const existing = await request(catalogUrl, `/products/${id}`, productRecord);
      const stock = await withStock(existing);
      const updated = await request(catalogUrl, `/products/${id}`, productRecord, "PUT", input);
      return { ...updated, quantity: stock.quantity, stockUpdatedAt: stock.stockUpdatedAt };
    });
    response.json(product);
  });

  app.put("/api/products/:id/quantity", async (req, response) => {
    const id = productId(req);
    const input = quantityInput.parse(req.body);
    const product = await serial(async () => {
      const existing = await request(catalogUrl, `/products/${id}`, productRecord);
      // Do not silently recreate stock lost through an inventory process restart.
      await withStock(existing);
      const stock = await request(inventoryUrl, `/inventory/${id}`, stockRecord, "PUT", input);
      return { ...existing, quantity: stock.quantity, stockUpdatedAt: stock.updatedAt };
    });
    response.json(product);
  });

  app.delete("/api/products/:id", async (req, response) => {
    const id = productId(req);
    await serial(async () => {
      const existing = await request(catalogUrl, `/products/${id}`, productRecord);
      const stock = await withStock(existing);
      await request(inventoryUrl, `/inventory/${id}`, z.undefined(), "DELETE");
      try {
        await request(catalogUrl, `/products/${id}`, z.undefined(), "DELETE");
      } catch (error) {
        try {
          await request(inventoryUrl, `/inventory/${id}`, stockRecord, "PUT", { quantity: stock.quantity });
        } catch (rollbackError) {
          console.error("Product deletion rollback failed", { error, rollbackError, productId: id });
          throw new HttpError(502, "Deletion and stock restore failed. Restart all services to reset the local stores.");
        }
        throw error;
      }
    });
    response.status(204).end();
  });
  return finishApp(app);
}
