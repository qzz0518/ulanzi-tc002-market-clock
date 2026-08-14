/**
 * Reads generic passwords out of the macOS login keychain.
 *
 * Claude Code, Copilot and friends store their OAuth blobs there rather than in
 * a file. We shell out to `/usr/bin/security` instead of binding the Security
 * framework: a spawn is a few milliseconds, it needs no native module, and — the
 * reason that decides it — a read the user already authorised for their own CLI
 * does not raise a second prompt.
 *
 * Exit code 44 is `errSecItemNotFound`, i.e. "nothing stored", which is a state
 * rather than a failure. Every other non-zero exit (locked keychain, denied
 * access) is a real error and is reported as one.
 *
 * READ ONLY, on purpose. `security add-generic-password -w` takes the value
 * through getpass(3), which silently truncates at 128 bytes and still exits 0 —
 * measured here: a 336-byte blob comes back 128 bytes long with no error. Every
 * credential blob we would ever write is longer than that, so a "successful"
 * write would replace the user's real login with a fragment and lock them out
 * of their own CLI. Passing the blob as an argument instead would put a live
 * OAuth token in `ps` output for every process on the machine. Neither is worth
 * it for a pixel clock: adapters that cannot write a rotated token back simply
 * do not spend one (see the refresh guards in claude.ts / codex.ts).
 */

import type { KeychainReader } from "./types.ts";

const SECURITY_BINARY = "/usr/bin/security";
const NOT_FOUND_EXIT = 44;
const TIMEOUT_MS = 5_000;

export class SecurityKeychain implements KeychainReader {
  private readonly currentUser: string | undefined;

  constructor(currentUser = process.env.USER?.trim() || undefined) {
    this.currentUser = currentUser;
  }

  async read(service: string, account?: string): Promise<string | null> {
    // `security` writes items either with an account or without one depending on
    // which CLI version created them, and the account-scoped item wins when both
    // exist. Try the specific shape first, then the bare one.
    const accounts = account !== undefined
      ? [account]
      : this.currentUser !== undefined ? [this.currentUser, undefined] : [undefined];
    for (const candidate of accounts) {
      const value = await this.runSecurity(service, candidate);
      if (value !== null) return value;
    }
    return null;
  }

  private async runSecurity(service: string, account: string | undefined): Promise<string | null> {
    const args = ["find-generic-password"];
    if (account !== undefined) args.push("-a", account);
    args.push("-s", service, "-w");

    const child = Bun.spawn([SECURITY_BINARY, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    try {
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (exitCode === NOT_FOUND_EXIT) return null;
      if (exitCode !== 0) {
        const stderr = (await new Response(child.stderr).text()).trim();
        throw new Error(`keychain read failed for ${service} (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`);
      }
      const value = stdout.trim();
      return value === "" ? null : value;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A keychain that never has anything — the seam tests and Linux hosts use. */
export class EmptyKeychain implements KeychainReader {
  async read(): Promise<string | null> {
    return null;
  }

}
