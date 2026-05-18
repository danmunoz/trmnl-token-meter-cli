import { join } from "node:path";
import type { CollectorConfig } from "../config.js";
import type { JsonlSourceResult } from "./jsonl.js";
import { readJsonlUsageSource } from "./jsonl.js";

export const readPiSessionSource = async (config: CollectorConfig): Promise<JsonlSourceResult> => {
  if (!config.includePiSessions) {
    return {
      records: [],
      warnings: [],
      status: { kind: "pi_sessions", enabled: false, status: "disabled" }
    };
  }

  return readJsonlUsageSource(
    join(config.piSessionsHome, "agent", "sessions"),
    "pi_sessions",
    "pi_sessions_missing",
    "pi_sessions_malformed"
  );
};
