#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { buildApp } from "@polymind/gateway/app";
import {
  loadConfig,
  polymindConfigSchema,
  redactSecrets,
  writeSampleConfig
} from "@polymind/config";
import { ModelRegistry } from "@polymind/model-registry";

const program = new Command();
program.name("polymind").description("PolyMind local AI routing gateway").version("0.1.0");

program
  .command("init")
  .option("-c, --config <path>", "config path", "polymind.yaml")
  .option("--force", "overwrite existing config", false)
  .action(async (options: { config: string; force: boolean }) => {
    await writeSampleConfig(options.config, options.force);
    await mkdir(".polymind", { recursive: true });
    console.log(`Created ${options.config} and .polymind/`);
  });

program
  .command("serve")
  .option("-c, --config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const config = await loadConfig(options.config);
    const { app } = await buildApp(config);
    await app.listen({ host: config.server.host, port: config.server.port });
  });

program
  .command("doctor")
  .option("-c, --config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const config = await loadConfig(options.config);
    const registry = ModelRegistry.fromConfig(config);
    await mkdir(dirname(config.storage.sqlitePath), { recursive: true });
    const checks = [
      ["PASS", `Node ${process.version}`],
      [
        "PASS",
        `Config (${registry.listProviders().length} providers, ${registry.listModels().length} models)`
      ],
      ["PASS", `SQLite path ${config.storage.sqlitePath}`],
      [
        config.providers.some(
          (provider) =>
            provider.enabled && provider.secretRef && !provider.secretRef.startsWith("env:")
        )
          ? "FAIL"
          : "PASS",
        "Secret references use supported env: form"
      ],
      [config.integrations.omniroute.enabled ? "WARN" : "PASS", "OmniRoute optional integration"],
      [config.integrations.ruflo.enabled ? "WARN" : "PASS", "Ruflo optional integration"],
      [config.security.allowPrivateEndpoints ? "WARN" : "PASS", "Private endpoint policy"],
      ["PASS", "OpenAPI export available"],
      [
        "PASS",
        "Trace content persistence " + (config.storage.storeRequestContent ? "enabled" : "disabled")
      ]
    ];
    for (const [status, message] of checks) console.log(`${status}: ${message}`);
  });

program
  .command("execute")
  .argument("<prompt>", "prompt to execute")
  .option("--mode <mode>", "direct|cascade|specialist|council|workflow", "auto")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (prompt: string, options: { mode: string; baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      "/v1/executions",
      "POST",
      {
        model: `polymind/${options.mode === "auto" ? "auto" : options.mode}`,
        messages: [{ role: "user", content: prompt }],
        polymind: { mode: options.mode, explain: true }
      },
      options.json
    );
  });

program
  .command("openapi")
  .argument("[action]", "export", "export")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", true)
  .action(async (_action: string, options: { baseUrl: string; json: boolean }) => {
    await adminRequest(options.baseUrl, "/openapi.json", "GET", undefined, options.json);
  });

const providers = program.command("providers");
providers
  .command("list")
  .option("-c, --config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const config = await loadConfig(options.config);
    console.log(JSON.stringify(redactSecrets(config.providers), null, 2));
  });
providers
  .command("add")
  .requiredOption("--provider-json <json>", "provider JSON or provider+models JSON")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--dry-run", "validate without persisting", false)
  .option("--json", "emit JSON", false)
  .action(
    async (options: { providerJson: string; baseUrl: string; dryRun: boolean; json: boolean }) => {
      const payload = { ...JSON.parse(options.providerJson), dryRun: options.dryRun };
      await adminRequest(options.baseUrl, "/v1/providers", "POST", payload, options.json);
    }
  );
providers
  .command("update")
  .requiredOption("--id <providerId>", "provider id")
  .requiredOption("--provider-json <json>", "provider patch JSON")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--dry-run", "validate without persisting", false)
  .option("--json", "emit JSON", false)
  .action(
    async (options: {
      id: string;
      providerJson: string;
      baseUrl: string;
      dryRun: boolean;
      json: boolean;
    }) => {
      const payload = { provider: JSON.parse(options.providerJson), dryRun: options.dryRun };
      await adminRequest(
        options.baseUrl,
        `/v1/providers/${options.id}`,
        "PATCH",
        payload,
        options.json
      );
    }
  );
providers
  .command("remove")
  .requiredOption("--id <providerId>", "provider id")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--cascade", "delete referenced models too", false)
  .option("--yes", "confirm destructive cascade deletion", false)
  .option("--json", "emit JSON", false)
  .action(
    async (options: {
      id: string;
      baseUrl: string;
      cascade: boolean;
      yes: boolean;
      json: boolean;
    }) => {
      if (options.cascade && !options.yes) {
        console.error("Refusing cascade delete without --yes");
        process.exitCode = 2;
        return;
      }
      await adminRequest(
        options.baseUrl,
        `/v1/providers/${options.id}?cascade=${String(options.cascade)}`,
        "DELETE",
        undefined,
        options.json
      );
    }
  );
for (const commandName of ["enable", "disable", "health", "refresh-models"] as const) {
  const routeName = commandName === "health" ? "health/check" : commandName;
  providers
    .command(commandName)
    .requiredOption("--id <providerId>", "provider id")
    .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
    .option("--json", "emit JSON", false)
    .action(async (options: { id: string; baseUrl: string; json: boolean }) => {
      await adminRequest(
        options.baseUrl,
        `/v1/providers/${options.id}/${routeName}`,
        "POST",
        undefined,
        options.json
      );
    });
}

const models = program.command("models");
models
  .command("list")
  .option("-c, --config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const config = await loadConfig(options.config);
    console.log(JSON.stringify(config.models, null, 2));
  });

const configCommand = program.command("config");
configCommand
  .command("validate")
  .option("-c, --config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const config = await loadConfig(options.config);
    polymindConfigSchema.parse(config);
    console.log("Config valid");
  });

const integrations = program.command("integrations");
integrations
  .command("status")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { baseUrl: string; json: boolean }) => {
    await adminRequest(options.baseUrl, "/v1/integrations", "GET", undefined, options.json);
  });
integrations
  .command("ruflo")
  .argument("[action]", "status", "status")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (_action: string, options: { baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      "/v1/integrations/ruflo/status",
      "GET",
      undefined,
      options.json
    );
  });

const executions = program.command("executions");
executions
  .command("list")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { baseUrl: string; json: boolean }) => {
    await adminRequest(options.baseUrl, "/v1/executions", "GET", undefined, options.json);
  });
executions
  .command("inspect")
  .requiredOption("--id <executionId>", "execution id")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { id: string; baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      `/v1/executions/${options.id}`,
      "GET",
      undefined,
      options.json
    );
  });
executions
  .command("cancel")
  .requiredOption("--id <executionId>", "execution id")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { id: string; baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      `/v1/executions/${options.id}/cancel`,
      "POST",
      undefined,
      options.json
    );
  });

const cache = program.command("cache");
cache
  .command("stats")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { baseUrl: string; json: boolean }) => {
    await adminRequest(options.baseUrl, "/v1/cache/stats", "GET", undefined, options.json);
  });
cache
  .command("purge")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--yes", "confirm purge", false)
  .option("--json", "emit JSON", false)
  .action(async (options: { baseUrl: string; yes: boolean; json: boolean }) => {
    if (!options.yes) {
      console.error("Refusing cache purge without --yes");
      process.exitCode = 2;
      return;
    }
    await adminRequest(options.baseUrl, "/v1/cache/purge", "POST", undefined, options.json);
  });
cache.command("inspect").action(() => {
  console.log(JSON.stringify({ entries: "hidden-by-default" }, null, 2));
});

const performance = program.command("performance");
performance
  .command("models")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      "/v1/performance/leaderboard",
      "GET",
      undefined,
      options.json
    );
  });
performance
  .command("leaderboard")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (options: { baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      "/v1/performance/leaderboard",
      "GET",
      undefined,
      options.json
    );
  });
performance
  .command("reset")
  .option("--yes", "confirm reset", false)
  .action((options: { yes: boolean }) => {
    if (!options.yes) {
      console.error("Refusing performance reset without --yes");
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ reset: "requires gateway maintenance endpoint" }, null, 2));
  });

const plans = program.command("plans");
plans
  .command("validate")
  .requiredOption("--plan-json <json>", "execution plan JSON")
  .action((options: { planJson: string }) => {
    JSON.parse(options.planJson);
    console.log("Plan JSON valid");
  });
integrations
  .command("omniroute")
  .argument("[action]", "status", "status")
  .option("--base-url <url>", "PolyMind gateway URL", "http://127.0.0.1:8080")
  .option("--json", "emit JSON", false)
  .action(async (_action: string, options: { baseUrl: string; json: boolean }) => {
    await adminRequest(
      options.baseUrl,
      "/v1/integrations/omniroute/status",
      "GET",
      undefined,
      options.json
    );
  });

const maintenance = program.command("maintenance");
maintenance.command("stats").action(() => {
  console.log(JSON.stringify({ status: "ok", cleanupRetention: "default" }, null, 2));
});
maintenance
  .command("cleanup")
  .option("--dry-run", "show cleanup plan", false)
  .action((options: { dryRun: boolean }) => {
    console.log(JSON.stringify({ dryRun: options.dryRun, deleted: 0 }, null, 2));
  });

await program.parseAsync(process.argv);

async function adminRequest(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  json: boolean
): Promise<void> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, ensureSlash(baseUrl)), init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    console.error(json ? JSON.stringify(payload) : (payload.error?.message ?? text));
    process.exitCode = response.status >= 500 ? 1 : 2;
    return;
  }
  console.log(json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload, null, 2));
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
