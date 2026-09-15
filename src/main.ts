#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { rulecheck } from "./cli.ts";
import { layerGh } from "./github/gh.ts";

const program = Command.run(rulecheck, { version: pkg.version });

BunRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, layerGh()))));
