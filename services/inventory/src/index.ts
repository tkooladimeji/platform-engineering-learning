import { listen } from "../../../shared/http.js";
import { createInventoryApp } from "./app.js";

listen(createInventoryApp(), "inventory", 4002);
