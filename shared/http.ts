import express, { type ErrorRequestHandler, type Express, type Request } from "express";
import { z, ZodError } from "zod";
export { productInput, quantityInput, createProductInput } from "./schemas.js";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function productId(request: Request): string {
  return z.uuid().parse(request.params.id);
}

export function createApp(service: string): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.get("/health", (_request, response) => {
    response.json({ service, status: "ok" });
  });
  return app;
}

export function finishApp(app: Express): Express {
  app.use((_request, response) => {
    response.status(404).json({ error: "Route not found" });
  });
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "Invalid input",
        details: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      });
      return;
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) console.error(error);
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Request body must be valid JSON" });
      return;
    }
    if (error instanceof Error && "type" in error && error.type === "entity.too.large") {
      response.status(413).json({ error: "Request body exceeds 32kb" });
      return;
    }
    console.error(error);
    response.status(500).json({ error: "Unexpected server error" });
  };
  app.use(handleError);
  return app;
}

export function listen(app: Express, service: string, defaultPort: number, dispose?: () => void): void {
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? defaultPort);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`${service} listening at http://${host}:${port}`);
  });
  server.on("error", (error) => {
    console.error(`${service} failed to start`, error);
    dispose?.();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close((error) => {
        dispose?.();
        if (error) console.error(`${service} shutdown failed`, error);
        process.exit(error ? 1 : 0);
      });
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}
