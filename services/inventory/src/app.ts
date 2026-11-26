import type { Stock } from "../../../shared/contracts.js";
import { createApp, finishApp, HttpError, productId, quantityInput } from "../../../shared/http.js";

export function createInventoryApp() {
  const inventory = new Map<string, Stock>();
  const app = createApp("inventory");

  app.get("/inventory", (_request, response) => {
    response.json([...inventory.values()]);
  });
  app.get("/inventory/:id", (request, response) => {
    const stock = inventory.get(productId(request));
    if (!stock) throw new HttpError(404, "Stock record not found");
    response.json(stock);
  });
  app.put("/inventory/:id", (request, response) => {
    const id = productId(request);
    const { quantity } = quantityInput.parse(request.body);
    const stock: Stock = { productId: id, quantity, updatedAt: new Date().toISOString() };
    inventory.set(id, stock);
    response.json(stock);
  });
  app.delete("/inventory/:id", (request, response) => {
    if (!inventory.delete(productId(request))) throw new HttpError(404, "Stock record not found");
    response.status(204).end();
  });
  return finishApp(app);
}
