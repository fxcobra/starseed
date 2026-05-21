type LogLevel = "log" | "info" | "warn" | "error";

type LogLine = {
  at: number;
  level: LogLevel;
  text: string;
};

const MAX_LINES = 1200;
const MAX_CHARS = 2000;

const lines: LogLine[] = [];

function safeStringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatArgs(args: unknown[]) {
  const out = args.map((a) => safeStringify(a)).join(" ");
  if (out.length <= MAX_CHARS) return out;
  return out.slice(0, MAX_CHARS) + "…";
}

function push(level: LogLevel, args: unknown[]) {
  lines.push({ at: Date.now(), level, text: formatArgs(args) });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

function fmtTs(at: number) {
  try {
    return new Date(at).toISOString();
  } catch {
    return String(at);
  }
}

export function getLogLines(limit: number) {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(2000, Math.floor(limit))) : 200;
  const slice = lines.slice(Math.max(0, lines.length - n));
  return slice.map((l) => `${fmtTs(l.at)} [${l.level}] ${l.text}`);
}

export function installConsoleCapture() {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    push("log", args);
    original.log(...args);
  };
  console.info = (...args: unknown[]) => {
    push("info", args);
    original.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("warn", args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("error", args);
    original.error(...args);
  };

  push("info", ["log capture enabled"]);
}

