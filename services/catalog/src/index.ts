import { listen } from "../../../shared/http.js";
import { createCatalogApp } from "./app.js";
import { CatalogStore } from "./store.js";
import { createCosmosConnection } from "../../../shared/cosmos.js";

const connection = createCosmosConnection();
try {
  const store = await CatalogStore.open(connection);
  listen(createCatalogApp(store), "catalog", 4001, () => connection.client.dispose());
} catch (error) {
  connection.client.dispose();
  console.error("Catalog Cosmos DB initialization failed", error);
  process.exitCode = 1;
}
