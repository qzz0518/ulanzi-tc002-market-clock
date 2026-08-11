/**
 * Reapplies the device's real file modes to a tree pulled with `adb pull`.
 *
 * adb pull carries contents and nothing else: /res is 0770 on the device and
 * arrives as 0644/0755 locally. That matters because the tree is about to be
 * packed into a restore image, and a "restore" that silently changes every
 * permission on the partition is not one — it is a different filesystem that
 * happens to hold the same bytes.
 *
 * The input is plain `ls -laR` output, because this device's busybox has no
 * stat(1) and no find -printf.
 *
 * Usage: bun run restore-modes.ts <ls-laR.txt> <treeDir>
 */
import { chmod, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const [listingPath, treeArg] = process.argv.slice(2);
if (!listingPath || !treeArg) {
  console.error("usage: restore-modes.ts <ls-laR.txt> <treeDir>");
  process.exit(1);
}
const tree = resolve(treeArg);

/** "drwxrwx---" → 0o770. No setuid/sticky appears anywhere in this tree. */
function symbolicToMode(symbolic: string): number {
  let mode = 0;
  for (let i = 0; i < 9; i += 1) {
    if (symbolic[i + 1] !== "-") mode |= 1 << (8 - i);
  }
  return mode;
}

const listing = await Bun.file(listingPath).text();
const entry = /^([d-][rwx-]{9})\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+[\d:]+\s+(.+)$/;
let directory: string | null = null;
let applied = 0;
let missing = 0;

for (const line of listing.split("\n")) {
  const text = line.replace(/\r$/, "");
  if (text.startsWith("/res") && text.endsWith(":")) {
    directory = text.slice(0, -1);
    continue;
  }
  const match = entry.exec(text);
  if (!match || directory === null) continue;
  const [, symbolic, name] = match;
  if (name === "." || name === "..") continue;
  const target = join(tree, relative("/res", join(directory, name!)));
  try {
    await stat(target);
  } catch {
    missing += 1;
    continue;
  }
  await chmod(target, symbolicToMode(symbolic!));
  applied += 1;
}

// The root of the tree is listed as "." inside its own block, which the loop
// skips along with every other ".", so it is set explicitly.
await chmod(tree, 0o770);

console.log(`restored modes on ${applied} entries (${missing} listed but not pulled)`);
if (applied === 0) {
  console.error("no modes were applied — is the listing really `ls -laR /res` output?");
  process.exit(1);
}
