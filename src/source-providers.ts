import type { LocalUsageSourceKind, LocalUsageSourceStatus, SourceProvider } from "./types.js";

export const SUPPORTED_PROVIDERS: SourceProvider[] = ["codex", "opencode", "claude"];

export const providerLabels: Record<SourceProvider, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude"
};

export const providerSourceKinds: Record<SourceProvider, LocalUsageSourceKind[]> = {
  codex: ["codex_sessions", "codex_archived_sessions", "codex_priority_sqlite"],
  opencode: ["opencode_sqlite"],
  claude: ["claude_projects"]
};

const splitProviderValues = (value: string | readonly unknown[] | undefined): string[] => {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.toLowerCase());
  }

  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    return item
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.toLowerCase());
  });
};

export function parseProviders(value: string | readonly unknown[] | undefined, fallback: SourceProvider[]): SourceProvider[] {
  const parsed = Array.from(
    new Set(
      splitProviderValues(value)
        .filter((part): part is SourceProvider => SUPPORTED_PROVIDERS.includes(part as SourceProvider))
    )
  );

  return parsed.length > 0 ? parsed : [...fallback];
}

export function disabledSourceStatus(kind: LocalUsageSourceKind): LocalUsageSourceStatus {
  return {
    kind,
    enabled: false,
    status: "disabled"
  };
}
