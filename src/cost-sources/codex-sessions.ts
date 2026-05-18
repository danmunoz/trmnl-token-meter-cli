import { join } from "node:path";
import type { CollectorConfig } from "../config.js";
import { readJsonlUsageSource } from "./jsonl.js";

export const readCodexSessionSource = (config: CollectorConfig) =>
  readJsonlUsageSource(
    join(config.codexHome, "sessions"),
    "codex_sessions",
    "codex_sessions_missing"
  );
