import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import express, { type Express } from "express";
import { createCatalogApp } from "../services/catalog/src/app.js";
import { createInventoryApp } from "../services/inventory/src/app.js";
import { createGatewayApp } from "../services/gateway/src/app.js";
import { CatalogStore } from "../services/catalog/src/store.js";
import { InventoryStore } from "../services/inventory/src/store.js";
import { createCosmosConnection } from "../shared/cosmos.js";
import { HttpError } from "../shared/http.js";
import { stockedProductRecord } from "../shared/schemas.js";

async function serve(t: TestContext, app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function testConnection(t: TestContext) {
  const connection = createCosmosConnection(`stockroom-test-${randomUUID()}`);
  if (!connection.emulator) {
    connection.client.dispose();
    throw new Error("Service tests require the local Cosmos emulator; Azure databases are never used");
  }
  t.after(async () => {
    const cleanup = createCosmosConnection(connection.database.id);
    try { await cleanup.database.delete(); }
    finally {
      cleanup.client.dispose();
      connection.client.dispose();
    }
  });
  return connection;
}

async function stores(t: TestContext) {
  const connection = testConnection(t);
  const [catalogStore, inventoryStore] = await Promise.all([
    CatalogStore.open(connection), InventoryStore.open(connection),
  ]);
  return { connection, catalogStore, inventoryStore };
}

async function stack(t: TestContext, catalog = express(), inventory = express()) {
  const { catalogStore, inventoryStore, connection } = await stores(t);
  catalog.use(createCatalogApp(catalogStore));
  inventory.use(createInventoryApp(inventoryStore));
  const [catalogUrl, inventoryUrl] = await Promise.all([serve(t, catalog), serve(t, inventory)]);
  const gatewayUrl = await serve(t, createGatewayApp({ catalogUrl, inventoryUrl }));
  return { catalogUrl, inventoryUrl, gatewayUrl, catalogStore, inventoryStore, connection };
}

function send(base: string, path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const notebook = { name: "Notebook", sku: "NOTE-001", description: "A5 lined", quantity: 12 };

test("complete product lifecycle joins independent catalog and inventory stores", async (t) => {
  const { gatewayUrl, catalogUrl, inventoryUrl } = await stack(t);
  assert.equal((await send(gatewayUrl, "/ready")).status, 200);
  assert.deepEqual(await (await send(gatewayUrl, "/api/products")).json(), []);

  const createdResponse = await send(gatewayUrl, "/api/products", "POST", notebook);
  assert.equal(createdResponse.status, 201);
  const created = stockedProductRecord.parse(await createdResponse.json());
  assert.equal(created.quantity, 12);
  const metadata = await (await send(catalogUrl, `/products/${created.id}`)).json();
  assert.equal(metadata.name, "Notebook");
  assert.equal("quantity" in metadata, false);
  const stock = await (await send(inventoryUrl, `/inventory/${created.id}`)).json();
  assert.equal(stock.quantity, 12);
  assert.equal("name" in stock, false);

  const updated = await send(gatewayUrl, `/api/products/${created.id}`, "PUT", {
    name: "Updated notebook", sku: "NOTE-002", description: "Plain pages",
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).name, "Updated notebook");

  for (const quantity of [0, 42, Number.MAX_SAFE_INTEGER]) {
    const response = await send(gatewayUrl, `/api/products/${created.id}/quantity`, "PUT", { quantity });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).quantity, quantity);
  }
  assert.equal((await send(gatewayUrl, `/api/products/${created.id}`, "DELETE")).status, 204);
  assert.deepEqual(await (await send(gatewayUrl, "/api/products")).json(), []);
  assert.deepEqual(await (await send(inventoryUrl, "/inventory")).json(), []);
  assert.equal((await send(catalogUrl, `/products/${created.id}`)).status, 404);
  assert.equal((await send(gatewayUrl, `/api/products/${created.id}/quantity`, "PUT", { quantity: 1 })).status, 404);
});

test("validation and normalized SKU uniqueness leave existing data unchanged", async (t) => {
  const { gatewayUrl } = await stack(t);
  const first = stockedProductRecord.parse(await (await send(gatewayUrl, "/api/products", "POST", notebook)).json());
  const duplicate = await send(gatewayUrl, "/api/products", "POST", { ...notebook, sku: " note-001 " });
  assert.equal(duplicate.status, 409);
  for (const input of [
    { ...notebook, name: " " },
    { ...notebook, sku: "invalid sku" },
    { ...notebook, quantity: -1 },
    { ...notebook, quantity: 0.5 },
    { ...notebook, quantity: "2" },
    { ...notebook, quantity: Number.MAX_SAFE_INTEGER + 1 },
    { ...notebook, unexpected: true },
  ]) {
    assert.equal((await send(gatewayUrl, "/api/products", "POST", input)).status, 400);
  }
  for (const quantity of [-1, 0.2, "12", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await send(gatewayUrl, `/api/products/${first.id}/quantity`, "PUT", { quantity })).status, 400);
  }
  assert.equal((await send(gatewayUrl, "/api/products/not-a-uuid", "DELETE")).status, 400);
  assert.equal((await send(gatewayUrl, `/api/products/${randomUUID()}`, "DELETE")).status, 404);
  const second = stockedProductRecord.parse(await (await send(gatewayUrl, "/api/products", "POST", {
    ...notebook, sku: "NOTE-002",
  })).json());
  assert.equal((await send(gatewayUrl, `/api/products/${second.id}`, "PUT", {
    name: "Conflict", sku: "note-001", description: "",
  })).status, 409);
  const products = stockedProductRecord.array().parse(await (await send(gatewayUrl, "/api/products")).json());
  assert.equal(products.length, 2);
  assert.equal(products.find((product) => product.id === first.id)?.quantity, 12);
  assert.equal(products.find((product) => product.id === second.id)?.name, "Notebook");
});

test("malformed and oversized requests return JSON client errors", async (t) => {
  const { gatewayUrl } = await stack(t);
  for (const [body, expectedStatus] of [["{", 400], [JSON.stringify({ text: "x".repeat(33000) }), 413]] as const) {
    const response = await fetch(`${gatewayUrl}/api/products`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("concurrent duplicate creates and delete-versus-stock updates preserve successful state", async (t) => {
  const { gatewayUrl, inventoryUrl } = await stack(t);
  const responses = await Promise.all([
    send(gatewayUrl, "/api/products", "POST", notebook),
    send(gatewayUrl, "/api/products", "POST", notebook),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const success = responses.find((response) => response.status === 201);
  assert.ok(success);
  const product = stockedProductRecord.parse(await success.json());
  const mutations = await Promise.all([
    send(gatewayUrl, `/api/products/${product.id}`, "DELETE"),
    send(gatewayUrl, `/api/products/${product.id}/quantity`, "PUT", { quantity: 9 }),
  ]);
  assert.equal(mutations[0]?.status, 204);
  assert.ok(mutations[1]?.status === 200 || mutations[1]?.status === 404);
  assert.deepEqual(await (await send(gatewayUrl, "/api/products")).json(), []);
  assert.deepEqual(await (await send(inventoryUrl, "/inventory")).json(), []);
});

test("a rejected inventory create compensates the catalog write", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const failingInventory = express();
  failingInventory.put("/inventory/:id", (_request, response) => {
    response.status(503).json({ error: "Inventory unavailable" });
  });
  const { gatewayUrl, catalogUrl } = await stack(t, undefined, failingInventory);
  const response = await send(gatewayUrl, "/api/products", "POST", notebook);
  assert.equal(response.status, 502);
  assert.deepEqual(await (await send(catalogUrl, "/products")).json(), []);
});

test("a rejected catalog deletion restores the original quantity", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const failingCatalog = express();
  failingCatalog.delete("/products/:id", (_request, response) => {
    response.status(503).json({ error: "Catalog unavailable" });
  });
  const { gatewayUrl, inventoryUrl } = await stack(t, failingCatalog);
  const product = stockedProductRecord.parse(await (await send(gatewayUrl, "/api/products", "POST", notebook)).json());
  assert.equal((await send(gatewayUrl, `/api/products/${product.id}`, "DELETE")).status, 502);
  assert.equal((await (await send(inventoryUrl, `/inventory/${product.id}`)).json()).quantity, 12);
  const listed = stockedProductRecord.array().parse(await (await send(gatewayUrl, "/api/products")).json());
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.quantity, 12);
});

test("missing stock is reported rather than silently reset to zero or recreated", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { gatewayUrl, inventoryUrl } = await stack(t);
  const product = stockedProductRecord.parse(await (await send(gatewayUrl, "/api/products", "POST", notebook)).json());
  await send(inventoryUrl, `/inventory/${product.id}`, "DELETE");
  assert.equal((await send(gatewayUrl, "/api/products")).status, 502);
  assert.equal((await send(gatewayUrl, `/api/products/${product.id}/quantity`, "PUT", { quantity: 8 })).status, 502);
  assert.equal((await send(gatewayUrl, `/api/products/${product.id}`, "DELETE")).status, 502);
  assert.deepEqual(await (await send(inventoryUrl, "/inventory")).json(), []);
});

test("readiness and response validation surface broken dependencies", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const catalog = express();
  catalog.get("/ready", (_request, response) => response.json({ status: "ready" }));
  catalog.get("/products", (_request, response) => response.json([]));
  const invalidInventory = express();
  invalidInventory.get("/ready", (_request, response) => response.status(503).json({ error: "Unavailable" }));
  invalidInventory.get("/inventory", (_request, response) => response.json([{ quantity: "invalid" }]));
  const { gatewayUrl } = await stack(t, catalog, invalidInventory);
  assert.equal((await send(gatewayUrl, "/health")).status, 200);
  assert.equal((await send(gatewayUrl, "/ready")).status, 502);
  assert.equal((await send(gatewayUrl, "/api/products")).status, 502);
});

test("Cosmos records survive replacement of both clients and service apps", async (t) => {
  const { gatewayUrl, connection } = await stack(t);
  const created = stockedProductRecord.parse(await (await send(gatewayUrl, "/api/products", "POST", notebook)).json());
  await send(gatewayUrl, `/api/products/${created.id}/quantity`, "PUT", { quantity: 73 });
  connection.client.dispose();

  const restarted = createCosmosConnection(connection.database.id);
  t.after(() => restarted.client.dispose());
  const catalog = await CatalogStore.open(restarted);
  const inventory = await InventoryStore.open(restarted);
  const catalogUrl = await serve(t, createCatalogApp(catalog));
  const inventoryUrl = await serve(t, createInventoryApp(inventory));
  const restartedGateway = await serve(t, createGatewayApp({ catalogUrl, inventoryUrl }));
  const products = stockedProductRecord.array().parse(await (await send(restartedGateway, "/api/products")).json());
  assert.equal(products.length, 1);
  assert.equal(products[0]?.id, created.id);
  assert.equal(products[0]?.quantity, 73);
  assert.equal(products[0]?.createdAt, created.createdAt);
  assert.equal((await send(restartedGateway, `/api/products/${created.id}`, "DELETE")).status, 204);
  const reused = await send(restartedGateway, "/api/products", "POST", notebook);
  assert.equal(reused.status, 201);
});

test("independent catalog replicas atomically reject normalized duplicate creates and SKU updates", async (t) => {
  const { catalogUrl, connection, catalogStore } = await stack(t);
  const second = await CatalogStore.open(connection);
  const secondUrl = await serve(t, createCatalogApp(second));
  const input = { name: notebook.name, sku: notebook.sku, description: notebook.description };
  const created = await Promise.all([
    send(catalogUrl, "/products", "POST", input),
    send(secondUrl, "/products", "POST", { ...input, sku: " note-001 " }),
  ]);
  assert.deepEqual(created.map((response) => response.status).sort(), [201, 409]);
  const [firstProduct, secondProduct] = await Promise.all([
    catalogStore.create({ ...input, sku: "FIRST" }),
    second.create({ ...input, sku: "SECOND" }),
  ]);
  const updated = await Promise.all([
    send(catalogUrl, `/products/${firstProduct.id}`, "PUT", { ...input, sku: "CLAIMED" }),
    send(secondUrl, `/products/${secondProduct.id}`, "PUT", { ...input, sku: "claimed" }),
  ]);
  assert.deepEqual(updated.map((response) => response.status).sort(), [200, 409]);
  const stored = await catalogStore.list();
  assert.equal(stored.length, 3);
  assert.equal(stored.filter((product) => product.sku === "CLAIMED").length, 1);
});

test("catalog conditional updates and deletes do not overwrite a concurrent writer", async (t) => {
  const { catalogStore, connection } = await stores(t);
  const second = await CatalogStore.open(connection);
  const input = { name: "Original", sku: "ETAG", description: "" };
  const product = await catalogStore.create(input);
  const item = catalogStore.container.item(product.id, "catalog");
  const read = item.read.bind(item);
  t.mock.method(item, "read", async () => {
    const snapshot = await read();
    await second.update(product.id, { ...input, name: "Concurrent writer" });
    return snapshot;
  });
  t.mock.method(catalogStore.container, "item", () => item);
  const conflict = (error: unknown) => error instanceof HttpError && error.status === 409;
  await assert.rejects(catalogStore.update(product.id, { ...input, name: "Stale writer" }), conflict);
  await assert.rejects(catalogStore.delete(product.id), conflict);
  assert.equal((await second.get(product.id)).name, "Concurrent writer");
});

test("lost Cosmos containers fail readiness and CRUD instead of returning empty local stores", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { gatewayUrl, catalogUrl, catalogStore, inventoryUrl, inventoryStore } = await stack(t);
  await catalogStore.container.delete();
  assert.equal((await send(catalogUrl, "/health")).status, 200);
  assert.equal((await send(catalogUrl, "/ready")).status, 503);
  assert.equal((await send(catalogUrl, "/products")).status, 503);
  assert.equal((await send(catalogUrl, `/products/${randomUUID()}`)).status, 503);
  assert.equal((await send(gatewayUrl, "/ready")).status, 502);
  assert.equal((await send(catalogUrl, "/products", "POST", {
    name: "Unavailable", sku: "UNAVAILABLE", description: "",
  })).status, 503);
  await inventoryStore.container.delete();
  assert.equal((await send(inventoryUrl, "/ready")).status, 503);
  assert.equal((await send(inventoryUrl, "/inventory")).status, 503);
  assert.equal((await send(inventoryUrl, `/inventory/${randomUUID()}`)).status, 503);
});

test("existing incompatible containers are rejected without deleting their data", async (t) => {
  const { connection, catalogStore } = await stores(t);
  await catalogStore.container.delete();
  const { container } = await connection.database.containers.create({
    id: "products", partitionKey: { paths: ["/id"] },
  });
  await container.items.create({ id: "existing", marker: "preserve" });
  await assert.rejects(CatalogStore.open(connection), /incompatible partition or unique-key policy/);
  assert.equal((await container.item("existing", "existing").read()).resource?.marker, "preserve");
});

test("concurrent database and container initialization safely verifies creation conflicts", async (t) => {
  const connection = testConnection(t);
  const replica = createCosmosConnection(connection.database.id);
  t.after(() => replica.client.dispose());
  const [catalog, secondCatalog] = await Promise.all([
    CatalogStore.open(connection), CatalogStore.open(replica), InventoryStore.open(replica),
  ]);
  const product = await catalog.create({ name: "Shared", sku: "SHARED", description: "" });
  assert.equal((await secondCatalog.get(product.id)).sku, "SHARED");

  t.mock.method(replica.client.databases, "createIfNotExists", async () => {
    throw Object.assign(new Error("Created by another service"), { code: 409 });
  });
  t.mock.method(replica.database.containers, "createIfNotExists", async () => {
    throw Object.assign(new Error("Created by another replica"), { code: 409 });
  });
  assert.equal((await (await CatalogStore.open(replica)).get(product.id)).id, product.id);
  await connection.database.container("products").delete();
  await assert.rejects(CatalogStore.open(replica));
});
