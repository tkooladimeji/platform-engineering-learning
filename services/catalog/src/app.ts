import { createApp, finishApp, productId, productInput } from "../../../shared/http.js";
import type { CatalogStore } from "./store.js";

export function createCatalogApp(store: CatalogStore) {
  const app = createApp("catalog");

  app.get("/ready", async (_request, response) => {
    await store.ready();
    response.json({ service: "catalog", status: "ready" });
  });
  app.get("/products", async (_request, response) => {
    response.json(await store.list());
  });
  app.get("/products/:id", async (request, response) => {
    response.json(await store.get(productId(request)));
  });
  app.post("/products", async (request, response) => {
    const input = productInput.parse(request.body);
    response.status(201).json(await store.create(input));
  });
  app.put("/products/:id", async (request, response) => {
    const id = productId(request);
    const input = productInput.parse(request.body);
    response.json(await store.update(id, input));
  });
  app.delete("/products/:id", async (request, response) => {
    await store.delete(productId(request));
    response.status(204).end();
  });
  return finishApp(app);
}
