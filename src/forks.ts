import type { UsageEvent } from "./types.js";
import { warning } from "./warnings.js";

export interface ForkLedgerResult {
  events: UsageEvent[];
  ambiguousForkCount: number;
}

function keyFor(event: UsageEvent): string {
  return [event.session_id, event.branch_id ?? "main"].join(":");
}

export function applyForkLedger(events: UsageEvent[]): ForkLedgerResult {
  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const previousByKey = new Map<string, UsageEvent>();
  const output: UsageEvent[] = [];
  let ambiguousForkCount = 0;

  for (const event of sorted) {
    if (event.branch_id && !event.parent_id) ambiguousForkCount += 1;
    if (event.record_kind === "delta") {
      output.push(event);
      continue;
    }

    const key = keyFor(event);
    const previous = previousByKey.get(key);
    previousByKey.set(key, event);
    if (!previous) {
      output.push(event);
      continue;
    }

    const inputDelta = event.input_tokens - previous.input_tokens;
    const cachedDelta = event.cached_input_tokens - previous.cached_input_tokens;
    const outputDelta = event.output_tokens - previous.output_tokens;
    if (inputDelta < 0 || cachedDelta < 0 || outputDelta < 0) {
      ambiguousForkCount += 1;
      output.push(event);
      continue;
    }

    output.push({
      ...event,
      input_tokens: inputDelta,
      cached_input_tokens: Math.min(cachedDelta, inputDelta),
      output_tokens: outputDelta
    });
  }

  return { events: output, ambiguousForkCount };
}

export function forkWarnings(count: number) {
  return count > 0 ? [warning("malformed_records_skipped", count)] : [];
}
