/**
 * Compiles src/vibe-agent.ts to a single self-contained binary.
 *
 * Separate from scripts/build.ts because this artefact does not belong to the
 * service bundle: it is copied to whichever machine holds the agent CLI logins
 * and run there (ADR 0012). Cross-compiling is supported so the person running
 * the console on a Mac can hand a colleague — or their own Linux box — a binary
 * without installing Bun over there.
 *
 *   bun run scripts/build-agent.ts                      # this machine
 *   bun run scripts/build-agent.ts --target linux-x64   # cross-compile
 *   bun run scripts/build-agent.ts --all                # every supported target
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
] as const;
type Target = typeof TARGETS[number];

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist", "agent");

function parse(argv: readonly string[]): { targets: (Target | "host")[] } {
  if (argv.includes("--all")) return { targets: [...TARGETS] };
  const index = argv.indexOf("--target");
  if (index === -1) return { targets: ["host"] };
  const value = argv[index + 1];
  if (value === undefined || !TARGETS.includes(value as Target)) {
    throw new Error(`--target must be one of: ${TARGETS.join(", ")}`);
  }
  return { targets: [value as Target] };
}

const { targets } = parse(process.argv.slice(2));
await mkdir(outdir, { recursive: true });

for (const target of targets) {
  // Naming: the host build is just `vibe-agent`, because that is what the setup
  // guide tells people to run. Cross builds carry their target so a folder of
  // them stays legible.
  const suffix = target === "host" ? "" : `-${target}`;
  const extension = target.startsWith("windows") ? ".exe" : "";
  const outfile = join(outdir, `vibe-agent${suffix}${extension}`);
  const args = [
    "bun", "build", "--compile", join(root, "src/vibe-agent.ts"),
    "--outfile", outfile,
  ];
  if (target !== "host") args.push("--target", `bun-${target}`);

  const result = Bun.spawnSync(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`failed to compile vibe-agent for ${target}`);
  console.log(`built ${outfile}`);
}
