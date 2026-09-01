import type { TokenUsage, UsageEvent } from "./types.js";

// Counter state machine adapted from CodexBar's MIT-licensed local-cost scanner.
// Pinned source: https://github.com/steipete/CodexBar/blob/5351013a211f90df83b91d7ec2b788ff1c35c1f3/Sources/CodexBarCore/Vendored/CostUsage/CostUsageScanner.swift
const SEEN_TOTALS_LIMIT = 64;

const zeroTotals = (): TokenUsage => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0
});

const totalsFromEvent = (event: UsageEvent): TokenUsage => ({
  input_tokens: event.input_tokens,
  cached_input_tokens: event.cached_input_tokens,
  output_tokens: event.output_tokens
});

const addTotals = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input_tokens: left.input_tokens + right.input_tokens,
  cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
  output_tokens: left.output_tokens + right.output_tokens
});

const subtractTotals = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input_tokens: Math.max(0, left.input_tokens - right.input_tokens),
  cached_input_tokens: Math.max(0, left.cached_input_tokens - right.cached_input_tokens),
  output_tokens: Math.max(0, left.output_tokens - right.output_tokens)
});

const minTotals = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input_tokens: Math.min(left.input_tokens, right.input_tokens),
  cached_input_tokens: Math.min(left.cached_input_tokens, right.cached_input_tokens),
  output_tokens: Math.min(left.output_tokens, right.output_tokens)
});

const maxTotals = (left: TokenUsage | undefined, right: TokenUsage): TokenUsage => ({
  input_tokens: Math.max(left?.input_tokens ?? 0, right.input_tokens),
  cached_input_tokens: Math.max(left?.cached_input_tokens ?? 0, right.cached_input_tokens),
  output_tokens: Math.max(left?.output_tokens ?? 0, right.output_tokens)
});

const totalsEqual = (left: TokenUsage | undefined, right: TokenUsage | undefined): boolean =>
  left?.input_tokens === right?.input_tokens &&
  left?.cached_input_tokens === right?.cached_input_tokens &&
  left?.output_tokens === right?.output_tokens;

const totalsAtLeast = (left: TokenUsage, right: TokenUsage): boolean =>
  left.input_tokens >= right.input_tokens &&
  left.cached_input_tokens >= right.cached_input_tokens &&
  left.output_tokens >= right.output_tokens;

const totalsAtMost = (left: TokenUsage, right: TokenUsage): boolean =>
  left.input_tokens <= right.input_tokens &&
  left.cached_input_tokens <= right.cached_input_tokens &&
  left.output_tokens <= right.output_tokens;

const totalTokens = (totals: TokenUsage): number =>
  totals.input_tokens + totals.cached_input_tokens + totals.output_tokens;

const looksLikeStaleRegression = (
  current: TokenUsage,
  previous: TokenUsage,
  last: TokenUsage
): boolean => {
  if (totalsAtLeast(current, previous)) return false;
  const previousTotal = totalTokens(previous);
  const currentTotal = totalTokens(current);
  const lastTotal = totalTokens(last);
  if (previousTotal === 0 || currentTotal === 0 || lastTotal === 0) return false;
  return currentTotal * 100 >= previousTotal * 98 || currentTotal + lastTotal * 2 >= previousTotal;
};

const divergentTotalDelta = (
  rawBaseline: TokenUsage | undefined,
  countedBaseline: TokenUsage | undefined,
  current: TokenUsage
): TokenUsage => {
  const raw = rawBaseline ?? zeroTotals();
  const counted = countedBaseline ?? zeroTotals();
  const component = (rawValue: number, countedValue: number, currentValue: number): number =>
    currentValue >= rawValue
      ? Math.max(0, currentValue - rawValue)
      : Math.max(0, currentValue - countedValue);
  return {
    input_tokens: component(raw.input_tokens, counted.input_tokens, current.input_tokens),
    cached_input_tokens: component(
      raw.cached_input_tokens,
      counted.cached_input_tokens,
      current.cached_input_tokens
    ),
    output_tokens: component(raw.output_tokens, counted.output_tokens, current.output_tokens)
  };
};

const containedTotalDelta = (
  watermark: TokenUsage | undefined,
  countedBaseline: TokenUsage | undefined,
  current: TokenUsage
): TokenUsage => {
  const water = watermark ?? zeroTotals();
  const counted = countedBaseline ?? zeroTotals();
  const component = (waterValue: number, countedValue: number, currentValue: number): number =>
    currentValue >= waterValue
      ? Math.max(0, currentValue - Math.max(waterValue, countedValue))
      : Math.max(0, currentValue - countedValue);
  return {
    input_tokens: component(water.input_tokens, counted.input_tokens, current.input_tokens),
    cached_input_tokens: component(
      water.cached_input_tokens,
      counted.cached_input_tokens,
      current.cached_input_tokens
    ),
    output_tokens: component(water.output_tokens, counted.output_tokens, current.output_tokens)
  };
};

interface CounterState {
  countedTotals?: TokenUsage;
  rawTotalsBaseline?: TokenUsage;
  watermark?: TokenUsage;
  seenRawTotals: TokenUsage[];
  sawDivergentTotals: boolean;
  sawInterleavedTotals: boolean;
}

const initialState = (): CounterState => ({
  seenRawTotals: [],
  sawDivergentTotals: false,
  sawInterleavedTotals: false
});

const rememberTotal = (state: CounterState, totals: TokenUsage): void => {
  state.watermark = maxTotals(state.watermark, totals);
  if (state.seenRawTotals.some((seen) => totalsEqual(seen, totals))) return;
  state.seenRawTotals.push(totals);
  if (state.seenRawTotals.length > SEEN_TOTALS_LIMIT) {
    state.seenRawTotals.splice(0, state.seenRawTotals.length - SEEN_TOTALS_LIMIT);
  }
};

const commitDelta = (state: CounterState, delta: TokenUsage, rawTotal: TokenUsage): void => {
  state.countedTotals = addTotals(state.countedTotals ?? zeroTotals(), delta);
  state.rawTotalsBaseline = rawTotal;
  if (!totalsEqual(state.rawTotalsBaseline, state.countedTotals)) {
    state.sawDivergentTotals = true;
  }
};

const deltaEvent = (event: UsageEvent, delta: TokenUsage): UsageEvent => {
  const output: UsageEvent = { ...event, ...delta, record_kind: "delta" };
  delete output.cumulative_usage;
  return output;
};

export class CodexCounterLedger {
  private readonly states = new Map<string, CounterState>();

  apply(event: UsageEvent, key: string): UsageEvent | undefined {
    const state = this.states.get(key) ?? initialState();
    this.states.set(key, state);
    const eventTotals = totalsFromEvent(event);
    const cumulative =
      event.cumulative_usage ?? (event.record_kind === "cumulative" ? eventTotals : undefined);

    if (!cumulative) {
      state.countedTotals = addTotals(state.countedTotals ?? zeroTotals(), eventTotals);
      state.rawTotalsBaseline = state.countedTotals;
      state.watermark = maxTotals(state.watermark, state.countedTotals);
      return deltaEvent(event, eventTotals);
    }

    if (state.seenRawTotals.some((seen) => totalsEqual(seen, cumulative))) return undefined;

    const last = event.record_kind === "delta" ? eventTotals : undefined;
    const staleBaseline = state.watermark ?? state.rawTotalsBaseline;
    if (
      staleBaseline &&
      looksLikeStaleRegression(cumulative, staleBaseline, last ?? zeroTotals())
    ) {
      return undefined;
    }

    if (state.watermark && !totalsAtLeast(cumulative, state.watermark)) {
      state.sawInterleavedTotals = true;
    }
    const watermarkBaseline = state.watermark ?? state.rawTotalsBaseline;
    let delta: TokenUsage;

    if (last) {
      if (state.sawInterleavedTotals) {
        delta = minTotals(
          last,
          containedTotalDelta(watermarkBaseline, state.countedTotals, cumulative)
        );
      } else {
        const totalDelta = subtractTotals(cumulative, watermarkBaseline ?? zeroTotals());
        const shouldPreferTotalDelta =
          !state.sawDivergentTotals &&
          watermarkBaseline !== undefined &&
          totalsAtLeast(cumulative, watermarkBaseline) &&
          totalsAtMost(totalDelta, last);
        delta = shouldPreferTotalDelta ? totalDelta : last;
      }
    } else if (state.sawInterleavedTotals) {
      delta = containedTotalDelta(watermarkBaseline, state.countedTotals, cumulative);
    } else if (state.sawDivergentTotals) {
      delta = divergentTotalDelta(watermarkBaseline, state.countedTotals, cumulative);
    } else {
      delta = subtractTotals(cumulative, watermarkBaseline ?? zeroTotals());
    }

    commitDelta(state, delta, cumulative);
    rememberTotal(state, cumulative);
    return deltaEvent(event, delta);
  }
}
