import { describe, expect, test } from "bun:test";
import {
  generateIngestToken,
  vibeAgentCommands,
  vibeAutostartCommands,
  vibeDisableIngestCommand,
  vibePushUrl,
  vibeServiceCommand,
  vibeUninstallCommand,
  VIBE_AGENT_HOSTS,
  VIBE_SERVICE_KINDS,
  type VibeCommand,
  type VibeSetupInput,
} from "../web/src/lib/vibe-remote-setup.ts";
import { VIBE_INGEST_PATH } from "../src/vibe/ingest-schema.ts";
import { parseAgentArgs } from "../src/vibe-agent.ts";

const INPUT: VibeSetupInput = {
  origin: "http://192.168.1.20:43820",
  path: VIBE_INGEST_PATH,
  token: "a".repeat(64),
};

function everyCommand(input = INPUT): VibeCommand[] {
  const commands: VibeCommand[] = [];
  for (const kind of VIBE_SERVICE_KINDS) {
    commands.push(vibeServiceCommand(kind.id, input), vibeDisableIngestCommand(kind.id));
  }
  for (const host of VIBE_AGENT_HOSTS) {
    commands.push(
      ...vibeAgentCommands(host.id, input),
      ...vibeAutostartCommands(host.id, input),
      vibeUninstallCommand(host.id),
    );
  }
  return commands;
}

describe("vibePushUrl", () => {
  test("joins origin and path with exactly one slash", () => {
    expect(vibePushUrl({ origin: "http://host:43820", path: "/v1/push" }))
      .toBe("http://host:43820/v1/push");
    expect(vibePushUrl({ origin: "http://host:43820/", path: "/v1/push" }))
      .toBe("http://host:43820/v1/push");
    expect(vibePushUrl({ origin: "http://host:43820", path: "v1/push" }))
      .toBe("http://host:43820/v1/push");
  });
});

describe("generateIngestToken", () => {
  test("is 64 hex characters", () => {
    expect(generateIngestToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("pads a low byte rather than dropping a character", () => {
    expect(generateIngestToken((bytes) => bytes.fill(1))).toBe("01".repeat(32));
  });

  test("two calls differ", () => {
    expect(generateIngestToken()).not.toBe(generateIngestToken());
  });
});

// The dialog asks two questions and shows one path. Each answer must resolve to
// a short, complete instruction — not another fork for the reader to resolve.
describe("the two choices each yield one short path", () => {
  test("choosing how the service runs gives exactly one command", () => {
    for (const kind of VIBE_SERVICE_KINDS) {
      const command = vibeServiceCommand(kind.id, INPUT);
      expect(command.code.length).toBeGreaterThan(0);
      expect(command.code.split("\n").length).toBeLessThanOrEqual(5);
    }
  });

  test("the machine that has the logins gives at most two commands", () => {
    for (const host of VIBE_AGENT_HOSTS) {
      const commands = vibeAgentCommands(host.id, INPUT);
      expect(commands.length).toBeGreaterThanOrEqual(1);
      expect(commands.length).toBeLessThanOrEqual(2);
    }
  });

  // The common case — service in Docker on this Mac, logins on the same Mac —
  // must not ask anybody to compile or copy anything.
  test("«this computer» is a single command with no build step", () => {
    const commands = vibeAgentCommands("here", INPUT);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.code).toBe(
      `bun run agent -- --url http://192.168.1.20:43820/v1/push --token ${INPUT.token}`,
    );
    expect(commands[0]!.code).not.toContain("agent-build");
  });

  test("another machine gets a build and a run, in that order", () => {
    for (const host of ["macos", "linux", "windows"] as const) {
      const [build, run] = vibeAgentCommands(host, INPUT);
      expect(build!.code).toContain("agent-build");
      expect(run!.code).toContain("--url http://192.168.1.20:43820/v1/push");
      expect(run!.code).not.toContain("agent-build");
    }
  });
});

describe("the generated commands", () => {
  test("carry the reader's real values, never a placeholder", () => {
    const text = everyCommand().map((c) => `${c.code}\n${c.note ?? ""}\n${c.detail ?? ""}`).join("\n");
    expect(text).not.toContain("<先点上面的「生成」>");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("<url>");
  });

  test("stay obviously incomplete while no token exists", () => {
    const command = vibeServiceCommand("docker", { ...INPUT, token: "" });
    expect(command.code).toContain("<先点上面的「生成」>");
  });

  // A command the agent's own parser rejects is a typo nobody catches in review.
  test("the run commands parse as real agent arguments", () => {
    for (const host of VIBE_AGENT_HOSTS) {
      const commands = vibeAgentCommands(host.id, INPUT);
      const run = commands[commands.length - 1]!;
      const argv = run.code.replace("bun run agent -- ", "").split(" ");
      const parsed = parseAgentArgs(argv[0]!.includes("vibe-agent") ? argv.slice(1) : argv, {});
      expect(parsed).toMatchObject({
        url: "http://192.168.1.20:43820/v1/push",
        token: INPUT.token,
      });
    }
  });
});

describe("turning ingest on", () => {
  test("docker writes the variable where compose reads it", () => {
    const command = vibeServiceCommand("docker", INPUT);
    expect(command.code).toContain(`VIBE_INGEST_TOKEN=${INPUT.token}`);
    expect(command.code).toContain(".runtime/docker.env");
    expect(command.code).toContain("docker compose up -d");
  });

  // Add fails when the key exists AND when the parent dict does not, so the
  // create-delete-add trio is what makes this safe to paste twice.
  test("launchd edits the plist idempotently and restarts the service", () => {
    const command = vibeServiceCommand("launchd", INPUT);
    const lines = command.code.split("\n");
    expect(lines.some((l) => l.includes("Add :EnvironmentVariables dict"))).toBe(true);
    const deleteAt = lines.findIndex((l) => l.includes("Delete :EnvironmentVariables:VIBE_INGEST_TOKEN"));
    const addAt = lines.findIndex((l) => l.includes("Add :EnvironmentVariables:VIBE_INGEST_TOKEN string"));
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeGreaterThan(deleteAt);
    expect(command.code).toContain("launchctl kickstart -k");
    expect(command.code).toContain("com.zerah.ulanzi-market-clock");
  });

  test("the shell form only prefixes the variable", () => {
    expect(vibeServiceCommand("shell", INPUT).code)
      .toBe(`VIBE_INGEST_TOKEN=${INPUT.token} CLOCK_HOST=<你的时钟 IP> bun start`);
  });
});

describe("autostart", () => {
  test("launchd keeps the token out of ProgramArguments", () => {
    const plist = vibeAutostartCommands("macos", INPUT).find((c) => c.file?.endsWith(".plist"))!;
    expect(plist.code).toContain("<key>EnvironmentVariables</key>");
    // ps(1) shows every argument to every user on the machine.
    expect(plist.code.split("<key>EnvironmentVariables</key>")[0]!).not.toContain(INPUT.token);
  });

  test("launchd points its log where the guide says to look", () => {
    const commands = vibeAutostartCommands("macos", INPUT);
    const plist = commands.find((c) => c.file?.endsWith(".plist"))!;
    const load = commands.find((c) => c.code.includes("launchctl load"))!;
    const logPath = /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist.code)?.[1];
    expect(logPath).toBeDefined();
    expect(load.code).toContain(logPath!);
  });

  test("systemd passes the token by environment and restarts itself", () => {
    const unit = vibeAutostartCommands("linux", INPUT).find((c) => c.file?.endsWith(".service"))!;
    expect(unit.code).toContain(`Environment=VIBE_INGEST_TOKEN=${INPUT.token}`);
    expect(unit.code).toContain("Restart=always");
    expect(/ExecStart=(.+)/.exec(unit.code)?.[1] ?? "").not.toContain(INPUT.token);
  });

  test("linux is told to enable lingering, or it stops at logout", () => {
    expect(vibeAutostartCommands("linux", INPUT).some((c) => c.code.includes("loginctl enable-linger")))
      .toBe(true);
  });

  // The exe path has a space in it, so the inner quotes are load-bearing.
  test("the Windows task quotes the exe path and stays on one line", () => {
    const command = vibeAutostartCommands("windows", INPUT)[0]!;
    expect(command.code).toContain(`/tr '"C:\\Program Files\\vibe-agent\\vibe-agent-windows-x64.exe"`);
    expect(command.code.endsWith("'")).toBe(true);
    // cmd's `^` and PowerShell's backtick are different continuations.
    expect(command.code).not.toContain("\n");
    expect(command.code).not.toContain("^");
  });

  test("chmod comes before load on both unix platforms", () => {
    for (const host of ["macos", "linux"] as const) {
      const secured = vibeAutostartCommands(host, INPUT).find((c) => c.code.includes("chmod 600"))!;
      expect(secured.code).toMatch(/chmod 600[\s\S]*(launchctl load|systemctl --user enable)/);
    }
  });
});

describe("uninstall", () => {
  test("every platform can stop and remove its own autostart", () => {
    expect(vibeUninstallCommand("macos").code).toContain("launchctl unload");
    expect(vibeUninstallCommand("here").code).toContain("launchctl unload");
    expect(vibeUninstallCommand("linux").code).toContain("systemctl --user disable --now");
    expect(vibeUninstallCommand("windows").code).toContain("schtasks /delete");
  });

  test("what uninstall removes is what autostart installed", () => {
    for (const host of ["macos", "linux", "windows"] as const) {
      const installed = vibeAutostartCommands(host, INPUT);
      const removed = vibeUninstallCommand(host).code;
      if (host === "windows") {
        expect(removed).toContain("VIBE Agent");
        expect(installed[0]!.code).toContain("VIBE Agent");
      } else {
        const file = installed.find((c) => c.file)!.file!.replace("~", "");
        expect(removed).toContain(file.split("/").pop()!.replace(".service", ""));
      }
    }
  });

  test("turning ingest back off matches how it was turned on", () => {
    expect(vibeDisableIngestCommand("docker").code).toContain(".runtime/docker.env");
    expect(vibeDisableIngestCommand("docker").code).toContain("docker compose up -d");
    expect(vibeDisableIngestCommand("launchd").code)
      .toContain("Delete :EnvironmentVariables:VIBE_INGEST_TOKEN");
    expect(vibeDisableIngestCommand("launchd").code).toContain("launchctl kickstart -k");
    // Never leaves the secret behind in the command that is meant to remove it.
    for (const kind of VIBE_SERVICE_KINDS) {
      expect(vibeDisableIngestCommand(kind.id).code).not.toContain(INPUT.token);
    }
  });
});
