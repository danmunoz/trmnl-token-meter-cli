import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexHomeExists, type CollectorConfig } from "./config.js";
import {
  mergeTokenUsageContext,
  normalizeTokenUsageRecord,
  type TokenUsageContext
} from "./token-usage.js";
import type { CollectorWarning, UsageEvent } from "./types.js";
import { warning } from "./warnings.js";

export interface CodexReadResult {
  events: UsageEvent[];
  warnings: CollectorWarning[];
  filesRead: number;
}

async function discoverJsonlFiles(dir: string, output: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await discoverJsonlFiles(path, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(path);
    }
  }
  return output;
}

export async function discoverCodexJsonlFiles(config: CollectorConfig): Promise<string[]> {
  if (!codexHomeExists(config)) return [];
  return discoverJsonlFiles(config.codexHome);
}

export async function readCodexUsage(config: CollectorConfig): Promise<CodexReadResult> {
  if (!codexHomeExists(config)) {
    return { events: [], filesRead: 0, warnings: [warning("codex_sessions_missing")] };
  }

  const files = await discoverCodexJsonlFiles(config);
  const events: UsageEvent[] = [];
  let malformed = 0;

  for (const file of files) {
    if (!(await stat(file)).isFile()) continue;
    const context: TokenUsageContext = {};
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const result = normalizeTokenUsageRecord(JSON.parse(line), context);
        if (result.context) {
          mergeTokenUsageContext(context, result.context);
        }
        if (result.event) events.push(result.event);
        if (result.malformed) malformed += 1;
      } catch {
        malformed += 1;
      }
    }
  }

  const warnings: CollectorWarning[] = [];
  if (malformed > 0) warnings.push(warning("malformed_records_skipped", malformed));
  return { events, filesRead: files.length, warnings };
}
