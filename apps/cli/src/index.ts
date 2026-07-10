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
    console.log(`Node: ${process.version}`);
    console.log(
      `Config: ok (${registry.listProviders().length} providers, ${registry.listModels().length} models)`
    );
    console.log(`SQLite path: ${config.storage.sqlitePath}`);
    console.log(
      `Trace content persistence: ${config.storage.storeRequestContent ? "enabled" : "disabled"}`
    );
  });

const providers = program.command("providers");
providers
  .command("list")
  .option("-c, --config <path>", "config path")
  .action(async (options: { config?: string }) => {
    const config = await loadConfig(options.config);
    console.log(JSON.stringify(redactSecrets(config.providers), null, 2));
  });

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

await program.parseAsync(process.argv);
