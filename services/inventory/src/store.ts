import type { Container } from "@azure/cosmos";
import { z } from "zod";
import type { Stock } from "../../../shared/contracts.js";
import { cosmosOperation, decodeDocument, openCosmosContainer, type CosmosConnection } from "../../../shared/cosmos.js";
import { stockRecord } from "../../../shared/schemas.js";

const documentSchema = stockRecord.extend({ id: z.uuid() }).strip()
  .refine((stock) => stock.id === stock.productId, "Stock id must match productId");
const notFound = "Stock record not found";

function decode(resource: unknown): Stock {
  const { id: _id, ...stock } = decodeDocument(documentSchema, resource);
  return stock;
}

export class InventoryStore {
  constructor(readonly container: Container) {}

  static async open(connection: CosmosConnection) {
    return new InventoryStore(await openCosmosContainer(connection, {
      id: "inventory", partitionKey: { paths: ["/productId"] },
    }));
  }

  async ready() {
    await cosmosOperation(() => this.container.read());
  }

  async list(): Promise<Stock[]> {
    const { resources } = await cosmosOperation(() => this.container.items.query("SELECT * FROM c").fetchAll());
    return resources.map((resource: unknown) => decode(resource));
  }

  async get(id: string): Promise<Stock> {
    const { resource } = await cosmosOperation(() => this.container.item(id, id).read(), {
      notFound: { container: this.container, message: notFound },
    });
    return decode(resource);
  }

  async put(id: string, quantity: number): Promise<Stock> {
    const stock: Stock = { productId: id, quantity, updatedAt: new Date().toISOString() };
    await cosmosOperation(() => this.container.items.upsert({ ...stock, id }));
    return stock;
  }

  async delete(id: string): Promise<void> {
    await cosmosOperation(() => this.container.item(id, id).delete(), {
      notFound: { container: this.container, message: notFound },
    });
  }
}
