import { createApp, finishApp, productId, quantityInput } from "../../../shared/http.js";
import type { InventoryStore } from "./store.js";

export function createInventoryApp(store: InventoryStore) {
  const app = createApp("inventory");

  app.get("/ready", async (_request, response) => {
    await store.ready();
    response.json({ service: "inventory", status: "ready" });
  });
  app.get("/inventory", async (_request, response) => {
    response.json(await store.list());
  });
  app.get("/inventory/:id", async (request, response) => {
    response.json(await store.get(productId(request)));
  });
  app.put("/inventory/:id", async (request, response) => {
    const id = productId(request);
    const { quantity } = quantityInput.parse(request.body);
    response.json(await store.put(id, quantity));
  });
  app.delete("/inventory/:id", async (request, response) => {
    await store.delete(productId(request));
    response.status(204).end();
  });
  return finishApp(app);
}
