export const ABORTED_PLANNER_STATUSES = new Set([
  "ERROR",
  "CANCELLED",
  "CANCELED",
  "FAILED",
  "ABORTED",
  "STOPPED",
]);

export const TERMINAL_PLANNER_STATUSES = new Set(["DONE", ...ABORTED_PLANNER_STATUSES]);

export const TOOL_RESULT_STEP_TYPES = new Set([
  "GENERIC",
  "CODE_ACTION",
  "RUN_COMMAND",
  "VIEW_FILE",
  "SEARCH_WEB",
  "LIST_DIRECTORY",
  "GREP_SEARCH",
  "READ_URL_CONTENT",
]);

export const WAITING_LLM_STEP_TYPES = new Set([
  "USER_INPUT",
  ...TOOL_RESULT_STEP_TYPES,
  "SYSTEM_MESSAGE",
  "EPHEMERAL_MESSAGE",
  "CHECKPOINT",
  "CONVERSATION_HISTORY",
  "ERROR_MESSAGE",
]);

/** 解析 Transcript 中 ERROR_MESSAGE 记录的错误分类、重试次数与脱敏原因。 */
export function parseTranscriptError(record) {
  if (!record || record.type !== "ERROR_MESSAGE") return null;
  const rawFull = String(record.error || record.content || "").trim();
  if (!rawFull) {
    return {
      kind: "unknown",
      attempt: null,
      shortReason: "API error",
      raw: "",
    };
  }

  const attemptMatch = rawFull.match(/\battempt\s+(\d+)\b/i);
  const attempt = attemptMatch ? Number(attemptMatch[1]) : null;
  const lower = rawFull.toLowerCase();

  let kind = "api_error";
  let shortReason = "";
  if (
    lower.includes("wsasend") ||
    lower.includes("forcibly closed") ||
    lower.includes("connection reset") ||
    lower.includes("broken pipe") ||
    lower.includes("econnreset")
  ) {
    kind = "upload_reset";
    shortReason = lower.includes("wsasend")
      ? "wsasend: connection forcibly closed"
      : "connection reset by peer";
  } else if (
    lower.includes("stream idle timeout") ||
    lower.includes("context deadline exceeded") ||
    lower.includes("timed out")
  ) {
    kind = "stream_timeout";
    const tm = rawFull.match(/stream idle timeout\s*\(([^)]+)\)/i);
    shortReason = tm ? `stream idle timeout (${tm[1]})` : "upstream request timeout";
  } else if (lower.includes("stream was interrupted")) {
    kind = "stream_interrupted";
    shortReason = "stream interrupted";
  } else if (lower.includes(": eof") || /\beof\b/i.test(rawFull)) {
    kind = "upstream_eof";
    shortReason = "upstream EOF";
  } else if (
    lower.includes("model unreachable") ||
    lower.includes("dial tcp") ||
    lower.includes("no such host") ||
    lower.includes("connection refused")
  ) {
    kind = "network_error";
    shortReason = "model API unreachable";
  } else if (lower.includes("parsing the tool call")) {
    kind = "tool_parse";
    shortReason = "tool call parse error";
  } else {
    const cleaned = rawFull
      .replace(/Post\s+"https?:\/\/[^"]+":?\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    shortReason = (cleaned || "API error").slice(0, 96);
  }

  return {
    kind,
    attempt,
    shortReason,
    raw: rawFull.slice(0, 240),
  };
}

/** 判断最近一条并行多工具 PLANNER_RESPONSE 是否仍有未回写完的本地工具调用。 */
export function hasPendingParallelTools(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  let lastPlannerIdx = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.type === "PLANNER_RESPONSE") {
      lastPlannerIdx = i;
      break;
    }
  }
  if (lastPlannerIdx === -1) return false;

  const lastPlanner = parsed[lastPlannerIdx];
  const statusUpper = String(lastPlanner.status || "").toUpperCase();
  if (
    !Array.isArray(lastPlanner.tool_calls) ||
    lastPlanner.tool_calls.length <= 1 ||
    ABORTED_PLANNER_STATUSES.has(statusUpper)
  ) {
    return false;
  }

  const tail = parsed.slice(lastPlannerIdx + 1);
  if (tail.length === 0) return false;
  let completedCount = 0;
  for (const rec of tail) {
    if (rec?.type === "USER_INPUT" || rec?.type === "ERROR_MESSAGE" || rec?.type === "PLANNER_RESPONSE") {
      return false;
    }
    if (TOOL_RESULT_STEP_TYPES.has(rec?.type)) {
      completedCount += 1;
    }
  }
  return completedCount > 0 && completedCount < lastPlanner.tool_calls.length;
}

/** 从最近一次用户输入起扫描是否存在尚未收到结束/返回通知的后台任务。 */
export function hasPendingBackgroundTask(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  let startIdx = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.type === "USER_INPUT") {
      startIdx = i + 1;
      break;
    }
  }

  const pending = new Set();
  for (let i = startIdx; i < parsed.length; i++) {
    const rec = parsed[i];
    if (!rec) continue;
    if (rec.type === "GENERIC" && String(rec.status || "").toUpperCase() === "RUNNING") {
      const m = String(rec.content || "").match(
        /Tool is running as a background task with task id:\s*([^\s\r\n]+)/i,
      );
      if (m) pending.add(m[1]);
    } else if (rec.type === "SYSTEM_MESSAGE") {
      const text = String(rec.content || "");
      const tm = text.match(/Task id\s+"([^"]+)"\s+finished/i);
      if (tm) pending.delete(tm[1]);
      const sm = text.match(/sender=([^\s]+)/i);
      if (sm) pending.delete(sm[1]);
    }
  }
  return pending.size > 0;
}

/** 根据最后一条记录、新鲜度与尾部上下文推断当前所处执行阶段。 */
export function inferTranscriptPhase(last, isFresh, parsed = null) {
  if (!isFresh || !last) return "idle";
  if (TOOL_RESULT_STEP_TYPES.has(last.type) && Array.isArray(parsed) && hasPendingParallelTools(parsed)) {
    return "running_tool";
  }
  if (WAITING_LLM_STEP_TYPES.has(last.type)) {
    return "waiting_llm";
  }
  if (last.type === "PLANNER_RESPONSE") {
    const statusUpper = String(last.status || "").toUpperCase();
    if (ABORTED_PLANNER_STATUSES.has(statusUpper)) {
      return "idle";
    }
    if (last.tool_calls && last.tool_calls.length > 0) {
      return "running_tool";
    }
    if (statusUpper === "DONE") {
      return Array.isArray(parsed) && hasPendingBackgroundTask(parsed) ? "background_task" : "idle";
    }
    return "waiting_llm";
  }
  return "idle";
}
