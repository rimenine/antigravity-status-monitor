import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");

const TOP_LEVEL_FILES = [
  "plugin.json",
  "hooks.json",
  "package.json",
  "README.md",
  "README.en.md",
  "LICENSE",
  "install.sh",
  "uninstall.sh",
  "install.ps1",
  "uninstall.ps1",
];

const TOP_LEVEL_DIRS = ["assets", "hooks", "sidecars", "skills"];

const EXCLUDED_NAMES = new Set([".runtime", "node_modules", ".git", ".DS_Store", "Thumbs.db", "desktop.ini"]);
const EXECUTABLE_FILES = new Set(["install.sh", "uninstall.sh"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime =
    ((date.getUTCHours() & 0x1f) << 11) |
    ((date.getUTCMinutes() & 0x3f) << 5) |
    ((date.getUTCSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getUTCMonth() + 1) & 0x0f) << 5) |
    (date.getUTCDate() & 0x1f);
  return { dosTime, dosDate };
}

function writeOctal(buf, offset, length, value) {
  const digits = length - 1;
  const str = Math.max(0, Math.floor(value)).toString(8).padStart(digits, "0").slice(-digits);
  buf.write(str, offset, digits, "ascii");
  buf[offset + digits] = 0;
}

function splitTarPath(fullPath) {
  if (Buffer.byteLength(fullPath, "utf8") <= 100) {
    return { name: fullPath, prefix: "" };
  }
  const parts = fullPath.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Archive path too long for POSIX USTAR: ${fullPath}`);
}

function createTarHeader(entryPath, size, isDir, mode, mtimeSec) {
  const { name, prefix } = splitTarPath(entryPath);
  const hdr = Buffer.alloc(512, 0);
  hdr.write(name, 0, Math.min(100, Buffer.byteLength(name, "utf8")), "utf8");
  writeOctal(hdr, 100, 8, mode);
  writeOctal(hdr, 108, 8, 0);
  writeOctal(hdr, 116, 8, 0);
  writeOctal(hdr, 124, 12, isDir ? 0 : size);
  writeOctal(hdr, 136, 12, mtimeSec);
  hdr.fill(0x20, 148, 156);
  hdr.write(isDir ? "5" : "0", 156, 1, "ascii");
  hdr.write("ustar", 257, 5, "ascii");
  hdr[262] = 0;
  hdr.write("00", 263, 2, "ascii");
  if (prefix) {
    hdr.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix, "utf8")), "utf8");
  }
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += hdr[i];
  const sumStr = sum.toString(8).padStart(6, "0");
  hdr.write(sumStr, 148, 6, "ascii");
  hdr[154] = 0;
  hdr[155] = 0x20;
  return hdr;
}

export function buildTarGzBuffer(entries, mtimeDate = new Date("2026-01-01T00:00:00Z")) {
  const mtimeSec = Math.floor(mtimeDate.getTime() / 1000);
  const chunks = [];
  for (const entry of entries) {
    const isDir = entry.type === "dir";
    const tarName = isDir ? `${entry.archivePath.replace(/\/+$/, "")}/` : entry.archivePath;
    const body = isDir ? Buffer.alloc(0) : entry.data;
    chunks.push(createTarHeader(tarName, body.length, isDir, entry.mode, mtimeSec));
    if (!isDir && body.length > 0) {
      chunks.push(body);
      const rem = body.length % 512;
      if (rem !== 0) {
        chunks.push(Buffer.alloc(512 - rem, 0));
      }
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function buildZipBuffer(entries, mtimeDate = new Date("2026-01-01T00:00:00Z")) {
  const { dosTime, dosDate } = toDosDateTime(mtimeDate);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.type === "dir";
    const nameStr = isDir ? `${entry.archivePath.replace(/\/+$/, "")}/` : entry.archivePath;
    const nameBuf = Buffer.from(nameStr, "utf8");
    const rawData = isDir ? Buffer.alloc(0) : entry.data;
    const crc = isDir ? 0 : crc32(rawData);

    let compMethod = 0;
    let payload = rawData;
    if (!isDir && rawData.length > 0) {
      const deflated = deflateRawSync(rawData, { level: 9 });
      if (deflated.length < rawData.length) {
        compMethod = 8;
        payload = deflated;
      }
    }

    const localHdr = Buffer.alloc(30 + nameBuf.length);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(compMethod, 8);
    localHdr.writeUInt16LE(dosTime, 10);
    localHdr.writeUInt16LE(dosDate, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(payload.length, 18);
    localHdr.writeUInt32LE(rawData.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);
    nameBuf.copy(localHdr, 30);

    localChunks.push(localHdr, payload);

    const posixAttr = (isDir ? 0o040000 | entry.mode : 0o100000 | entry.mode) & 0xffff;
    const dosAttr = isDir ? 0x10 : 0x00;
    const extAttr = ((posixAttr << 16) | dosAttr) >>> 0;

    const centralHdr = Buffer.alloc(46 + nameBuf.length);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE((3 << 8) | 20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(compMethod, 10);
    centralHdr.writeUInt16LE(dosTime, 12);
    centralHdr.writeUInt16LE(dosDate, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(payload.length, 20);
    centralHdr.writeUInt32LE(rawData.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(extAttr, 38);
    centralHdr.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHdr, 46);

    centralChunks.push(centralHdr);
    offset += localHdr.length + payload.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function shouldSkipName(name) {
  return EXCLUDED_NAMES.has(name) || name.endsWith(".log") || name.endsWith(".tmp");
}

function walkPluginDir(absDir, relArchivePrefix, entries) {
  entries.push({ type: "dir", archivePath: relArchivePrefix, mode: 0o755 });
  const items = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    if (shouldSkipName(item.name)) continue;
    const absPath = join(absDir, item.name);
    const nextArchivePath = `${relArchivePrefix}/${item.name}`;
    if (item.isDirectory()) {
      walkPluginDir(absPath, nextArchivePath, entries);
    } else if (item.isFile()) {
      entries.push({
        type: "file",
        archivePath: nextArchivePath,
        mode: item.name.endsWith(".sh") ? 0o755 : 0o644,
        data: readFileSync(absPath),
      });
    }
  }
}

export function collectPluginEntries(repoRoot = REPO_ROOT, rootFolderName = "agent-status-monitor") {
  const entries = [{ type: "dir", archivePath: rootFolderName, mode: 0o755 }];

  for (const file of [...TOP_LEVEL_FILES].sort((a, b) => a.localeCompare(b))) {
    const absPath = join(repoRoot, file);
    if (!existsSync(absPath) || !statSync(absPath).isFile()) continue;
    entries.push({
      type: "file",
      archivePath: `${rootFolderName}/${file}`,
      mode: EXECUTABLE_FILES.has(file) ? 0o755 : 0o644,
      data: readFileSync(absPath),
    });
  }

  for (const dir of [...TOP_LEVEL_DIRS].sort((a, b) => a.localeCompare(b))) {
    const absDir = join(repoRoot, dir);
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) continue;
    walkPluginDir(absDir, `${rootFolderName}/${dir}`, entries);
  }

  return entries;
}

export function normalizeReleaseTag(tagInput, fallbackVersion) {
  const raw = String(tagInput || "").trim();
  if (!raw) return `v${fallbackVersion}`;
  return /^v/i.test(raw) ? raw : `v${raw}`;
}

export function packageRelease({
  repoRoot = REPO_ROOT,
  outDir = join(REPO_ROOT, "dist"),
  tag = "",
  mtimeDate = new Date("2026-01-01T00:00:00Z"),
} = {}) {
  const pluginJson = JSON.parse(readFileSync(join(repoRoot, "plugin.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (pluginJson.version !== packageJson.version) {
    throw new Error(
      `Version mismatch between plugin.json (${pluginJson.version}) and package.json (${packageJson.version})`,
    );
  }

  const resolvedTag = normalizeReleaseTag(tag, pluginJson.version);
  if (!/^[A-Za-z0-9._-]+$/.test(resolvedTag)) {
    throw new Error(`Invalid release tag format: ${resolvedTag}`);
  }

  const pluginId = String(pluginJson.name || "agent-status-monitor");
  const resolvedOut = resolve(outDir);
  rmSync(resolvedOut, { recursive: true, force: true });
  mkdirSync(resolvedOut, { recursive: true });

  const entries = collectPluginEntries(repoRoot, pluginId);
  const zipBuf = buildZipBuffer(entries, mtimeDate);
  const tgzBuf = buildTarGzBuffer(entries, mtimeDate);

  const versionedZip = `${pluginId}-${resolvedTag}.zip`;
  const versionedTgz = `${pluginId}-${resolvedTag}.tar.gz`;
  const latestZip = `${pluginId}.zip`;
  const latestTgz = `${pluginId}.tar.gz`;

  writeFileSync(join(resolvedOut, versionedZip), zipBuf);
  writeFileSync(join(resolvedOut, versionedTgz), tgzBuf);
  copyFileSync(join(resolvedOut, versionedZip), join(resolvedOut, latestZip));
  copyFileSync(join(resolvedOut, versionedTgz), join(resolvedOut, latestTgz));

  const files = [versionedZip, versionedTgz, latestZip, latestTgz];
  const checksumLines = files.map((fileName) => {
    const digest = createHash("sha256").update(readFileSync(join(resolvedOut, fileName))).digest("hex");
    return `${digest}  ${fileName}`;
  });
  const checksumPath = join(resolvedOut, "SHA256SUMS.txt");
  writeFileSync(checksumPath, `${checksumLines.join("\n")}\n`, "utf8");

  return {
    outDir: resolvedOut,
    tag: resolvedTag,
    version: pluginJson.version,
    pluginId,
    files: [...files, "SHA256SUMS.txt"],
    entryCount: entries.length,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      opts.outDir = argv[++i];
    } else if (arg.startsWith("--out=")) {
      opts.outDir = arg.slice(6);
    } else if (arg === "--tag" && argv[i + 1]) {
      opts.tag = argv[++i];
    } else if (arg.startsWith("--tag=")) {
      opts.tag = arg.slice(6);
    }
  }
  return opts;
}

function isSameModulePath(a, b) {
  if (!a || !b) return false;
  const pa = resolve(a);
  const pb = resolve(b);
  return process.platform === "win32" ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

if (isSameModulePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const result = packageRelease(parseCliArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
