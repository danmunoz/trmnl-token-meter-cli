import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectorConfig } from "../config.js";

// Claude Code transcript roots, ported from CodexBar 0.84.0
// (`ClaudeConfigPaths.costProjectsRoots` and `ClaudeDesktopProjectsLocator`).
// Attribution: CodexBar, MIT license.

const desktopSessionDirectories = ["local-agent-mode-sessions", "claude-code-sessions"];
const desktopSkippedDirectories = new Set([
  ".build",
  ".git",
  "build",
  "DerivedData",
  "node_modules",
  "outputs",
  "target"
]);
const desktopMaxDepth = 4;

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const childDirectories = async (path: string): Promise<string[]> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => !desktopSkippedDirectories.has(name))
      .sort()
      .map((name) => join(path, name));
  } catch {
    return [];
  }
};

/**
 * Claude Desktop (Cowork and Code sessions) keeps per-session Claude homes and a
 * Cowork `audit.jsonl` under Application Support. Breadth-first to depth 4,
 * never following symlinked directories.
 */
async function desktopRoots(home: string): Promise<string[]> {
  const base = join(home, "Library", "Application Support", "Claude");
  const queue = desktopSessionDirectories.map((name) => ({ path: join(base, name), depth: 0 }));
  const visited = new Set(queue.map((item) => item.path));
  const roots: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const projects = join(current.path, ".claude", "projects");
    if (await isDirectory(projects)) roots.push(projects);

    const audit = join(current.path, "audit.jsonl");
    try {
      const info = await lstat(audit);
      if (info.isFile()) roots.push(audit);
    } catch {
      // No audit log in this directory.
    }

    if (current.depth >= desktopMaxDepth) continue;
    for (const child of await childDirectories(current.path)) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push({ path: child, depth: current.depth + 1 });
    }
  }
  return roots;
}

/** claude-swap keeps one Claude home per numbered profile slot (`<N>-<name>`). */
async function claudeSwapRoots(home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const sessionRoots = [join(home, ".claude-swap-backup", "sessions")];
  if (process.platform === "linux") {
    const xdg = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share");
    sessionRoots.push(join(xdg, "claude-swap", "sessions"));
  }
  const roots: string[] = [];
  for (const sessions of sessionRoots) {
    let slots: string[];
    try {
      slots = (await readdir(sessions)).filter((name) => !name.startsWith(".")).sort();
    } catch {
      continue;
    }
    for (const slot of slots) {
      const dash = slot.indexOf("-");
      if (dash < 0) continue;
      const number = slot.slice(0, dash);
      if (!/^\d+$/.test(number) || Number(number) <= 0) continue;
      const projects = join(sessions, slot, "projects");
      if (await isDirectory(projects)) roots.push(projects);
    }
  }
  return roots;
}

const dedupeBySymlinkTarget = async (roots: string[]): Promise<string[]> => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const root of roots) {
    let identity = root;
    try {
      identity = await realpath(root);
    } catch {
      // Missing roots keep their literal path.
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(root);
  }
  return output;
};

/**
 * Every Claude transcript root to scan. A root is either a directory searched for
 * `.jsonl` files or a single `.jsonl` file (Cowork `audit.jsonl`).
 *
 * A configured `CLAUDE_CONFIG_DIR` (or collector override) is authoritative and
 * replaces every default root. CodexBar still adds claude-swap profiles in that
 * case; this collector does not, so an explicit root never pulls in another home.
 */
export async function claudeProjectRoots(
  config: CollectorConfig,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<string[]> {
  if (config.claudeProjectsRoots?.length) return dedupeBySymlinkTarget([...config.claudeProjectsRoots]);
  return dedupeBySymlinkTarget([
    join(home, ".config", "claude", "projects"),
    join(home, ".claude", "projects"),
    ...(await desktopRoots(home)),
    ...(await claudeSwapRoots(home, env))
  ]);
}
