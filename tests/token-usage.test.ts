import { describe, expect, it } from "vitest";
import {
  mergeTokenUsageContext,
  normalizeTokenUsageRecord,
  type TokenUsageContext
} from "../src/token-usage.js";

describe("Codex token usage normalization", () => {
  it("uses the largest cached-token counter without clamping it to input tokens", () => {
    const result = normalizeTokenUsageRecord({
      timestamp: "2026-09-01T12:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 30,
            cached_input_tokens: 20,
            cache_read_input_tokens: 40,
            output_tokens: 5
          }
        }
      }
    });

    expect(result).toMatchObject({
      malformed: false,
      event: {
        input_tokens: 30,
        cached_input_tokens: 40,
        output_tokens: 5
      }
    });
  });

  it("recognizes legacy nested subagent source metadata", () => {
    const result = normalizeTokenUsageRecord({
      type: "session_meta",
      payload: { id: "child", source: { subagent: { kind: "review" } } }
    });

    expect(result.context).toEqual({
      sessionId: "child",
      sessionIdentity: "independent_subagent",
      parentId: "",
      forkTimestamp: ""
    });
  });

  it("clears stale model context when a turn explicitly supplies a blank model", () => {
    const context: TokenUsageContext = { currentModel: "gpt-5" };
    const update = normalizeTokenUsageRecord({
      type: "turn_context",
      payload: { model: "" }
    });
    if (update.context) mergeTokenUsageContext(context, update.context);

    const result = normalizeTokenUsageRecord(
      {
        timestamp: "2026-09-01T12:00:00.000Z",
        token_usage: { input_tokens: 1 }
      },
      context
    );

    expect(result.event?.model).toBe("unknown");
  });
});
