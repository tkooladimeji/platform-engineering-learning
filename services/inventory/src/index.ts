import { listen } from "../../../shared/http.js";
import { createInventoryApp } from "./app.js";
import { InventoryStore } from "./store.js";
import { createCosmosConnection } from "../../../shared/cosmos.js";

const connection = createCosmosConnection();
try {
  const store = await InventoryStore.open(connection);
  listen(createInventoryApp(store), "inventory", 4002, () => connection.client.dispose());
} catch (error) {
  connection.client.dispose();
  console.error("Inventory Cosmos DB initialization failed", error);
  process.exitCode = 1;
}
