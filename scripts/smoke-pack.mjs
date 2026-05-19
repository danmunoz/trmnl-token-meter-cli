import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binName = process.platform === "win32" ? "trmnl-token-meter.cmd" : "trmnl-token-meter";

async function main() {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  });
  const packResult = JSON.parse(stdout);
  const tarball = packResult[0]?.filename;
  if (typeof tarball !== "string" || !tarball.endsWith(".tgz")) {
    throw new Error("npm pack did not return a tarball filename");
  }

  const sandbox = await mkdtemp(join(tmpdir(), "trmnl-pack-smoke-"));
  try {
    await writeFile(join(sandbox, "package.json"), '{"name":"pack-smoke","private":true}\n');
    await execFileAsync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(repoRoot, tarball)],
      { cwd: sandbox }
    );
    const { stdout: version } = await execFileAsync(
      join(sandbox, "node_modules", ".bin", binName),
      ["--version"],
      { cwd: sandbox }
    );
    const cliVersion = version.trim();
    if (!cliVersion) {
      throw new Error("packed CLI did not print a version");
    }

    const installedPackage = JSON.parse(
      await readFile(join(sandbox, "node_modules", "trmnl-token-meter", "package.json"), "utf8")
    );
    if (cliVersion !== installedPackage.version) {
      throw new Error(
        `packed CLI version mismatch: CLI reported ${cliVersion}, package.json reported ${String(installedPackage.version)}`
      );
    }
  } finally {
    await rm(join(repoRoot, tarball), { force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
