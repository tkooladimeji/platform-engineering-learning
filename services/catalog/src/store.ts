import { randomUUID } from "node:crypto";
import type { Container } from "@azure/cosmos";
import { z } from "zod";
import type { Product } from "../../../shared/contracts.js";
import { cosmosOperation, decodeDocument, openCosmosContainer, type CosmosConnection } from "../../../shared/cosmos.js";
import { productRecord } from "../../../shared/schemas.js";

const partition = "catalog";
const documentSchema = productRecord.extend({ catalogId: z.literal(partition), _etag: z.string().min(1) }).strip();
const notFound = "Product not found";
const duplicate = "A product with this SKU already exists";

function decode(resource: unknown) {
  const { catalogId: _partition, _etag: etag, ...product } = decodeDocument(documentSchema, resource);
  return { product, etag };
}

export class CatalogStore {
  constructor(readonly container: Container) {}

  static async open(connection: CosmosConnection) {
    return new CatalogStore(await openCosmosContainer(connection, {
      id: "products",
      // Cosmos unique keys apply within a partition; one catalog partition makes SKU uniqueness global.
      partitionKey: { paths: ["/catalogId"] },
      uniqueKeyPolicy: { uniqueKeys: [{ paths: ["/sku"] }] },
    }));
  }

  async ready() {
    await cosmosOperation(() => this.container.read());
  }

  async list(): Promise<Product[]> {
    const { resources } = await cosmosOperation(() => this.container.items.query(
      "SELECT * FROM c ORDER BY c.createdAt", { partitionKey: partition },
    ).fetchAll());
    return resources.map((resource: unknown) => decode(resource).product);
  }

  private async read(id: string) {
    const { resource } = await cosmosOperation(() => this.container.item(id, partition).read(), {
      notFound: { container: this.container, message: notFound },
    });
    return decode(resource);
  }

  async get(id: string): Promise<Product> {
    return (await this.read(id)).product;
  }

  async create(input: Pick<Product, "name" | "sku" | "description">): Promise<Product> {
    const now = new Date().toISOString();
    const product: Product = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    await cosmosOperation(() => this.container.items.create({ ...product, catalogId: partition }), { duplicate });
    return product;
  }

  async update(id: string, input: Pick<Product, "name" | "sku" | "description">): Promise<Product> {
    const { product: existing, etag } = await this.read(id);
    const product: Product = { ...existing, ...input, updatedAt: new Date().toISOString() };
    await cosmosOperation(() => this.container.item(id, partition).replace(
      { ...product, catalogId: partition }, { accessCondition: { type: "IfMatch", condition: etag } },
    ), { notFound: { container: this.container, message: notFound }, duplicate });
    return product;
  }

  async delete(id: string): Promise<void> {
    const { etag } = await this.read(id);
    await cosmosOperation(() => this.container.item(id, partition).delete({
      accessCondition: { type: "IfMatch", condition: etag },
    }), { notFound: { container: this.container, message: notFound } });
  }
}
