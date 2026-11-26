# Learning Kubernetes: Stockroom

A React stock-management app backed by **three independently running Node.js/TypeScript services** and Azure Cosmos DB for NoSQL. Docker Compose runs the frontend, services, and a persistent local Cosmos emulator together; no Azure account is needed.

Create products, edit names/SKUs/descriptions, set quantities, search inventory, and delete products with their stock records. SKUs are unique, case-insensitive, and normalized to uppercase. Quantities must be non-negative safe integers.

## Requirements

- Node.js **22.12 or later** and npm.
- Docker with Docker Compose v2 for the local Cosmos emulator and containerized apps.
- Optional: [nvm](https://github.com/nvm-sh/nvm) to select the version in `.nvmrc`.
- Four available ports: `5173`, `4000`, `4001`, and `4002`.
- Emulator ports: `8081` API, `1234` Data Explorer, `18082` health. The containerized frontend uses `8080`.

## Run everything with Docker Compose

From this repository's root:

```bash
docker compose up --build --wait
```

Open **http://127.0.0.1:8080**. Inspect database `stockroom` in **http://127.0.0.1:1234**.
Compose waits for Cosmos readiness before starting catalog/inventory, then for the gateway before starting the frontend.

If you already started a standalone emulator (for example, `cosmos-local`), stop it first: it uses the same host ports. Compose uses its own `stockroom_cosmos-data` volume; a standalone emulator's volume/data is not automatically imported or deleted.

```bash
docker compose restart catalog inventory
docker compose down
docker compose up --wait
```

Product metadata and quantities survive these restarts and container recreation. **Do not use `docker compose down --volumes` unless you intend to delete the local database.** The named volume is mounted at `/data`.

The emulator uses local HTTP and does not enforce authentication. Published ports bind only to loopback; do not expose it publicly. Telemetry is disabled. It supports a subset of Cosmos features, so it is not a production database or a substitute for later Azure validation.

## Run on local Kubernetes

The `k8s/` manifests run Cosmos **inside the cluster**, with an internal headless Service and a single-replica StatefulSet. A 5 GiB persistent volume claim (`data-cosmos-0`) mounts at `/data`. Catalog and inventory read `cosmos-config`, wait for emulator readiness in init containers, and use `/ready` for database-aware readiness checks. Backend liveness uses `/health`; Cosmos liveness uses `/alive`.

Use a trusted local cluster, not AKS or production: the emulator does not enforce authentication. The commands below explicitly target Docker Desktop. The cluster needs a default dynamic StorageClass (Docker Desktop's `standard` works) and enough memory for Cosmos's 1 GiB request/4 GiB limit plus the applications.

Build the new image tags from the repository root; old `local-v1` images do not contain the Cosmos migration:

```bash
docker build -f services/catalog/Dockerfile -t stockroom-catalog:local-cosmos-v1 .
docker build -f services/inventory/Dockerfile -t stockroom-inventory:local-cosmos-v1 .
docker build -f services/gateway/Dockerfile -t stockroom-gateway:local-cosmos-v1 .
docker build -f frontend/Dockerfile -t stockroom-frontend:local-cosmos-v1 .
```

On Docker Desktop with the [containerd image store](https://docs.docker.com/desktop/use-desktop/kubernetes/), these locally built images are available to the cluster without pushing them to a registry. For a standalone kind cluster, explicitly load the four images with `kind load docker-image IMAGE... --name YOUR_CLUSTER`. For later code changes, use a fresh tag and update the manifests rather than relying on cached mutable tags.

```bash
kubectl --context docker-desktop get storageclass
kubectl --context docker-desktop apply -f k8s/config.yaml
kubectl --context docker-desktop apply -f k8s/
kubectl --context docker-desktop rollout status statefulset/cosmos -n stockroom --timeout=300s
kubectl --context docker-desktop wait --for=condition=Available \
  deployment/catalog deployment/inventory deployment/gateway deployment/frontend \
  -n stockroom --timeout=300s
kubectl --context docker-desktop port-forward -n stockroom \
  service/frontend --address 127.0.0.1 18080:8080
```

Open **http://127.0.0.1:18080**. This does not conflict with the Compose frontend on `8080`. Kubernetes starts with its **own database**: Compose data is not imported, shared, or deleted.

To inspect the Kubernetes database in Data Explorer, first stop Compose **without deleting its volume**, then forward both emulator ports in another terminal:

```bash
docker compose down
kubectl --context docker-desktop port-forward -n stockroom \
  service/cosmos --address 127.0.0.1 8081:8081 1234:1234
```

Open **http://127.0.0.1:1234**. Data Explorer's default API endpoint uses port `8081`; forwarding Explorer alone while the Compose API is running could show the wrong database.

Replacing the Cosmos pod retains its database through the PVC. **Deleting `data-cosmos-0`, deleting the `stockroom` namespace, or resetting the local cluster can erase Kubernetes data.** Keep the emulator at one replica; additional emulator replicas would have independent databases, not shared or replicated state.

## Run everything locally

From this repository's root:

```bash
# If you use nvm:
nvm install
nvm use

npm ci
docker compose up -d --wait cosmos
npm run dev
```

Open **http://127.0.0.1:5173**. The database starts empty on first use; add a product in the form. An already-running standalone emulator at `127.0.0.1:8081` also works: skip the Compose emulator command in that case.

`npm run dev` starts all three backend services and the frontend together. Press `Ctrl+C` to stop them. The launcher stops the other processes if any process exits.

### Run projects separately

Run each command in its own terminal, from the repository root:

```bash
npm run dev:catalog
npm run dev:inventory
npm run dev:gateway
npm run dev:frontend
```

| Project | Address | Responsibility |
| --- | --- | --- |
| React frontend | http://127.0.0.1:5173 | Product forms, inventory table, search, quantity updates |
| API gateway | http://127.0.0.1:4000 | Public API, validation, joining products and stock, coordinating create/delete |
| Catalog service | http://127.0.0.1:4001 | Product metadata and unique SKUs in Cosmos container `products` |
| Inventory service | http://127.0.0.1:4002 | Quantities keyed by product ID in Cosmos container `inventory` |

```text
Browser -> React/Vite or Nginx -> API gateway -> Catalog   -> Cosmos: stockroom/products
                                            -> Inventory -> Cosmos: stockroom/inventory
```

The frontend calls `/api` on its own origin. Vite or Nginx proxies these requests to the gateway; no browser-to-data-service calls or CORS configuration are needed.

## Persistence and service boundaries

The data services own **separate Cosmos containers in one database**. The gateway and frontend own no database. There is no in-memory storage fallback. Local services create the database and their own containers on startup; a missing/unreachable emulator fails startup explicitly.

Restarting a service, including backend watch mode, no longer erases data. A missing inventory record remains an explicit error, not zero or an automatic recreation. Old process-local data is not imported automatically.

Catalog documents use UUID `id`, constant `catalogId: "catalog"`, partition key `/catalogId`, and unique-key policy `/sku`. The single partition makes normalized SKU uniqueness atomic across catalog replicas. Metadata updates and deletes use Cosmos ETags to reject stale writes with `409`. This small-learning-catalog design has Cosmos's 20 GB logical-partition limit; a larger catalog needs a redesigned uniqueness/partition strategy.

Inventory documents use matching UUID `id`/`productId` and partition key `/productId`. Cosmos metadata and internal partition/id fields are removed from HTTP responses; existing API contracts are unchanged.

An existing container with an incompatible partition or unique-key policy is rejected without deleting data. These policies cannot be changed in place: migrate the records into compatible containers or use a fresh database via `COSMOS_DATABASE`.

Use the gateway for normal product operations. Direct data-service APIs are internal learning/debugging interfaces; direct writes can bypass lifecycle coordination and create inconsistent records.

The gateway serializes operations within **one gateway process** and compensates known failures: failed stock creation removes the new catalog product; failed catalog deletion restores stock. This is **not a distributed transaction**. Timeouts, process crashes, failed cleanup, direct writes, or multiple gateway instances can leave partial/orphaned data. Errors are returned to the UI and logged; after an ambiguous write failure, refresh and reconcile affected records. Restarting services does not repair persistent inconsistencies. Do not blindly repeat a failed write.

Quantity updates **set an absolute quantity**, rather than incrementing it. Multiple clients are last-write-wins. There is no authentication, authorization, reservation logic, or durable audit trail. The services bind to loopback by default and are intended only for trusted local learning, not production.

Persistence alone does not solve cross-service consistency: add idempotency, durable compensation/event delivery, and access control before scaling.

## Configuration

Defaults work with `npm run dev` when the local emulator is running.

| Variable | Applies to | Default |
| --- | --- | --- |
| `PORT` | Each backend process individually | `4001` catalog, `4002` inventory, `4000` gateway |
| `HOST` | Backend services | `127.0.0.1` |
| `CATALOG_URL` | Gateway | `http://127.0.0.1:4001` |
| `INVENTORY_URL` | Gateway | `http://127.0.0.1:4002` |
| `GATEWAY_URL` | Vite dev/preview proxy | `http://127.0.0.1:4000` |
| `COSMOS_ENDPOINT` | Catalog and inventory | `http://127.0.0.1:8081` on host; `http://cosmos:8081` in Compose |
| `COSMOS_DATABASE` | Catalog and inventory | `stockroom` |
| `COSMOS_KEY` | Catalog and inventory | Local emulator-only placeholder; required for Azure HTTPS endpoints |

Pass variables in the command's environment; `.env` files are **not** automatically loaded by backend scripts.

Both data services must target the same account/database. The emulator's key placeholder is not an Azure credential; the emulator ignores authentication. Endpoint discovery is disabled for local emulator endpoints so container clients are not redirected to `localhost`. HTTPS verification remains enabled for Azure.

For a future Azure account, provision the database and the two containers with the policies above separately, then provide its HTTPS endpoint and account key through runtime secret configuration. Application startup only reads/verifies Azure containers; it does not create cloud resources. Do not commit real keys. Shared database throughput and an opted-in Cosmos free-tier account can minimize cost; this change does not provision Azure infrastructure.

The raw `k8s/` manifests provide the cluster-local emulator configuration above. The Helm charts are not updated by this change: before using the new images with Helm, configure a reachable `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, the appropriate credential, and `/ready` probes (`/health` remains liveness). `localhost` in a pod is not the host emulator.

For example, to move the catalog to another port, use separate terminals:

```bash
PORT=4101 npm run dev:catalog
npm run dev:inventory
CATALOG_URL=http://127.0.0.1:4101 npm run dev:gateway
npm run dev:frontend
```

Do not set a shared `PORT` when running `npm run dev`, because all backends would try to use it. Frontend ports are fixed and fail explicitly if occupied.

## API examples

All write requests use `Content-Type: application/json`. The gateway returns JSON errors with an `error` message and, for validation failures, `details`. Success responses include metadata, `quantity`, and `stockUpdatedAt`; deletion returns `204` with no body.

```bash
# Create a product; copy the returned id for the later commands.
curl -i http://127.0.0.1:4000/api/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Notebook","sku":"NOTE-001","description":"A5 lined","quantity":12}'

# List products with their quantities.
curl http://127.0.0.1:4000/api/products

# Replace PRODUCT_ID below with the returned UUID.
curl -X PUT http://127.0.0.1:4000/api/products/PRODUCT_ID \
  -H 'Content-Type: application/json' \
  -d '{"name":"Updated notebook","sku":"NOTE-001","description":"A5 plain"}'

curl -X PUT http://127.0.0.1:4000/api/products/PRODUCT_ID/quantity \
  -H 'Content-Type: application/json' \
  -d '{"quantity":20}'

curl -i -X DELETE http://127.0.0.1:4000/api/products/PRODUCT_ID
```

| Method | Gateway path | Purpose |
| --- | --- | --- |
| `GET` | `/api/products` | List joined product and stock records |
| `POST` | `/api/products` | Create metadata and opening quantity |
| `PUT` | `/api/products/:id` | Replace name, SKU, and description |
| `PUT` | `/api/products/:id/quantity` | Set quantity |
| `DELETE` | `/api/products/:id` | Remove product and stock |
| `GET` | `/health` | Gateway process health |
| `GET` | `/ready` | Gateway plus downstream service and Cosmos readiness |

Every backend has `/health` and `/ready`. Catalog internal routes are `GET/POST /products` and `GET/PUT/DELETE /products/:id`. Inventory internal routes are `GET /inventory` and `GET/PUT/DELETE /inventory/:id`; its `PUT` is an upsert used by the gateway.

## Build and check

```bash
npm run typecheck
# Start Cosmos first (skip this if your standalone emulator is already running).
docker compose up -d --wait cosmos
npm test
npm run build
```

Tests use the real local emulator and HTTP listeners on ephemeral loopback ports. Each test creates/deletes only its own randomly named `stockroom-test-*` database, never the application database; Azure endpoints are rejected. They cover CRUD, validation, atomic SKU uniqueness across replicas, stale ETags, persisted data across client/service recreation, incompatible containers, dependency errors, and compensation. If your emulator API uses a different port, pass `COSMOS_ENDPOINT=http://127.0.0.1:PORT npm test`.

After building, run these in four terminals:

```bash
npm run start:catalog
npm run start:inventory
npm run start:gateway
npm run preview:frontend
```

Open **http://127.0.0.1:4173** for the built frontend preview. Vite preview is a local convenience server, not a production deployment server.

## Container vulnerability scanning

The `trivy` GitHub Actions workflow builds and scans catalog, inventory, gateway, and frontend images on pushes and pull requests to `main`. Each build uses its own Dockerfile with the repository root as the build context.

HIGH and CRITICAL findings are uploaded to GitHub code scanning in separate categories for each service. Scanning is report-only (`exit-code: '0'`): findings do not block the workflow, but build, scanner, and upload errors still fail it. No images are pushed to a registry.

Pull request scans check out and report against the PR head commit, not GitHub's temporary merge commit. Code-scanning rulesets can still block merging based on their configured alert thresholds, independently of whether the Actions workflow passes.

## Layout

```text
frontend/                  React UI and Vite config
services/catalog/src/      Product metadata service
services/inventory/src/    Stock quantity service
services/gateway/src/      Public API and service coordination
shared/                    Cosmos connection, HTTP helpers, contracts, schemas
tests/                     Cosmos-backed HTTP integration tests
docker-compose.yaml        Four applications plus persistent Cosmos emulator
helm/ and k8s/             Existing local Kubernetes deployment examples
```

One root dependency manifest and lockfile keep this learning monorepo simple. Each service has its own entry point, process, port, and store; they share contracts/helpers but do not import one another's implementation.

## Later phases

1. Add the equivalent Cosmos configuration to the Helm deployments.
2. Add an ArgoCD GitOps flow and provision AKS/supporting Azure resources through the separate resources repository.
3. Provision a cloud Cosmos account, replace development credentials with production identity/access controls, and add durable cross-service consistency.
