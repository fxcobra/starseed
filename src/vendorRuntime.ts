import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBaileysRuntime, type BaileysGroup } from "./baileysRuntime.js";
import { fetchProductsForVendor, fetchVendorBotConfig } from "./ellbot.js";

export type VendorEvent =
  | { type: "qr"; qr: string }
  | { type: "status"; status: "connecting" | "connected" | "disconnected" }
  | { type: "message_sent"; id: string; to: string; text: string; at: string }
  | { type: "message_received"; id: string; from: string; text: string; at: string; pushName?: string }
  | { type: "pairing_code"; phone: string; code: string; at: string }
  | { type: "config_updated"; config: VendorConfig; at: string }
  | { type: "group_locked"; name: string; locked: boolean; at: string }
  | { type: "group_dropped"; name: string; at: string }
  | { type: "drop_posted"; channel: "group" | "status"; targets: string[]; text: string; at: string }
  | { type: "error"; message: string };

export type VendorMessage = { id: string; dir: "out" | "in"; peer: string; text: string; at: string };

export type VendorConfig = {
  strategyMode: "ai_lead";
  escalationKeywords: string[];
};

type ButtonSpec = { id: string; text: string };

type Runtime = {
  vendorId: string;
  sessionDir: string;
  emitter: EventEmitter;
  messages: VendorMessage[];
  status: "connecting" | "connected" | "disconnected";
  lastQr?: string;
  lastQrAt?: number;
  lastError?: string;
  startedAt: string;
  mode: "baileys";
  registered?: boolean;
  stopping?: boolean;
  restartAttempt: number;
  restartTimer?: NodeJS.Timeout;
  resetAttempt: number;
  resetTimer?: NodeJS.Timeout;
  baileysSend?: (to: string, text: string) => Promise<void>;
  baileysSendButtons?: (to: string, text: string, buttons: ButtonSpec[]) => Promise<void>;
  baileysSendImage?: (to: string, imageUrl: string, caption?: string) => Promise<void>;
  baileysSendVideo?: (to: string, videoUrl: string, caption?: string) => Promise<void>;
  baileysPair?: (phone: string) => Promise<string>;
  baileysListGroups?: () => Promise<BaileysGroup[]>;
  baileysSetGroupLocked?: (groupId: string, locked: boolean) => Promise<void>;
  baileysLeaveGroup?: (groupId: string) => Promise<void>;
  baileysSendGroupText?: (groupId: string, text: string, mentions?: string[]) => Promise<string | null>;
  baileysGroupMentions?: (groupId: string) => Promise<string[]>;
  baileysSendGroupImage?: (groupId: string, imageUrl: string, caption?: string) => Promise<string | null>;
  baileysSendGroupProductImages?: (
    groupId: string,
    bodyText: string,
    footerText: string,
    cards: Array<{
      product_id?: number;
      image_url: string;
      body: string;
      footer?: string;
      url?: string;
      buttons?: Array<{ text: string; url: string }>;
    }>,
    buttonText?: string
  ) => Promise<string | null>;
  baileysSendGroupCtaCard?: (groupId: string, bodyText: string, footerText: string, prefillText: string, buttonText: string) => Promise<string | null>;
  baileysSendGroupCtaLinks?: (
    groupId: string,
    bodyText: string,
    footerText: string,
    buttons: Array<{ text: string; url: string }>
  ) => Promise<string | null>;
  baileysSendStatusText?: (text: string, targets?: string[]) => Promise<string | null>;
  baileysSendStatusImage?: (imageUrl: string, caption?: string, targets?: string[]) => Promise<string | null>;
  baileysSendStatusVideo?: (videoUrl: string, caption?: string, targets?: string[]) => Promise<string | null>;
  baileysSendStatusAlbum?: (mediaUrls: string[], caption: string, targets?: string[]) => Promise<string | null>;
  config: VendorConfig;
  groups: Map<string, { name: string; locked: boolean; participantsCount: number }>;
  dropReplyMap: Map<string, { groupId: string; productIds: number[]; scheduleId?: number; at: number }>;
  unlockTimers: NodeJS.Timeout[];
  stop: () => Promise<void>;
};

const runtimes = new Map<string, Runtime>();
const startingRuntimes = new Map<string, Promise<Runtime>>();
const backoff = new Map<string, { restartAttempt: number; resetAttempt: number }>();
const sendQueue = new Map<string, Promise<unknown>>();

function getBackoff(vendorId: string) {
  const existing = backoff.get(vendorId);
  if (existing) return existing;
  const next = { restartAttempt: 0, resetAttempt: 0 };
  backoff.set(vendorId, next);
  return next;
}

function enqueueSend<T>(vendorId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendQueue.get(vendorId) ?? Promise.resolve();
  const next = prev.catch(() => void 0).then(fn);
  sendQueue.set(vendorId, next);
  void next.finally(() => {
    if (sendQueue.get(vendorId) === next) sendQueue.delete(vendorId);
  });
  return next;
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveDataDir(raw: string | null | undefined, fallback: string) {
  const v = (raw ?? "").trim() || fallback;
  return path.isAbsolute(v) ? v : path.resolve(PKG_ROOT, v);
}

function sessionDirForVendor(vendorId: string) {
  const sessionsRoot = resolveDataDir(process.env.SESSIONS_DIR, "./sessions");
  return path.join(sessionsRoot, `vendor_id_${vendorId}`);
}

function configPathForVendor(vendorId: string) {
  const root = resolveDataDir(process.env.VENDOR_CONFIG_DIR, "./vendor-config");
  return path.join(root, `vendor_id_${vendorId}.json`);
}

function apiBase() {
  const raw = (process.env.API_SERVER_BASE_URL ?? "http://127.0.0.1:8000/api").trim().replace(/\/$/, "");
  if (!raw) return raw;
  if (/\/api(\/|$)/.test(raw)) return raw;
  return `${raw}/api`;
}

async function loadVendorConfig(vendorId: string): Promise<VendorConfig> {
  const p = configPathForVendor(vendorId);
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return defaultConfig();
    const obj = parsed as Record<string, unknown>;
    const escalationKeywords = Array.isArray(obj["escalationKeywords"])
      ? (obj["escalationKeywords"] as unknown[]).filter((x) => typeof x === "string").map((x) => (x as string).slice(0, 60))
      : defaultConfig().escalationKeywords;
    return { strategyMode: "ai_lead", escalationKeywords };
  } catch {
    return defaultConfig();
  }
}

async function saveVendorConfig(vendorId: string, config: VendorConfig) {
  const p = configPathForVendor(vendorId);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(config), "utf8");
}

async function forwardInboundToApi(
  vendorId: string,
  payload: {
    from: string;
    participant?: string;
    push_name?: string;
    text: string;
    message_id?: string;
    quoted_message_id?: string;
    quoted_remote_jid?: string;
    is_status_reply?: boolean;
  }
) {
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  if (!base) return;
  try {
    const url = `${base.replace(/\/$/, "")}/internal/bot/inbound/${encodeURIComponent(vendorId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-bot-secret": secret } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const msg = `API inbound rejected (${resp.status})`;
      const runtime = runtimes.get(vendorId);
      if (runtime) emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      else process.stdout.write(`${msg}\n`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "API inbound error.";
    const runtime = runtimes.get(vendorId);
    if (runtime) emit(runtime, { type: "error", message: `API inbound error: ${msg}` } satisfies VendorEvent);
    else process.stdout.write(`API inbound error: ${msg}\n`);
  }
}

async function logMessageToApi(
  vendorId: string,
  payload: {
    peer: string;
    direction: "in" | "out";
    text: string;
    external_id?: string;
    sent_at?: string;
    display_name?: string;
  }
) {
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  if (!base) return;
  const peer = (payload.peer ?? "").trim();
  const text = (payload.text ?? "").trim();
  if (!peer || !text) return;
  try {
    const url = `${base.replace(/\/$/, "")}/internal/bot/log-message/${encodeURIComponent(vendorId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-bot-secret": secret } : {}),
      },
      body: JSON.stringify({
        peer,
        direction: payload.direction,
        text,
        external_id: typeof payload.external_id === "string" && payload.external_id.trim() ? payload.external_id.trim() : undefined,
        sent_at: typeof payload.sent_at === "string" && payload.sent_at.trim() ? payload.sent_at.trim() : undefined,
        display_name: typeof payload.display_name === "string" && payload.display_name.trim() ? payload.display_name.trim() : undefined,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const msg = `API log-message rejected (${resp.status})`;
      const runtime = runtimes.get(vendorId);
      if (runtime) emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      else process.stdout.write(`${msg}\n`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "API log-message error.";
    const runtime = runtimes.get(vendorId);
    if (runtime) emit(runtime, { type: "error", message: `API log-message error: ${msg}` } satisfies VendorEvent);
    else process.stdout.write(`API log-message error: ${msg}\n`);
  }
}

async function forwardStatusPostToApi(
  vendorId: string,
  payload: {
    message_id: string;
    text?: string;
    media_url?: string;
    meta?: Record<string, unknown>;
  }
) {
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  if (!base) return;
  try {
    const url = `${base.replace(/\/$/, "")}/internal/bot/status-post/${encodeURIComponent(vendorId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-bot-secret": secret } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const msg = `API status-post rejected (${resp.status})`;
      const runtime = runtimes.get(vendorId);
      if (runtime) emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      else process.stdout.write(`${msg}\n`);
    }
  } catch {
    void 0;
  }
}

function isBaileysEnabled() {
  const v = (process.env.BAILEYS_ENABLED ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

export function getRuntime(vendorId: string) {
  return runtimes.get(vendorId);
}

export function listRuntimes() {
  return Array.from(runtimes.values()).map((r) => ({
    vendorId: r.vendorId,
    mode: r.mode,
    status: r.status,
    startedAt: r.startedAt,
    registered: r.registered === true,
    messagesCount: r.messages.length,
    lastError: r.lastError ?? null,
  }));
}

function emit(runtime: Runtime, event: VendorEvent) {
  if (event.type === "status") {
    runtime.status = event.status;
    if (event.status === "connected") {
      const b = getBackoff(runtime.vendorId);
      b.restartAttempt = 0;
      if (runtime.restartTimer) {
        clearTimeout(runtime.restartTimer);
        runtime.restartTimer = undefined;
      }
      b.resetAttempt = 0;
      if (runtime.resetTimer) {
        clearTimeout(runtime.resetTimer);
        runtime.resetTimer = undefined;
      }
    }
    if (event.status === "disconnected") {
      if (runtime.stopping === true) {
        runtime.emitter.emit("event", event);
        return;
      }
      if (runtime.resetTimer) {
        runtime.emitter.emit("event", event);
        return;
      }
      if (runtime.registered !== true) {
        runtime.emitter.emit("event", event);
        return;
      }
      if (isConflictError(runtime.lastError)) {
        if (runtime.resetTimer) {
          clearTimeout(runtime.resetTimer);
          runtime.resetTimer = undefined;
        }
        if (!runtime.restartTimer) {
          const b = getBackoff(runtime.vendorId);
          const attempt = Math.min(6, Math.max(0, b.restartAttempt));
          const delay = Math.min(60_000, 1_000 * Math.pow(2, attempt));
          b.restartAttempt = attempt + 1;
          console.log(`vendor ${runtime.vendorId}: scheduling restart (conflict) in ${delay}ms`);
          runtime.restartTimer = setTimeout(() => {
            runtime.restartTimer = undefined;
            void restartVendorRuntime(runtime.vendorId).catch(() => void 0);
          }, delay);
        }
        runtime.emitter.emit("event", event);
        return;
      }
      if (isBadSessionError(runtime.lastError)) {
        if (runtime.restartTimer) {
          clearTimeout(runtime.restartTimer);
          runtime.restartTimer = undefined;
        }
        if (!runtime.resetTimer) {
          const b = getBackoff(runtime.vendorId);
          const attempt = Math.min(4, Math.max(0, b.resetAttempt));
          const delay = Math.min(60_000, 1_500 * Math.pow(2, attempt));
          b.resetAttempt = attempt + 1;
          console.log(`vendor ${runtime.vendorId}: scheduling session reset in ${delay}ms`);
          runtime.resetTimer = setTimeout(() => {
            runtime.resetTimer = undefined;
            void resetVendorRuntime(runtime.vendorId).catch(() => void 0);
          }, delay);
        }
        runtime.emitter.emit("event", event);
        return;
      }
      if (!runtime.restartTimer) {
        const b = getBackoff(runtime.vendorId);
        const attempt = Math.min(6, Math.max(0, b.restartAttempt));
        const delay = Math.min(60_000, 2_000 * Math.pow(2, attempt));
        b.restartAttempt = attempt + 1;
        console.log(`vendor ${runtime.vendorId}: scheduling restart in ${delay}ms`);
        runtime.restartTimer = setTimeout(() => {
          runtime.restartTimer = undefined;
          void restartVendorRuntime(runtime.vendorId).catch(() => void 0);
        }, delay);
      }
    }
  }
  if (event.type === "qr") {
    runtime.lastQr = event.qr;
    runtime.lastQrAt = Date.now();
  }
  if (event.type === "error") {
    runtime.lastError = event.message;
    if (runtime.stopping === true) {
      runtime.emitter.emit("event", event);
      return;
    }
    if (runtime.registered !== true) {
      runtime.emitter.emit("event", event);
      return;
    }
    if (runtime.status !== "connected" && isConflictError(event.message)) {
      if (!runtime.restartTimer) {
        const b = getBackoff(runtime.vendorId);
        const attempt = Math.min(6, Math.max(0, b.restartAttempt));
        const delay = Math.min(60_000, 1_000 * Math.pow(2, attempt));
        b.restartAttempt = attempt + 1;
        console.log(`vendor ${runtime.vendorId}: scheduling restart (conflict) in ${delay}ms`);
        runtime.restartTimer = setTimeout(() => {
          runtime.restartTimer = undefined;
          void restartVendorRuntime(runtime.vendorId).catch(() => void 0);
        }, delay);
      }
    } else if (runtime.status !== "connected" && isBadSessionError(event.message)) {
      if (runtime.restartTimer) {
        clearTimeout(runtime.restartTimer);
        runtime.restartTimer = undefined;
      }
      if (!runtime.resetTimer) {
        const b = getBackoff(runtime.vendorId);
        const attempt = Math.min(4, Math.max(0, b.resetAttempt));
        const delay = Math.min(60_000, 1_500 * Math.pow(2, attempt));
        b.resetAttempt = attempt + 1;
        console.log(`vendor ${runtime.vendorId}: scheduling session reset in ${delay}ms`);
        runtime.resetTimer = setTimeout(() => {
          runtime.resetTimer = undefined;
          void resetVendorRuntime(runtime.vendorId).catch(() => void 0);
        }, delay);
      }
    }
  }
  runtime.emitter.emit("event", event);
}

function isBadSessionError(msg: string | null | undefined) {
  const m = (msg ?? "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("bad mac") ||
    m.includes("restart required") ||
    m.includes("logged out") ||
    m.includes("code 515") ||
    m.includes("status code 515") ||
    m.includes("statuscode 515")
  );
}

function isConflictError(msg: string | null | undefined) {
  const m = (msg ?? "").toLowerCase();
  if (!m) return false;
  return m.includes("stream errored (conflict)") || m.includes("(conflict)") || m.includes("code 440") || m.includes("status code 440");
}

function defaultConfig(): VendorConfig {
  return {
    strategyMode: "ai_lead",
    escalationKeywords: ["agent", "human", "support", "help"],
  };
}

function includesKeyword(text: string, keywords: string[]) {
  const hay = text.toLowerCase();
  for (const k of keywords) {
    const kk = k.trim().toLowerCase();
    if (!kk) continue;
    if (hay.includes(kk)) return true;
  }
  return false;
}

function cleanPairingPhone(raw: string) {
  return String(raw ?? "")
    .trim()
    .replace(/[^\d]/g, "")
    .slice(0, 20);
}

async function pushOutbound(runtime: Runtime, to: string, text: string) {
  const msg: VendorMessage = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    dir: "out",
    peer: to,
    text,
    at: new Date().toISOString(),
  };
  runtime.messages.unshift(msg);
  emit(runtime, {
    type: "message_sent",
    id: msg.id,
    to,
    text,
    at: msg.at,
  } satisfies VendorEvent);
}

function rememberDropReply(runtime: Runtime, messageId: string, groupId: string, meta: Record<string, unknown> | undefined) {
  const id = (messageId ?? "").trim();
  if (!id) return;
  const group = (groupId ?? "").trim();
  if (!group || !group.endsWith("@g.us")) return;
  const rawIds = (meta as any)?.product_ids;
  const rawId = (meta as any)?.product_id;
  const scheduleIdRaw = (meta as any)?.schedule_id;
  const productIds = Array.isArray(rawIds) ? rawIds.filter((x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0).map((x: number) => Math.floor(x)) : [];
  if (typeof rawId === "number" && Number.isFinite(rawId) && rawId > 0) productIds.push(Math.floor(rawId));
  const uniq = Array.from(new Set(productIds)).slice(0, 25);
  const scheduleId = typeof scheduleIdRaw === "number" && Number.isFinite(scheduleIdRaw) ? Math.floor(scheduleIdRaw) : undefined;
  runtime.dropReplyMap.set(id, { groupId: group, productIds: uniq, scheduleId, at: Date.now() });
  while (runtime.dropReplyMap.size > 500) {
    const first = runtime.dropReplyMap.keys().next();
    if (!first.done && first.value) runtime.dropReplyMap.delete(first.value);
    else break;
  }
}

export async function startVendorRuntime(vendorId: string) {
  const existing = runtimes.get(vendorId);
  if (existing) return existing;
  const inflight = startingRuntimes.get(vendorId);
  if (inflight) return await inflight;

  const p = (async () => {
    if (!isBaileysEnabled()) {
      throw new Error("Baileys is required. Set BAILEYS_ENABLED=true.");
    }

    const sessionDir = sessionDirForVendor(vendorId);
    await mkdir(sessionDir, { recursive: true });

    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);

    let stopBaileys: (() => Promise<void>) | null = null;
    const persistedConfig = await loadVendorConfig(vendorId);

    const runtime: Runtime = {
      vendorId,
      sessionDir,
      emitter,
      messages: [],
      status: "connecting",
      startedAt: new Date().toISOString(),
      mode: "baileys",
      config: persistedConfig,
      groups: new Map(),
      dropReplyMap: new Map(),
      unlockTimers: [],
      restartAttempt: 0,
      resetAttempt: 0,
      stop: async () => {
        runtime.stopping = true;
        try {
          for (const t of runtime.unlockTimers) clearTimeout(t);
          if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
          if (runtime.resetTimer) clearTimeout(runtime.resetTimer);
          if (stopBaileys) await stopBaileys();
        } finally {
          runtimes.delete(vendorId);
        }
      },
    };

    emit(runtime, { type: "status", status: "connecting" } satisfies VendorEvent);

    try {
      const br = await startBaileysRuntime(vendorId, sessionDir, {
        onStatus: (status) => emit(runtime, { type: "status", status } satisfies VendorEvent),
        onQr: (qr) => emit(runtime, { type: "qr", qr } satisfies VendorEvent),
        onRegistered: (registered) => {
          runtime.registered = registered;
        },
        onInboundMessage: ({ id, from, participant, pushName, text, at, quotedMessageId, quotedRemoteJid, isStatusReply, mentionedJids, mentionsMe }) => {
          runtime.messages.unshift({ id, dir: "in", peer: from, text, at });
          emit(runtime, { type: "message_received", id, from, pushName, text, at } satisfies VendorEvent);
          void (async () => {
            const groupId = (from ?? "").trim();
            const sender = (participant ?? "").trim();
            const quoted = (quotedMessageId ?? "").trim();
            if (!groupId.endsWith("@g.us") || !sender || !quoted) return;
            const hit = runtime.dropReplyMap.get(quoted);
            if (!hit) return;
            const firstProductId = Array.isArray(hit.productIds) && hit.productIds.length ? hit.productIds[0] : null;
            const handle = sender.split("@")[0] ?? sender;
            const dmKeyword = firstProductId ? `BUY ${firstProductId}` : "BUY";
            let storeName = "Our Store";
            try {
              const cfg = await fetchVendorBotConfig(vendorId);
              storeName = (cfg?.whatsappBotBrain?.storeName ?? cfg?.vendor?.name ?? "Our Store").trim() || "Our Store";
            } catch {
              void 0;
            }
            const groupText = `@${handle} To continue, send me a DM with: "${dmKeyword}"`;
            try {
              if (runtime.baileysSendGroupText) await runtime.baileysSendGroupText(groupId, groupText, [sender]);
            } catch {
              void 0;
            }
            try {
              if (runtime.baileysSendGroupCtaCard) await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, dmKeyword, "Continue in DM");
            } catch {
              void 0;
            }
          })();
          void (async () => {
            const groupId = (from ?? "").trim();
            const sender = (participant ?? "").trim();
            if (!groupId.endsWith("@g.us") || !sender) return;
            let cfg: any = null;
            try {
              cfg = await fetchVendorBotConfig(vendorId);
            } catch (e: unknown) {
              return;
            }
            const gs = cfg?.whatsappGroupSettings ?? null;
            if (!gs?.enabled) return;
            const tagOnly = typeof gs.tagOnly === "boolean" ? gs.tagOnly : true;
            const tagBack = typeof gs.tagBack === "boolean" ? gs.tagBack : true;
            if (tagOnly) {
              const hasAnyMention = Array.isArray(mentionedJids) && mentionedJids.some((j) => typeof j === "string" && j.trim());
              if (!mentionsMe && !hasAnyMention) return;
            }
            const storeName = (cfg?.whatsappBotBrain?.storeName ?? cfg?.vendor?.name ?? "Our Store").trim() || "Our Store";
            const handle = sender.split("@")[0] ?? sender;
            const cleaned = String(text ?? "")
              .replace(/@\S+/g, " ")
              .replace(/\s+/g, " ")
              .trim();

            const mentionText = tagBack ? `@${handle} ` : "";
            const mentions = tagBack ? [sender] : undefined;

            const searchMode = typeof (gs as any)?.searchMode === "string" ? String((gs as any).searchMode).trim() : "dm_cta";
            const askDmOnly = searchMode === "ask_dm";

            if (searchMode === "dm_cta") {
              try {
                if (tagBack && runtime.baileysSendGroupText) await runtime.baileysSendGroupText(groupId, `${mentionText}Tap below to continue in DM.`, mentions);
              } catch (e: unknown) {
                void e;
              }
              if (runtime.baileysSendGroupCtaCard) {
                try {
                  const prefill = cleaned || "Menu";
                  await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, prefill, "Continue in DM");
                } catch (e: unknown) {
                  void e;
                }
              } else {
                try {
                  if (runtime.baileysSendGroupText) await runtime.baileysSendGroupText(groupId, `${mentionText}Please DM me to continue.`, mentions);
                } catch (e: unknown) {
                  void e;
                }
              }
              return;
            }

            if (!runtime.baileysSendGroupProductImages) return;
            if (!cleaned) {
              try {
                if (runtime.baileysSendGroupText) await runtime.baileysSendGroupText(groupId, `${mentionText}What product are you looking for?`, mentions);
              } catch {
                void 0;
              }
              return;
            }
            const products = await fetchProductsForVendor(vendorId).catch(() => []);

            const openKeys: string[] = Array.isArray((cfg as any)?.openrouter?.keys)
              ? ((cfg as any).openrouter.keys as unknown[])
                  .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
                  .map((x: string) => x.trim())
              : [];
            const openModel = typeof (cfg as any)?.openrouter?.model === "string" ? String((cfg as any).openrouter.model).trim() : "";

            type Plan =
              | { action: "reply"; reply_text: string }
              | {
                  action: "search";
                  query: string;
                  brand?: string | null;
                  negative_keywords?: string[];
                  min_price?: number | null;
                  max_price?: number | null;
                  intro_message?: string;
                };

            function extractJson(s: string) {
              const t = String(s ?? "");
              const a = t.indexOf("{");
              const b = t.lastIndexOf("}");
              if (a >= 0 && b > a) return t.slice(a, b + 1);
              return "";
            }

            async function planWithAi(input: string): Promise<Plan | null> {
              if (!openKeys.length || !openModel) return null;
              const key = openKeys[Math.floor(Math.random() * openKeys.length)]!;
              const delivery = (cfg as any)?.deliveryOptions ?? null;
              const deliveryNotes = typeof delivery?.notes === "string" ? String(delivery.notes).trim() : "";
              const deliveryMethods = Array.isArray(delivery?.methods) ? (delivery.methods as any[]) : [];
              const deliveryText = [
                deliveryNotes ? `Delivery notes: ${deliveryNotes.slice(0, 250)}` : "",
                deliveryMethods.length
                  ? `Delivery methods: ${deliveryMethods
                      .slice(0, 6)
                      .map((m) => String(m?.name ?? "").trim())
                      .filter((x) => x.length > 0)
                      .join(", ")}`
                  : "",
              ]
                .filter((x) => x)
                .join("\n");
              const shopPhoneRaw = typeof (cfg as any)?.whatsappBotBrain?.shopPhone === "string" ? String((cfg as any).whatsappBotBrain.shopPhone).trim() : "";
              const system =
                `You are a WhatsApp sales assistant for ${storeName}.\n` +
                (shopPhoneRaw ? `Shop phone: ${shopPhoneRaw}\n` : "") +
                (deliveryText ? `${deliveryText}\n` : "") +
                `Decide whether to ask ONE short clarifying question, or search products.\n` +
                `Return ONLY raw JSON in one of these forms:\n` +
                `1) {"action":"reply","reply_text":"..."}\n` +
                `2) {"action":"search","query":"...","brand":null,"negative_keywords":[],"min_price":null,"max_price":null,"intro_message":"..."}\n` +
                `Rules: keep reply_text short (1-2 sentences). If they ask about delivery/payment/store, answer using the info above. If user is vague, ask brand/budget. If user asks availability, use action=search.`;

              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 8_000);
              try {
                const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                  method: "POST",
                  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                  body: JSON.stringify({
                    model: openModel,
                    messages: [
                      { role: "system", content: system },
                      { role: "user", content: input },
                    ],
                    temperature: 0.2,
                    max_tokens: 250,
                  }),
                  signal: controller.signal,
                });
                const json = (await resp.json().catch(() => null)) as any;
                const content = String(json?.choices?.[0]?.message?.content ?? "").trim();
                const raw = extractJson(content);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== "object") return null;
                if (parsed.action === "reply") {
                  const reply_text = typeof parsed.reply_text === "string" ? parsed.reply_text.trim() : "";
                  if (!reply_text) return null;
                  return { action: "reply", reply_text };
                }
                if (parsed.action === "search") {
                  const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
                  const brand = typeof parsed.brand === "string" ? parsed.brand.trim() : null;
                  const negative_keywords = Array.isArray(parsed.negative_keywords)
                    ? parsed.negative_keywords
                        .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
                        .map((x: string) => x.trim().toLowerCase())
                        .slice(0, 20)
                    : [];
                  const min_price = typeof parsed.min_price === "number" && Number.isFinite(parsed.min_price) ? parsed.min_price : null;
                  const max_price = typeof parsed.max_price === "number" && Number.isFinite(parsed.max_price) ? parsed.max_price : null;
                  const intro_message = typeof parsed.intro_message === "string" ? parsed.intro_message.trim().slice(0, 250) : "";
                  if (!query && !brand) return null;
                  return { action: "search", query: query || (brand ?? ""), brand, negative_keywords, min_price, max_price, intro_message };
                }
                return null;
              } catch {
                return null;
              } finally {
                clearTimeout(timeout);
              }
            }

            function smartSearchLocal(
              query: string,
              allProducts: any[],
              opts?: { brand?: string | null; min?: number | null; max?: number | null; negative?: string[] }
            ) {
              const q = (query ?? "").trim().toLowerCase();
              let filtered = Array.isArray(allProducts) ? allProducts : [];
              const brand = typeof opts?.brand === "string" && opts.brand.trim() ? opts.brand.trim().toLowerCase() : null;
              if (brand) filtered = filtered.filter((p) => String(p?.brand ?? "").trim().toLowerCase() === brand);
              const negative = Array.isArray(opts?.negative) ? opts!.negative.filter((x) => typeof x === "string" && x.trim()) : [];
              if (negative.length) {
                filtered = filtered.filter((p) => {
                  const hay = `${p?.name ?? ""} ${p?.brand ?? ""} ${p?.category ?? ""} ${p?.description ?? ""}`.toLowerCase();
                  return !negative.some((bad) => hay.includes(String(bad)));
                });
              }
              const min = typeof opts?.min === "number" && Number.isFinite(opts.min) ? opts.min : null;
              const max = typeof opts?.max === "number" && Number.isFinite(opts.max) ? opts.max : null;
              if (min !== null) filtered = filtered.filter((p) => Number(p?.price ?? 0) >= min);
              if (max !== null) filtered = filtered.filter((p) => Number(p?.price ?? 0) <= max);
              if (!q) return filtered.slice(0, 6);
              const stop = new Set(["i", "me", "want", "need", "show", "some", "any", "the", "a", "an", "and", "or", "for", "with", "please"]);
              const tokens = q.replace(/[^a-z0-9\s]/g, " ").split(/\s+/g).filter((t) => t.length >= 2 && !stop.has(t));
              const scored: Array<{ p: any; score: number }> = [];
              for (const p of filtered) {
                let score = 0;
                const name = String(p?.name ?? "").toLowerCase();
                const cat = String(p?.category ?? "").toLowerCase();
                const brandHay = String(p?.brand ?? "").toLowerCase();
                const desc = String(p?.description ?? "").toLowerCase();
                if (name === q) score += 500;
                else if (name.includes(q)) score += 120;
                for (const tok of tokens) {
                  if (name.includes(tok)) score += 20;
                  if (cat.includes(tok)) score += 8;
                  if (brandHay.includes(tok)) score += 25;
                  if (desc.includes(tok)) score += 2;
                }
                if (score > 0) scored.push({ p, score });
              }
              scored.sort((a, b) => b.score - a.score);
              return scored.map((s) => s.p).slice(0, 6);
            }

            const plan = await planWithAi(cleaned);
            if (plan && plan.action === "reply") {
              try {
                if (runtime.baileysSendGroupText) await runtime.baileysSendGroupText(groupId, `${mentionText}${plan.reply_text}`, mentions);
              } catch {
                void 0;
              }
              return;
            }

            if (askDmOnly) {
              try {
                if (runtime.baileysSendGroupText)
                  await runtime.baileysSendGroupText(
                    groupId,
                    `${mentionText}I can send options in DM. Please DM me with “${cleaned || "Menu"}” to continue.`,
                    mentions
                  );
              } catch {
                void 0;
              }
              return;
            }

            const queryToSearch = plan && plan.action === "search" ? plan.query : cleaned;
            const hits = smartSearchLocal(queryToSearch, products as any[], {
              brand: plan && plan.action === "search" ? (plan.brand ?? null) : null,
              min: plan && plan.action === "search" ? (plan.min_price ?? null) : null,
              max: plan && plan.action === "search" ? (plan.max_price ?? null) : null,
              negative: plan && plan.action === "search" ? (plan.negative_keywords ?? []) : [],
            });
            if (!hits.length) {
              try {
                if (runtime.baileysSendGroupText)
                  await runtime.baileysSendGroupText(groupId, `${mentionText}I couldn’t find a match for “${cleaned}”. Try another name.`, mentions);
              } catch {
                void 0;
              }
              return;
            }
            const cards = hits
              .map((p) => ({
                product_id: typeof p?.id === "number" ? p.id : undefined,
                image_url: typeof p?.image_url === "string" && p.image_url.trim() ? p.image_url.trim() : "",
                body: `*${String(p?.name ?? "").trim().slice(0, 60) || "Item"}*\n${String(p?.currency ?? "").trim()} ${Number(p?.price ?? 0)}`.trim(),
                footer: storeName,
              }))
              .filter((c) => c.image_url);
            if (!cards.length) return;
            try {
              const intro =
                plan && plan.action === "search" && typeof plan.intro_message === "string" && plan.intro_message.trim()
                  ? plan.intro_message.trim().slice(0, 250)
                  : "Here are some options:";
              if (runtime.baileysSendGroupText) await runtime.baileysSendGroupText(groupId, `${mentionText}${intro}`, mentions);
            } catch {
              void 0;
            }
            try {
              await runtime.baileysSendGroupProductImages(groupId, "", "", cards, "Continue in DM");
            } catch {
              void 0;
            }
          })();
          if (isStatusReply === true) {
            void forwardInboundToApi(vendorId, {
              from,
              participant: typeof participant === "string" ? participant : undefined,
              push_name: typeof pushName === "string" ? pushName : undefined,
              text,
              message_id: id,
              quoted_message_id: typeof quotedMessageId === "string" ? quotedMessageId : undefined,
              quoted_remote_jid: typeof quotedRemoteJid === "string" ? quotedRemoteJid : undefined,
              is_status_reply: true,
            });
          } else if (typeof from === "string" && !from.endsWith("@g.us") && from !== "status@broadcast") {
            void logMessageToApi(vendorId, { peer: from, direction: "in", text, external_id: id, sent_at: at, display_name: pushName });
          }
        },
        onError: (message) => {
          emit(runtime, { type: "error", message } satisfies VendorEvent);
          console.log(`vendor ${vendorId}: ${message}`);
        },
      });
      runtime.mode = "baileys";
      stopBaileys = br.stop;
      runtime.baileysSend = br.sendText;
      runtime.baileysSendButtons = br.sendButtons;
      runtime.baileysSendImage = br.sendImage;
      runtime.baileysSendVideo = br.sendVideo;
      runtime.baileysPair = br.requestPairingCode;
      runtime.baileysListGroups = br.listGroups;
      runtime.baileysSetGroupLocked = br.setGroupLocked;
      runtime.baileysLeaveGroup = br.leaveGroup;
      runtime.baileysSendGroupText = br.sendGroupText;
      runtime.baileysGroupMentions = (br as any).groupMentions;
      runtime.baileysSendGroupImage = br.sendGroupImage;
      runtime.baileysSendGroupProductImages = (br as any).sendGroupProductImages;
      runtime.baileysSendGroupCtaCard = (br as any).sendGroupCtaCard;
      runtime.baileysSendGroupCtaLinks = (br as any).sendGroupCtaLinks;
      runtime.baileysSendStatusText = br.sendStatusText;
      runtime.baileysSendStatusImage = br.sendStatusImage;
      runtime.baileysSendStatusVideo = (br as any).sendStatusVideo;
      runtime.baileysSendStatusAlbum = (br as any).sendStatusAlbum;
    } catch (e: unknown) {
      runtime.mode = "baileys";
      emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Baileys init failed." } satisfies VendorEvent);
      emit(runtime, { type: "status", status: "disconnected" } satisfies VendorEvent);
    }

    runtimes.set(vendorId, runtime);
    return runtime;
  })();

  startingRuntimes.set(vendorId, p);
  try {
    return await p;
  } finally {
    if (startingRuntimes.get(vendorId) === p) startingRuntimes.delete(vendorId);
  }
}

export async function restartVendorRuntime(vendorId: string) {
  const inflight = startingRuntimes.get(vendorId);
  if (inflight) {
    try {
      await inflight;
    } catch {
      void 0;
    }
  }
  const existing = runtimes.get(vendorId);
  if (existing) await existing.stop();
  return await startVendorRuntime(vendorId);
}

export async function resetVendorRuntime(vendorId: string) {
  const inflight = startingRuntimes.get(vendorId);
  if (inflight) {
    try {
      await inflight;
    } catch {
      void 0;
    }
  }
  const existing = runtimes.get(vendorId);
  if (existing) await existing.stop();
  const sessionDir = sessionDirForVendor(vendorId);
  await rm(sessionDir, { recursive: true, force: true });
  return await startVendorRuntime(vendorId);
}

export async function purgeVendorData(vendorId: string) {
  const existing = runtimes.get(vendorId);
  if (existing) await existing.stop();
  const sessionDir = sessionDirForVendor(vendorId);
  await rm(sessionDir, { recursive: true, force: true });
  const cfgPath = configPathForVendor(vendorId);
  await rm(cfgPath, { force: true });
  backoff.delete(vendorId);
  sendQueue.delete(vendorId);
  return { ok: true };
}

export async function sendVendorMessage(vendorId: string, to: string, text: string) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    if (!runtime.baileysSend) throw new Error("WhatsApp runtime not ready.");
    try {
      await runtime.baileysSend(to, text);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Send failed.";
      emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      return { ok: false, message: msg };
    }
    await pushOutbound(runtime, to, text);
    return { ok: true };
  });
}

export async function sendVendorButtons(vendorId: string, to: string, text: string, buttons: Array<{ id: string; text: string }>) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    if (!runtime.baileysSendButtons) throw new Error("WhatsApp runtime not ready.");
    try {
      await runtime.baileysSendButtons(to, text, buttons);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Send failed.";
      emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      return { ok: false, message: msg };
    }
    await pushOutbound(runtime, to, text);
    return { ok: true };
  });
}

export async function sendVendorImage(vendorId: string, to: string, imageUrl: string, caption?: string) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    if (!runtime.baileysSendImage) throw new Error("WhatsApp runtime not ready.");
    const cap = typeof caption === "string" ? caption : "";
    try {
      console.log(`vendor ${vendorId}: send image capLen=${cap.trim() ? cap.length : 0}`);
      await runtime.baileysSendImage(to, imageUrl, cap);
      await new Promise((r) => setTimeout(r, 900));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Send failed.";
      emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      return { ok: false, message: msg };
    }
    await pushOutbound(runtime, to, cap);
    return { ok: true };
  });
}

export async function sendVendorImages(vendorId: string, to: string, imageUrls: string[], caption?: string) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    if (!runtime.baileysSendImage) throw new Error("WhatsApp runtime not ready.");

    const urls = (Array.isArray(imageUrls) ? imageUrls : [])
      .filter((x) => typeof x === "string")
      .map((x) => String(x).trim())
      .filter((x) => x !== "")
      .slice(0, 10);

    const cap = typeof caption === "string" ? caption : "";
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < urls.length; i++) {
      const u = urls[i]!;
      try {
        if (i === 0) {
          const len = cap.trim() ? cap.length : 0;
          console.log(`vendor ${vendorId}: send image ${i + 1}/${urls.length} capLen=${len}`);
          await runtime.baileysSendImage(to, u, cap);
        } else {
          console.log(`vendor ${vendorId}: send image ${i + 1}/${urls.length} capLen=0`);
          await runtime.baileysSendImage(to, u);
        }
        sent++;
      } catch (e: unknown) {
        failed++;
        const msg = e instanceof Error ? e.message : "Send failed.";
        emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      }
      await new Promise((r) => setTimeout(r, urls.length > 1 ? 1200 : 900));
    }

    if (cap) {
      await pushOutbound(runtime, to, cap);
    }

    return { ok: failed === 0, sent, failed };
  });
}

export async function sendVendorMedia(
  vendorId: string,
  to: string,
  imageUrls: string[] | null | undefined,
  videoUrls: string[] | null | undefined,
  caption?: string
) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    const imgs = (Array.isArray(imageUrls) ? imageUrls : [])
      .filter((x) => typeof x === "string")
      .map((x) => String(x).trim())
      .filter((x) => x !== "")
      .slice(0, 10);

    const vids = (Array.isArray(videoUrls) ? videoUrls : [])
      .filter((x) => typeof x === "string")
      .map((x) => String(x).trim())
      .filter((x) => x !== "")
      .slice(0, 4);

    const sendImage = runtime.baileysSendImage;
    const sendVideo = runtime.baileysSendVideo;
    if (imgs.length && !sendImage) throw new Error("WhatsApp runtime not ready.");
    if (vids.length && !sendVideo) throw new Error("WhatsApp runtime not ready.");

    const cap = typeof caption === "string" ? caption : "";

    let imagesSent = 0;
    let imagesFailed = 0;
    let videosSent = 0;
    let videosFailed = 0;

    for (let i = 0; i < imgs.length; i++) {
      const u = imgs[i]!;
      try {
        if (i === 0) {
          const len = cap.trim() ? cap.length : 0;
          console.log(`vendor ${vendorId}: send image ${i + 1}/${imgs.length} capLen=${len}`);
          await sendImage!(to, u, cap);
        } else {
          console.log(`vendor ${vendorId}: send image ${i + 1}/${imgs.length} capLen=0`);
          await sendImage!(to, u);
        }
        imagesSent++;
      } catch (e: unknown) {
        imagesFailed++;
        const msg = e instanceof Error ? e.message : "Send failed.";
        emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      }
      await new Promise((r) => setTimeout(r, imgs.length > 1 ? 1200 : 900));
    }

    for (let i = 0; i < vids.length; i++) {
      const u = vids[i]!;
      const capForThis = imgs.length === 0 && i === 0 ? cap : "";
      try {
        console.log(`vendor ${vendorId}: send video ${i + 1}/${vids.length} capLen=${capForThis.trim() ? capForThis.length : 0}`);
        await sendVideo!(to, u, capForThis);
        videosSent++;
      } catch (e: unknown) {
        videosFailed++;
        const msg = e instanceof Error ? e.message : "Send failed.";
        emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
        try {
          if (runtime.baileysSend) {
            await runtime.baileysSend(to, `Video: ${u}`);
          }
        } catch {
        }
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    if (cap) {
      await pushOutbound(runtime, to, cap);
    }

    return {
      ok: imagesFailed === 0 && videosFailed === 0,
      images: { sent: imagesSent, failed: imagesFailed },
      videos: { sent: videosSent, failed: videosFailed },
    };
  });
}

export async function sendVendorVideo(vendorId: string, to: string, videoUrl: string, caption?: string) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    if (!runtime.baileysSendVideo) throw new Error("WhatsApp runtime not ready.");
    const cap = typeof caption === "string" ? caption : "";
    try {
      console.log(`vendor ${vendorId}: send video capLen=${cap.trim() ? cap.length : 0}`);
      await runtime.baileysSendVideo(to, videoUrl, cap);
      await new Promise((r) => setTimeout(r, 1200));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Send failed.";
      emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
      try {
        if (runtime.baileysSend) {
          await runtime.baileysSend(to, `Video: ${videoUrl}`);
        }
      } catch {
      }
      return { ok: false, message: msg };
    }
    await pushOutbound(runtime, to, cap);
    return { ok: true };
  });
}

export async function sendVendorBroadcast(
  vendorId: string,
  recipients: string[],
  payload: {
    text: string;
    delaySeconds?: number;
    mentionAll?: boolean;
    productCards?: unknown;
    buttons?: unknown;
  }
) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    const list = Array.isArray(recipients) ? recipients.map((x) => x.trim()).filter((x) => x !== "") : [];
    const mentionAll = payload.mentionAll === true;
    const baseMsg = typeof payload.text === "string" ? payload.text : "";
    const msg = mentionAll ? `@all\n\n${baseMsg}` : baseMsg;
    if (!msg.trim()) return { ok: false, sent: 0, failed: 0, results: [] as Array<{ to: string; ok: boolean; error?: string }> };

    const delaySecondsRaw = typeof payload.delaySeconds === "number" && Number.isFinite(payload.delaySeconds) ? payload.delaySeconds : 0;
    const delay = Math.max(0, Math.min(600_000, Math.floor(delaySecondsRaw * 1000)));

    const productCardsRaw = payload.productCards && typeof payload.productCards === "object" ? (payload.productCards as Record<string, unknown>) : null;
    const cardsRaw = Array.isArray(productCardsRaw?.cards) ? (productCardsRaw?.cards as unknown[]) : [];
    const cards = cardsRaw
      .filter((c) => c && typeof c === "object")
      .map((c) => c as Record<string, unknown>)
      .map((c) => ({
        image_url: typeof c.image_url === "string" ? c.image_url.trim() : "",
        body:
          typeof c.body === "string"
            ? c.body.trim()
            : (typeof c.title === "string" ? c.title.trim() : ""),
        footer: typeof c.footer === "string" ? c.footer.trim() : "",
        url:
          typeof c.url === "string"
            ? c.url.trim()
            : (typeof c.link_url === "string" ? c.link_url.trim() : ""),
        buttons: Array.isArray(c.buttons)
          ? (c.buttons as unknown[])
              .filter((b) => b && typeof b === "object")
              .map((b) => b as Record<string, unknown>)
              .map((b) => ({
                text: typeof b.text === "string" ? b.text.trim() : "",
                url: typeof b.url === "string" ? b.url.trim() : "",
              }))
              .filter((b) => b.text && b.url)
              .slice(0, 24)
          : [],
      }))
      .filter((c) => c.image_url && c.body)
      .slice(0, 10);
    const bodyText = typeof productCardsRaw?.body_text === "string" ? String(productCardsRaw.body_text).trim() : "";
    const footerText = typeof productCardsRaw?.footer_text === "string" ? String(productCardsRaw.footer_text).trim() : "";
    const fallbackText = typeof productCardsRaw?.fallback_text === "string" ? String(productCardsRaw.fallback_text).trim() : "";
    const buttonText = typeof productCardsRaw?.button_text === "string" ? String(productCardsRaw.button_text).trim() : "";
    const hasCards = cards.length > 0;

    const buttonsRaw = Array.isArray(payload.buttons) ? (payload.buttons as unknown[]) : [];
    const buttons = buttonsRaw
      .filter((b) => b && typeof b === "object")
      .map((b) => b as Record<string, unknown>)
      .map((b) => ({
        text: typeof b.text === "string" ? b.text.trim() : "",
        url: typeof b.url === "string" ? b.url.trim() : "",
      }))
      .filter((b) => b.text && b.url)
      .slice(0, 30);

    const chunk3 = <T,>(arr: T[]) => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += 3) out.push(arr.slice(i, i + 3));
      return out;
    };

    const results: Array<{ to: string; ok: boolean; error?: string }> = [];

    for (const to of list) {
      let ok = true;
      let err: string | undefined = undefined;
      try {
        const isGroup = to.endsWith("@g.us");
        const linkChunks = buttons.length ? chunk3(buttons) : [];

        if (isGroup && linkChunks.length && runtime.baileysSendGroupCtaLinks) {
          await runtime.baileysSendGroupCtaLinks(to, msg, "", linkChunks[0]!);
          await pushOutbound(runtime, to, msg);
          if (linkChunks.length > 1) {
            for (let i = 1; i < linkChunks.length; i++) {
              await runtime.baileysSendGroupCtaLinks(to, "More links", "", linkChunks[i]!);
              await new Promise((r) => setTimeout(r, 150));
            }
          }
        } else if (runtime.baileysSend) {
          await runtime.baileysSend(to, msg);
          await pushOutbound(runtime, to, msg);
        } else {
          throw new Error("WhatsApp runtime not ready.");
        }

        if (hasCards && isGroup && runtime.baileysSendGroupProductImages) {
          await runtime.baileysSendGroupProductImages(to, "", "", cards as any, buttonText || undefined);
          if (fallbackText && fallbackText !== msg) {
            await pushOutbound(runtime, to, fallbackText);
          }
        } else if (hasCards && runtime.baileysSend) {
          await runtime.baileysSend(to, fallbackText || msg);
          if (fallbackText && fallbackText !== msg) {
            await pushOutbound(runtime, to, fallbackText);
          }
        }
      } catch (e: unknown) {
        ok = false;
        err = e instanceof Error ? e.message : "Send failed.";
        emit(runtime, { type: "error", message: err } satisfies VendorEvent);
        try {
          await pushOutbound(runtime, to, hasCards ? (fallbackText || msg) : msg);
        } catch {
          void 0;
        }
      }
      results.push({ to, ok, error: err });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    return { ok: failed === 0, sent, failed, results };
  });
}

export async function listVendorMessages(vendorId: string) {
  const runtime = await startVendorRuntime(vendorId);
  return runtime.messages;
}

export async function generatePairingCode(vendorId: string, phone: string) {
  const existing = runtimes.get(vendorId);
  if (existing?.status === "connected") {
    throw new Error("Already connected. Disconnect or reset first.");
  }
  const runtime = existing?.status === "disconnected" ? await restartVendorRuntime(vendorId) : await startVendorRuntime(vendorId);
  const at = new Date().toISOString();
  if (runtime.mode === "baileys" && runtime.baileysPair) {
    try {
      const cleaned = cleanPairingPhone(phone);
      if (!cleaned) throw new Error("Invalid phone number.");
      const code = await runtime.baileysPair(cleaned);
      emit(runtime, { type: "pairing_code", phone: cleaned, code, at } satisfies VendorEvent);
      return { ok: true, code };
    } catch (e: unknown) {
      emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Pairing failed." } satisfies VendorEvent);
    }
  }
  throw new Error(runtime.lastError ? `Pairing unavailable: ${runtime.lastError}` : "Pairing unavailable: WhatsApp runtime not ready.");
}

export async function updateVendorConfig(vendorId: string, patch: Partial<VendorConfig>) {
  const runtime = await startVendorRuntime(vendorId);
  const next: VendorConfig = {
    strategyMode: patch.strategyMode ?? runtime.config.strategyMode,
    escalationKeywords: Array.isArray(patch.escalationKeywords) ? patch.escalationKeywords : runtime.config.escalationKeywords,
  };
  runtime.config = next;
  try {
    await saveVendorConfig(vendorId, next);
  } catch {
    void 0;
  }
  emit(runtime, { type: "config_updated", config: next, at: new Date().toISOString() } satisfies VendorEvent);
  return { ok: true, config: next };
}

export async function setGroupLock(vendorId: string, name: string, locked: boolean) {
  const runtime = await startVendorRuntime(vendorId);
  const key = name.trim();
  if (!key) return { ok: false };
  if (!runtime.baileysSetGroupLocked) return { ok: false };
  if (!key.endsWith("@g.us")) return { ok: false };
  try {
    await runtime.baileysSetGroupLocked(key, locked);
  } catch (e: unknown) {
    emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Group lock failed." } satisfies VendorEvent);
    return { ok: false };
  }
  const prev = runtime.groups.get(key);
  const display = prev?.name ?? key;
  runtime.groups.set(key, { name: display, locked, participantsCount: prev?.participantsCount ?? 0 });
  emit(runtime, { type: "group_locked", name: display, locked, at: new Date().toISOString() } satisfies VendorEvent);
  return { ok: true };
}

export async function setGroupLockBulk(
  vendorId: string,
  targets: string[],
  locked: boolean,
  delaySeconds?: number,
  unlockAfterSeconds?: number
) {
  return await enqueueSend(vendorId, async () => {
    const runtime = await startVendorRuntime(vendorId);
    const list = Array.isArray(targets) ? targets.map((x) => String(x).trim()).filter((x) => x.endsWith("@g.us")) : [];
    const delaySecondsRaw = typeof delaySeconds === "number" && Number.isFinite(delaySeconds) ? delaySeconds : 0;
    const delay = Math.max(0, Math.min(600_000, Math.floor(delaySecondsRaw * 1000)));
    const unlockAfter =
      typeof unlockAfterSeconds === "number" && Number.isFinite(unlockAfterSeconds)
        ? Math.max(0, Math.min(60 * 60, Math.floor(unlockAfterSeconds)))
        : 0;

    const results: Array<{ to: string; ok: boolean; error?: string }> = [];
    for (const id of list) {
      let ok = true;
      let err: string | undefined = undefined;
      try {
        await setGroupLock(vendorId, id, locked);
        if (locked && unlockAfter > 0) {
          const handle = setTimeout(() => {
            void setGroupLock(vendorId, id, false);
          }, unlockAfter * 1000);
          runtime.unlockTimers.push(handle);
        }
      } catch (e: unknown) {
        ok = false;
        err = e instanceof Error ? e.message : "Group lock failed.";
      }
      results.push({ to: id, ok, error: err });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    return { ok: failed === 0, sent, failed, results };
  });
}

export async function dropGroup(vendorId: string, name: string) {
  const runtime = await startVendorRuntime(vendorId);
  const key = name.trim();
  if (!key) return { ok: false };
  if (!runtime.baileysLeaveGroup) return { ok: false };
  if (!key.endsWith("@g.us")) return { ok: false };
  try {
    await runtime.baileysLeaveGroup(key);
  } catch (e: unknown) {
    emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Leave group failed." } satisfies VendorEvent);
    return { ok: false };
  }
  const display = runtime.groups.get(key)?.name ?? key;
  runtime.groups.delete(key);
  emit(runtime, { type: "group_dropped", name: display, at: new Date().toISOString() } satisfies VendorEvent);
  return { ok: true };
}

export async function postDrop(
  vendorId: string,
  payload: {
    channel: "group" | "status";
    targets: string[];
    text: string;
    lockBefore?: boolean;
    unlockAfterSeconds?: number;
    delaySeconds?: number;
    mediaUrl?: string;
    mediaUrls?: string[];
    mentionAll?: boolean;
    meta?: unknown;
    productCards?: unknown;
  }
) {
  return await enqueueSend(vendorId, async () => {
  const runtime = await startVendorRuntime(vendorId);
  const describeError = (e: unknown) => {
    const base = e instanceof Error ? e.message : e ? String(e) : "";
    if (base && base !== "[object Object]" && !base.toLowerCase().includes("object object")) return base;
    try {
      const json = JSON.stringify(e);
      return json && json !== "{}" ? json : (base || "Unknown error.");
    } catch {
      return base || "Unknown error.";
    }
  };
  const channel = payload.channel;
  const targets = Array.isArray(payload.targets) ? payload.targets.filter((t) => typeof t === "string" && t.trim() !== "") : [];
  const text = typeof payload.text === "string" ? payload.text : "";
  const mediaUrl = typeof payload.mediaUrl === "string" ? payload.mediaUrl.trim() : "";
  const mediaUrls = [
    ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
    ...(mediaUrl ? [mediaUrl] : []),
  ]
    .filter((x) => typeof x === "string")
    .map((x) => String(x).trim())
    .filter((x) => x !== "")
    .slice(0, 10);
  const meta = payload.meta && typeof payload.meta === "object" ? (payload.meta as Record<string, unknown>) : undefined;
  const productCardsRaw = payload.productCards && typeof payload.productCards === "object" ? (payload.productCards as Record<string, unknown>) : null;
  const cardsRaw = Array.isArray(productCardsRaw?.cards) ? (productCardsRaw?.cards as unknown[]) : [];
  const cards = cardsRaw
    .filter((c) => c && typeof c === "object")
    .map((c) => c as Record<string, unknown>)
    .map((c) => ({
      product_id: typeof c.product_id === "number" ? (c.product_id as number) : undefined,
      image_url: typeof c.image_url === "string" ? c.image_url.trim() : "",
      body: typeof c.body === "string" ? c.body.trim() : "",
      footer: typeof c.footer === "string" ? c.footer.trim() : "",
      url: typeof c.url === "string" ? c.url.trim() : "",
    }))
    .filter((c) => c.image_url && c.body)
    .slice(0, 10);
  const bodyText = typeof productCardsRaw?.body_text === "string" ? String(productCardsRaw.body_text).trim() : "";
  const footerText = typeof productCardsRaw?.footer_text === "string" ? String(productCardsRaw.footer_text).trim() : "";
  const fallbackText = typeof productCardsRaw?.fallback_text === "string" ? String(productCardsRaw.fallback_text).trim() : "";
  const buttonText = typeof productCardsRaw?.button_text === "string" ? String(productCardsRaw.button_text).trim() : "";
  if (!text.trim()) return { ok: false };
  const isVideoUrl = (u: string) => {
    const s = (u ?? "").toLowerCase();
    return s.includes(".mp4") || s.includes(".webm") || s.includes(".mov") || s.includes(".m4v") || s.includes(".3gp");
  };

  if (channel === "status") {
    const statusTargets = targets;
    const statusMessageIds: string[] = [];
    let statusError: string | null = null;
    if (runtime.mode === "baileys") {
      try {
        if (!mediaUrls.length && runtime.baileysSendStatusText) {
          const id = await runtime.baileysSendStatusText(text, statusTargets);
          if (id) statusMessageIds.push(id);
        } else if (mediaUrls.length > 1 && runtime.baileysSendStatusAlbum) {
          const id = await runtime.baileysSendStatusAlbum(mediaUrls, text, statusTargets);
          if (id) {
            statusMessageIds.push(id);
            void forwardStatusPostToApi(vendorId, { message_id: id, text, media_url: mediaUrls[0] ?? undefined, meta });
          }
        } else {
          for (let i = 0; i < mediaUrls.length; i++) {
            const u = mediaUrls[i]!;
            const cap = i === 0 ? text : "";
            const id = isVideoUrl(u)
              ? (runtime.baileysSendStatusVideo ? await runtime.baileysSendStatusVideo(u, cap, statusTargets) : null)
              : (runtime.baileysSendStatusImage ? await runtime.baileysSendStatusImage(u, cap, statusTargets) : null);
            if (id) {
              statusMessageIds.push(id);
              void forwardStatusPostToApi(vendorId, { message_id: id, text: cap || undefined, media_url: u, meta });
            }
          }
        }
      } catch (e: unknown) {
        statusError = e instanceof Error ? e.message : "Status post failed.";
        emit(runtime, { type: "error", message: statusError } satisfies VendorEvent);
      }
    }
    if (!statusMessageIds.length) {
      return { ok: false, message: statusError ?? "Status post failed." };
    }
    if (statusMessageIds.length === 1 && !mediaUrls.length) {
      void forwardStatusPostToApi(vendorId, { message_id: statusMessageIds[0]!, text, meta });
    }
    await pushOutbound(runtime, "status", text);
  } else {
    const lockBefore = payload.lockBefore === true;
    const unlockAfterSeconds =
      typeof payload.unlockAfterSeconds === "number" && Number.isFinite(payload.unlockAfterSeconds)
        ? Math.max(0, Math.min(60 * 60, Math.floor(payload.unlockAfterSeconds)))
        : 0;
    const delaySecondsRaw = typeof payload.delaySeconds === "number" && Number.isFinite(payload.delaySeconds) ? payload.delaySeconds : 0;
    const delay = Math.max(0, Math.min(600_000, Math.floor(delaySecondsRaw * 1000)));
    const groupErrors: string[] = [];
    let groupPosted = 0;
    const forwardToStatus = typeof buttonText === "string" && /forward\s*to\s*status/i.test(buttonText);
    const mentionAll = payload.mentionAll === true;
    const hasCards = cards.length > 0;
    const canProductImages = hasCards && typeof runtime.baileysSendGroupProductImages === "function";
    const canCardImages = hasCards && typeof runtime.baileysSendGroupImage === "function";
    const canText = typeof runtime.baileysSendGroupText === "function";
    const canMedia = typeof runtime.baileysSendGroupImage === "function";
    if (hasCards && !canProductImages && !canCardImages) {
      return { ok: false, message: "Product cards are unavailable for group drops." };
    }
    if (!hasCards && !canText && !(mediaUrls.length && canMedia)) {
      return { ok: false, message: "Group send is unavailable." };
    }

    if (lockBefore) {
      for (const t of targets) {
        const target = t.trim();
        if (!target) continue;
        await setGroupLock(vendorId, target, true);
      }
    }

    for (const t of targets) {
      const target = t.trim();
      if (!target) continue;
      if (runtime.mode === "baileys" && target.endsWith("@g.us")) {
        try {
          if (hasCards) {
            if (canProductImages) {
              const dropId = await runtime.baileysSendGroupProductImages!(target, bodyText || text, footerText, cards, buttonText);
              if (dropId) rememberDropReply(runtime, dropId, target, meta);
            } else if (canCardImages) {
              let dropId: string | null = null;
              for (const card of cards) {
                const capParts: string[] = [];
                if (card.body) capParts.push(card.body);
                if (card.footer) capParts.push(card.footer);
                if (forwardToStatus) capParts.push("Forward this image to your Status");
                const cap = capParts.join("\n\n").trim();
                const id = await runtime.baileysSendGroupImage!(target, card.image_url, cap);
                if (!dropId && id) dropId = id;
              }
              if (dropId) rememberDropReply(runtime, dropId, target, meta);
            }
          } else {
            let mentions: string[] = [];
            if (mentionAll && runtime.baileysGroupMentions) {
              try {
                mentions = await runtime.baileysGroupMentions(target);
              } catch {
                mentions = [];
              }
            }

            let dropId: string | null = null;
            if (mediaUrls.length && canMedia) {
              let sentText = false;
              if (canText && mentions.length) {
                dropId = await runtime.baileysSendGroupText!(target, text, mentions);
                sentText = true;
              }
              for (let i = 0; i < mediaUrls.length; i++) {
                const u = mediaUrls[i]!;
                if (isVideoUrl(u)) throw new Error("Group video drops are not supported.");
                const cap = !sentText && i === 0 ? text : "";
                const id = await runtime.baileysSendGroupImage!(target, u, cap);
                if (!dropId && id) dropId = id;
              }
            } else if (canText) {
              dropId = await runtime.baileysSendGroupText!(target, text, mentions.length ? mentions : undefined);
            } else {
              throw new Error("Group send unavailable.");
            }

            if (dropId) rememberDropReply(runtime, dropId, target, meta);
          }
          groupPosted++;
          await pushOutbound(runtime, `group:${target}`, fallbackText || text);
        } catch (e: unknown) {
          let recovered = false;
          if (hasCards && canCardImages) {
            try {
              for (const card of cards) {
                const capParts: string[] = [];
                if (card.body) capParts.push(card.body);
                if (card.footer) capParts.push(card.footer);
                if (forwardToStatus) capParts.push("Forward this image to your Status");
                const cap = capParts.join("\n\n").trim();
                await runtime.baileysSendGroupImage!(target, card.image_url, cap);
              }
              groupPosted++;
              await pushOutbound(runtime, `group:${target}`, fallbackText || text);
              recovered = true;
            } catch (e2: unknown) {
              const msg2 = e2 instanceof Error ? e2.message : "Drop send failed.";
              groupErrors.push(`${target}: ${msg2}`);
              emit(runtime, { type: "error", message: msg2 } satisfies VendorEvent);
              recovered = true;
            }
          }
          if (!recovered) {
            const msg = e instanceof Error ? e.message : "Drop send failed.";
            groupErrors.push(`${target}: ${msg}`);
            emit(runtime, { type: "error", message: msg } satisfies VendorEvent);
          }
        }
      }

      if (lockBefore && unlockAfterSeconds > 0) {
        const handle = setTimeout(() => {
          void setGroupLock(vendorId, target, false);
        }, unlockAfterSeconds * 1000);
        runtime.unlockTimers.push(handle);
      }

      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    if (groupErrors.length) {
      return {
        ok: false,
        message:
          groupPosted > 0
            ? `Drop partially failed (${groupPosted} posted, ${groupErrors.length} failed). First error: ${groupErrors[0]}`
            : `Drop failed. First error: ${groupErrors[0]}`,
      };
    }
  }

  emit(runtime, {
    type: "drop_posted",
    channel,
    targets: channel === "status" ? ["status"] : targets,
    text,
    at: new Date().toISOString(),
  } satisfies VendorEvent);
  return { ok: true };
  });
}

export async function listVendorGroups(vendorId: string) {
  const runtime = await startVendorRuntime(vendorId);
  if (!runtime.baileysListGroups) return { ok: false, mode: "baileys" as const, groups: [] as BaileysGroup[] };
  try {
    const groups = await runtime.baileysListGroups();
    for (const g of groups) {
      const prev = runtime.groups.get(g.id);
      runtime.groups.set(g.id, { name: g.name, locked: prev?.locked ?? false, participantsCount: g.participantsCount });
    }
    return { ok: true, mode: "baileys" as const, groups };
  } catch (e: unknown) {
    emit(runtime, { type: "error", message: e instanceof Error ? e.message : "List groups failed." } satisfies VendorEvent);
    return { ok: false, mode: "baileys" as const, groups: [] as BaileysGroup[] };
  }
}
