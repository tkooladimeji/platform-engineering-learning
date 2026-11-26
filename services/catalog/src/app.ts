import { randomUUID } from "node:crypto";
import type { Product } from "../../../shared/contracts.js";
import { createApp, finishApp, HttpError, productId, productInput } from "../../../shared/http.js";

// This process owns its store; a future Cosmos repository can replace these operations.
export function createCatalogApp() {
  const products = new Map<string, Product>();
  const app = createApp("catalog");

  function find(id: string): Product {
    const product = products.get(id);
    if (!product) throw new HttpError(404, "Product not found");
    return product;
  }

  function ensureUniqueSku(sku: string, excludingId?: string): void {
    if ([...products.values()].some((product) => product.sku === sku && product.id !== excludingId)) {
      throw new HttpError(409, "A product with this SKU already exists");
    }
  }

  app.get("/products", (_request, response) => {
    response.json([...products.values()]);
  });
  app.get("/products/:id", (request, response) => {
    response.json(find(productId(request)));
  });
  app.post("/products", (request, response) => {
    const input = productInput.parse(request.body);
    ensureUniqueSku(input.sku);
    const now = new Date().toISOString();
    const product: Product = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    products.set(product.id, product);
    response.status(201).json(product);
  });
  app.put("/products/:id", (request, response) => {
    const id = productId(request);
    const existing = find(id);
    const input = productInput.parse(request.body);
    ensureUniqueSku(input.sku, id);
    const product: Product = { ...existing, ...input, updatedAt: new Date().toISOString() };
    products.set(id, product);
    response.json(product);
  });
  app.delete("/products/:id", (request, response) => {
    const id = productId(request);
    find(id);
    products.delete(id);
    response.status(204).end();
  });
  return finishApp(app);
}
