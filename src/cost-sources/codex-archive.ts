import { join } from "node:path";
import type { CollectorConfig } from "../config.js";
import { readJsonlUsageSource } from "./jsonl.js";

export const readCodexArchiveSource = (config: CollectorConfig) =>
  readJsonlUsageSource(
    join(config.codexHome, "archived_sessions"),
    "codex_archived_sessions",
    "codex_archived_sessions_missing"
  );
