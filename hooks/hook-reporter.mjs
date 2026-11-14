import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || resolve(__dirname, "..");
const RUNTIME_DIR = process.env.ASM_RUNTIME_DIR || join(PLUGIN_ROOT, ".runtime");
const SERVER_INFO_PATH = join(RUNTIME_DIR, "server.json");
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

function writeFallbackState(record) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(FALLBACK_STATE_PATH, JSON.stringify(record, null, 2), "utf8");
  } catch {
  }
}

function clearFallbackState() {
  try {
    if (existsSync(FALLBACK_STATE_PATH)) {
      unlinkSync(FALLBACK_STATE_PATH);
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

  const record = {
    eventName,
    receivedAt: Date.now(),
    payload: {
      conversationId: payload.conversationId || null,
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
    if (existsSync(SERVER_INFO_PATH)) {
      const info = JSON.parse(readFileSync(SERVER_INFO_PATH, "utf8"));
      if (info?.port) {
        sent = await postToSidecar(Number(info.port), record, info.hookToken || "");
      }
    }
  } catch {
    sent = false;
  }

  if (sent) {
    clearFallbackState();
  } else {
    writeFallbackState(record);
  }

  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
});
