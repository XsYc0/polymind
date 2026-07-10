import { buildApp } from "./app.js";
import { loadConfig } from "@polymind/config";

const config = await loadConfig();
const { app } = await buildApp(config);

await app.listen({ host: config.server.host, port: config.server.port });
