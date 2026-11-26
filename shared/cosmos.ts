import { CosmosClient, type Container, type ContainerDefinition } from "@azure/cosmos";
import { z } from "zod";
import { HttpError } from "./http.js";

export function createCosmosConnection(databaseId = process.env.COSMOS_DATABASE ?? "stockroom") {
  const endpoint = new URL(process.env.COSMOS_ENDPOINT ?? "http://127.0.0.1:8081");
  const emulator = endpoint.protocol === "http:"
    && ["localhost", "127.0.0.1", "cosmos", "host.docker.internal"].includes(endpoint.hostname);
  if (!emulator && endpoint.protocol !== "https:") {
    throw new Error("COSMOS_ENDPOINT must use HTTPS outside the local emulator");
  }
  const key = process.env.COSMOS_KEY
    ?? (emulator ? Buffer.from("local-emulator-only").toString("base64") : undefined);
  if (!key?.trim()) throw new Error("COSMOS_KEY is required for an Azure Cosmos DB endpoint");
  z.string().min(1).regex(/^[A-Za-z0-9_-]+$/).parse(databaseId);
  const client = new CosmosClient({
    endpoint: endpoint.href,
    key,
    connectionPolicy: { enableEndpointDiscovery: !emulator, requestTimeout: 5000 },
  });
  return { client, database: client.database(databaseId), emulator };
}

export type CosmosConnection = ReturnType<typeof createCosmosConnection>;

async function createLocalResource(
  create: () => Promise<unknown>, read: () => Promise<{ resource?: { id?: string } }>, id: string,
) {
  try {
    await create();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 409)) throw error;
    // createIfNotExists can race another service; only accept a verified existing resource.
    const { resource } = await read();
    if (resource?.id !== id) throw new Error(`Cosmos resource ${id} is not readable after concurrent creation`);
  }
}

export async function openCosmosContainer(
  connection: CosmosConnection, definition: ContainerDefinition & { id: string; partitionKey: { paths: string[] } },
) {
  const { client, database, emulator } = connection;
  // Azure resources are provisioned separately; only the local emulator is bootstrapped here.
  if (emulator) {
    await createLocalResource(
      () => client.databases.createIfNotExists({ id: database.id }), () => database.read(), database.id,
    );
    await createLocalResource(
      () => database.containers.createIfNotExists(definition),
      () => database.container(definition.id).read(), definition.id,
    );
  }
  const container = database.container(definition.id);
  const { resource } = await container.read();
  const actualKeys = resource?.uniqueKeyPolicy?.uniqueKeys ?? [];
  const expectedKeys = definition.uniqueKeyPolicy?.uniqueKeys ?? [];
  if (JSON.stringify(resource?.partitionKey?.paths) !== JSON.stringify(definition.partitionKey.paths)
    || (resource?.partitionKey?.kind !== undefined && resource.partitionKey.kind !== "Hash")
    || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Cosmos container ${definition.id} has an incompatible partition or unique-key policy; migrate its data or select a fresh COSMOS_DATABASE`);
  }
  return container;
}

export async function cosmosOperation<T>(
  operation: () => Promise<T>,
  options: { notFound?: { container: Container; message: string }; duplicate?: string } = {},
): Promise<T> {
  try {
    const result = await operation();
    // Item.read returns a 404 response rather than rejecting like other SDK operations.
    if (typeof result === "object" && result !== null && "statusCode" in result
      && typeof result.statusCode === "number" && result.statusCode >= 400) {
      throw Object.assign(new Error(`Cosmos DB returned HTTP ${result.statusCode}`), { code: result.statusCode });
    }
    return result;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const notFound = options.notFound;
    if (code === 404 && notFound) {
      await cosmosOperation(() => notFound.container.read());
      throw new HttpError(404, notFound.message);
    }
    if (code === 409 && options.duplicate) throw new HttpError(409, options.duplicate);
    if (code === 412) throw new HttpError(409, "This record changed concurrently; refresh and try again");
    console.error("Cosmos DB operation failed", error instanceof Error ? error.message : error);
    throw new HttpError(503, "Cosmos DB is unavailable; a write may have completed. Refresh before retrying");
  }
}

export function decodeDocument<T>(schema: z.ZodType<T>, resource: unknown): T {
  const parsed = schema.safeParse(resource);
  if (!parsed.success) {
    console.error("Invalid Cosmos DB document", parsed.error);
    throw new HttpError(502, "Cosmos DB returned invalid stored data");
  }
  return parsed.data;
}
