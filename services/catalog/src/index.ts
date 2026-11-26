import { listen } from "../../../shared/http.js";
import { createCatalogApp } from "./app.js";

listen(createCatalogApp(), "catalog", 4001);
