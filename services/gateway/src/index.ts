import { z } from "zod";
import { listen } from "../../../shared/http.js";
import { createGatewayApp } from "./app.js";

const catalogUrl = z.url().parse(process.env.CATALOG_URL ?? "http://127.0.0.1:4001");
const inventoryUrl = z.url().parse(process.env.INVENTORY_URL ?? "http://127.0.0.1:4002");

listen(createGatewayApp({ catalogUrl, inventoryUrl }), "gateway", 4000);
