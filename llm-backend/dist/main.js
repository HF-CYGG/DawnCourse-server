import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { log } from "./log.js";
import { ensureSigningKeyPair } from "./runtimeConfig.js";
import { registerAdminRoutes } from "./admin.js";
import { registerCollectorRoutes } from "./collector.js";
import { registerRegistryRoutes, seedBundledScripts } from "./registry.js";
async function bootstrap() {
    await migrate();
    ensureSigningKeyPair();
    await seedBundledScripts();
    const app = Fastify({
        logger: false,
        bodyLimit: config.maxContentLength + 1024 * 64
    });
    await app.register(cors, { origin: true });
    app.get("/health", async () => ({ ok: true, service: "llm-backend", version: "2.0.0" }));
    await registerRegistryRoutes(app);
    await registerCollectorRoutes(app);
    await registerAdminRoutes(app);
    app.setErrorHandler(async (error, request, reply) => {
        log.error("request failed", { url: request.url, error: error.message });
        return reply.code(500).send({ code: 500, msg: error.message || "server_error", data: null });
    });
    await app.listen({ host: "0.0.0.0", port: config.port });
    log.info(`llm-backend listening on ${config.port}`);
}
bootstrap().catch((error) => {
    log.error("fatal startup error", { error: error instanceof Error ? error.stack || error.message : String(error) });
    process.exit(1);
});
