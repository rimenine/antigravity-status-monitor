import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(__dirname, "..");

export async function withTempDir(fn, prefix = "asm-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeJsonl(filePath, records) {
  mkdirSync(dirname(filePath), { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf8");
}

export function localNoonIso(dateObj = new Date()) {
  const d = new Date(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate(),
    12,
    0,
    0,
    0,
  );
  return { ts: d.getTime(), iso: d.toISOString() };
}
