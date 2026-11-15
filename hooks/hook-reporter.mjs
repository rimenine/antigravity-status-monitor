import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHookScopeKey,
  doesFallbackRecordMatchScope,
  readRegisteredServers,
  selectTargetServers,
} from "../sidecars/status-monitor/lib/runtime-paths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || resolve(__dirname, "..");
const RUNTIME_DIR = process.env.ASM_RUNTIME_DIR || join(PLUGIN_ROOT, ".runtime");
const SERVER_INFO_PATH = join(RUNTIME_DIR, "server.json");
const SERVERS_DIR = join(RUNTIME_DIR, "servers");
const HOOKS_DIR = join(RUNTIME_DIR, "hooks");
const FALLBACK_STATE_PATH = join(RUNTIME_DIR, "hook-state.json");

const eventName = process.argv[2] || "Unknown";

function readStdinSafe(timeoutMs = 200) {
  return new Promise((resolveInput) => {
    if (process.stdin.isTTY) {
      resolveInput("");
      return;
    }
    let raw = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveInput(raw);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    process.stdin.resume();
  });
}

const TIMEOUT_MS = Math.max(200, Number(process.env.HOOK_TIMEOUT_MS) || 1200);

function postToSidecar(port, body, hookToken = "") {
  return new Promise((resolvePost) => {
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (hookToken) {
      headers["X-Hook-Token"] = hookToken;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePost(ok);
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/hook",
        method: "POST",
        headers,
        agent: false,
      },
      (res) => {
        res.resume();
        finish(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(false);
    }, TIMEOUT_MS);
    req.on("error", () => finish(false));
    req.end(data);
  });
}

function writeFallbackState(record, scope) {
  try {
    mkdirSync(HOOKS_DIR, { recursive: true });
    const targetPath = join(HOOKS_DIR, `${buildHookScopeKey(scope)}.json`);
    writeFileSync(targetPath, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
  }
}

function clearFallbackState(scope) {
  try {
    const targetPath = join(HOOKS_DIR, `${buildHookScopeKey(scope)}.json`);
    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
    }
  } catch {
  }
  try {
    if (existsSync(FALLBACK_STATE_PATH)) {
      const existing = JSON.parse(readFileSync(FALLBACK_STATE_PATH, "utf8"));
      if (doesFallbackRecordMatchScope(existing, scope)) {
        unlinkSync(FALLBACK_STATE_PATH);
      }
    }
  } catch {
  }
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdinSafe();
    if (raw.trim()) {
      payload = JSON.parse(raw);
    }
  } catch {
    payload = {};
  }

  const conversationId = payload.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  const lsAddress = payload.lsAddress || process.env.ANTIGRAVITY_LS_ADDRESS || null;
  const scope = { conversationId, lsAddress };

  const record = {
    eventName,
    receivedAt: Date.now(),
    lsAddress,
    payload: {
      conversationId,
      stepIdx: payload.stepIdx ?? null,
      invocationNum: payload.invocationNum ?? null,
      modelName: payload.modelName || null,
      toolName: payload.toolCall?.name || null,
      terminationReason: payload.terminationReason || null,
      error: payload.error || null,
      transcriptPath: payload.transcriptPath || null,
      fullyIdle: payload.fullyIdle ?? null,
    },
  };

  let sent = false;
  try {
    const candidates = readRegisteredServers({
      serverInfoPath: SERVER_INFO_PATH,
      serversDir: SERVERS_DIR,
      pruneDead: true,
    });
    const targets = selectTargetServers(candidates, scope);
    if (targets.length > 0) {
      const results = await Promise.all(
        targets.map((info) => postToSidecar(Number(info.port), record, info.hookToken || "")),
      );
      sent = results.some(Boolean);
    }
  } catch {
    sent = false;
  }

  if (sent) {
    clearFallbackState(scope);
  } else {
    writeFallbackState(record, scope);
  }

  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
});
