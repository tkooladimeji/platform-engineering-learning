import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import express, { type Express } from "express";
import { createCatalogApp } from "../services/catalog/src/app.js";
import { createInventoryApp } from "../services/inventory/src/app.js";
import { createGatewayApp } from "../services/gateway/src/app.js";
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

async function stack(t: TestContext, catalog = createCatalogApp(), inventory = createInventoryApp()) {
  const [catalogUrl, inventoryUrl] = await Promise.all([serve(t, catalog), serve(t, inventory)]);
  const gatewayUrl = await serve(t, createGatewayApp({ catalogUrl, inventoryUrl }));
  return { catalogUrl, inventoryUrl, gatewayUrl };
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
  failingInventory.use(createInventoryApp());
  const { gatewayUrl, catalogUrl } = await stack(t, createCatalogApp(), failingInventory);
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
  failingCatalog.use(createCatalogApp());
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
  const invalidInventory = express();
  invalidInventory.get("/health", (_request, response) => response.status(503).json({ error: "Unavailable" }));
  invalidInventory.get("/inventory", (_request, response) => response.json([{ quantity: "invalid" }]));
  const { gatewayUrl } = await stack(t, createCatalogApp(), invalidInventory);
  assert.equal((await send(gatewayUrl, "/health")).status, 200);
  assert.equal((await send(gatewayUrl, "/ready")).status, 502);
  assert.equal((await send(gatewayUrl, "/api/products")).status, 502);
});
