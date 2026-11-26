# Learning Kubernetes: Stockroom

A React stock-management app backed by **three independently running Node.js/TypeScript services**. This first phase runs directly on your machine: no Dockerfiles, containers, Kubernetes manifests, Helm, Terraform, or cloud resources.

Create products, edit names/SKUs/descriptions, set quantities, search inventory, and delete products with their stock records. SKUs are unique, case-insensitive, and normalized to uppercase. Quantities must be non-negative safe integers.

## Requirements

- Node.js **22.12 or later** and npm.
- Optional: [nvm](https://github.com/nvm-sh/nvm) to select the version in `.nvmrc`.
- Four available ports: `5173`, `4000`, `4001`, and `4002`.

## Run everything locally

From this repository's root:

```bash
# If you use nvm:
nvm install
nvm use

npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The catalog starts empty; add a product in the form.

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
| Catalog service | http://127.0.0.1:4001 | Product metadata, unique SKUs, its own in-memory store |
| Inventory service | http://127.0.0.1:4002 | Quantities keyed by product ID, its own in-memory store |

```text
Browser -> React/Vite -> API gateway -> Catalog service   -> product Map
                                    -> Inventory service -> stock Map
```

The frontend calls `/api` on its own origin. Vite proxies these requests to the gateway; no browser-to-data-service calls or CORS configuration are needed.

## In-memory data and service boundaries

The two data services have **separate process-local `Map` stores**, not a shared database or an external database server. Nothing is persisted to disk. Each service owns its data; the gateway owns no database.

**Restarting a data service erases only its store.** Stop and restart *all* services together for a clean reset. Backend watch mode also restarts a service when its source changes. A missing inventory record is reported as an error, not silently treated as zero. Restarting only the gateway or frontend does not erase data.

Use the gateway for normal product operations. Direct data-service APIs are internal learning/debugging interfaces; direct writes can bypass lifecycle coordination and create inconsistent records.

The gateway serializes operations within **one gateway process** and compensates known failures: failed stock creation removes the new catalog product; failed catalog deletion restores stock. This is **not a distributed transaction**. Timeouts, process crashes, failed cleanup, direct writes, or multiple gateway instances can leave partial/orphaned data. Errors are returned to the UI and logged; after an ambiguous write failure, refresh to check the result, or restart all services to reset memory. Do not blindly repeat a failed write.

Quantity updates **set an absolute quantity**, rather than incrementing it. Multiple clients are last-write-wins. There is no authentication, authorization, reservation logic, or durable audit trail. The services bind to loopback by default and are intended only for trusted local learning, not production.

When migrating to Cosmos DB, replace the catalog and inventory store operations with separate repositories/containers; keep their HTTP contracts. Persistence alone will not solve cross-service consistency: add idempotency, version/ETag-based updates, durable compensation/event delivery, and access control before scaling.

## Configuration

Environment variables are optional. Defaults work with `npm run dev`.

| Variable | Applies to | Default |
| --- | --- | --- |
| `PORT` | Each backend process individually | `4001` catalog, `4002` inventory, `4000` gateway |
| `HOST` | Backend services | `127.0.0.1` |
| `CATALOG_URL` | Gateway | `http://127.0.0.1:4001` |
| `INVENTORY_URL` | Gateway | `http://127.0.0.1:4002` |
| `GATEWAY_URL` | Vite dev/preview proxy | `http://127.0.0.1:4000` |

Pass variables in the command's environment; `.env` files are **not** automatically loaded by backend scripts.

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
| `GET` | `/ready` | Gateway plus downstream service health |

Every backend has `/health`. Catalog internal routes are `GET/POST /products` and `GET/PUT/DELETE /products/:id`. Inventory internal routes are `GET /inventory` and `GET/PUT/DELETE /inventory/:id`; its `PUT` is an upsert used by the gateway.

## Build and check

```bash
npm run typecheck
npm test
npm run build
```

Tests start real HTTP listeners on ephemeral loopback ports. They cover the CRUD lifecycle, validation, unique SKUs, concurrent mutations, dependency errors, and compensating operations.

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
shared/                    HTTP helpers, contracts, validation schemas
tests/                     Service integration tests
```

One root dependency manifest and lockfile keep this learning monorepo simple. Each service has its own entry point, process, port, and store; they share contracts/helpers but do not import one another's implementation.

## Later phases (not implemented)

1. Add per-project Docker builds and Docker Compose.
2. Run locally on Kubernetes and package deployments with Helm.
3. Push to GitHub and add an ArgoCD GitOps flow.
4. Provision AKS and supporting Azure resources with Terraform.
5. Migrate process-local stores to Cosmos DB with durable consistency and security controls.

This repository is initialized locally only. No GitHub repository, remote, push, or Azure resources have been created.
