import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBaileysRuntime } from "./baileysRuntime.js";
import { fetchProductsForVendor, fetchVendorBotConfig } from "./ellbot.js";
const runtimes = new Map();
const startingRuntimes = new Map();
const backoff = new Map();
const sendQueue = new Map();
function getBackoff(vendorId) {
    const existing = backoff.get(vendorId);
    if (existing)
        return existing;
    const next = { restartAttempt: 0, resetAttempt: 0 };
    backoff.set(vendorId, next);
    return next;
}
function enqueueSend(vendorId, fn) {
    const prev = sendQueue.get(vendorId) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(fn);
    sendQueue.set(vendorId, next);
    void next.finally(() => {
        if (sendQueue.get(vendorId) === next)
            sendQueue.delete(vendorId);
    });
    return next;
}
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function resolveDataDir(raw, fallback) {
    const v = (raw ?? "").trim() || fallback;
    return path.isAbsolute(v) ? v : path.resolve(PKG_ROOT, v);
}
function sessionDirForVendor(vendorId) {
    const sessionsRoot = resolveDataDir(process.env.SESSIONS_DIR, "./sessions");
    return path.join(sessionsRoot, `vendor_id_${vendorId}`);
}
function configPathForVendor(vendorId) {
    const root = resolveDataDir(process.env.VENDOR_CONFIG_DIR, "./vendor-config");
    return path.join(root, `vendor_id_${vendorId}.json`);
}
function apiBase() {
    const raw = (process.env.API_SERVER_BASE_URL ?? "http://127.0.0.1:8000/api").trim().replace(/\/$/, "");
    if (!raw)
        return raw;
    if (/\/api(\/|$)/.test(raw))
        return raw;
    return `${raw}/api`;
}
async function loadVendorConfig(vendorId) {
    const p = configPathForVendor(vendorId);
    try {
        const raw = await readFile(p, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object")
            return defaultConfig();
        const obj = parsed;
        const escalationKeywords = Array.isArray(obj["escalationKeywords"])
            ? obj["escalationKeywords"].filter((x) => typeof x === "string").map((x) => x.slice(0, 60))
            : defaultConfig().escalationKeywords;
        return { strategyMode: "ai_lead", escalationKeywords };
    }
    catch {
        return defaultConfig();
    }
}
async function saveVendorConfig(vendorId, config) {
    const p = configPathForVendor(vendorId);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(config), "utf8");
}
async function forwardInboundToApi(vendorId, payload) {
    const base = apiBase();
    const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
    if (!base)
        return;
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
            if (runtime)
                emit(runtime, { type: "error", message: msg });
            else
                process.stdout.write(`${msg}\n`);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "API inbound error.";
        const runtime = runtimes.get(vendorId);
        if (runtime)
            emit(runtime, { type: "error", message: `API inbound error: ${msg}` });
        else
            process.stdout.write(`API inbound error: ${msg}\n`);
    }
}
async function forwardBotStatusToApi(vendorId, status) {
    const base = apiBase();
    const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
    if (!base)
        return;
    try {
        const url = `${base.replace(/\/$/, "")}/internal/bot/status/${encodeURIComponent(vendorId)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(secret ? { "x-bot-secret": secret } : {}),
            },
            body: JSON.stringify({ status }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
    }
    catch {
        void 0;
    }
}
async function logMessageToApi(vendorId, payload) {
    const base = apiBase();
    const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
    if (!base)
        return;
    const peer = (payload.peer ?? "").trim();
    const text = (payload.text ?? "").trim();
    if (!peer || !text)
        return;
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
            if (runtime)
                emit(runtime, { type: "error", message: msg });
            else
                process.stdout.write(`${msg}\n`);
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "API log-message error.";
        const runtime = runtimes.get(vendorId);
        if (runtime)
            emit(runtime, { type: "error", message: `API log-message error: ${msg}` });
        else
            process.stdout.write(`API log-message error: ${msg}\n`);
    }
}
async function forwardStatusPostToApi(vendorId, payload) {
    const base = apiBase();
    const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
    if (!base)
        return;
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
            if (runtime)
                emit(runtime, { type: "error", message: msg });
            else
                process.stdout.write(`${msg}\n`);
        }
    }
    catch {
        void 0;
    }
}
function isBaileysEnabled() {
    const v = (process.env.BAILEYS_ENABLED ?? "").trim();
    return v === "1" || v.toLowerCase() === "true";
}
export function getRuntime(vendorId) {
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
function emit(runtime, event) {
    if (event.type === "status") {
        runtime.status = event.status;
        void forwardBotStatusToApi(runtime.vendorId, event.status);
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
        }
        else if (runtime.status !== "connected" && isBadSessionError(event.message)) {
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
function isBadSessionError(msg) {
    const m = (msg ?? "").toLowerCase();
    if (!m)
        return false;
    return (m.includes("bad mac") ||
        m.includes("restart required") ||
        m.includes("logged out") ||
        m.includes("code 515") ||
        m.includes("status code 515") ||
        m.includes("statuscode 515"));
}
function isConflictError(msg) {
    const m = (msg ?? "").toLowerCase();
    if (!m)
        return false;
    return m.includes("stream errored (conflict)") || m.includes("(conflict)") || m.includes("code 440") || m.includes("status code 440");
}
function defaultConfig() {
    return {
        strategyMode: "ai_lead",
        escalationKeywords: ["agent", "human", "support", "help"],
    };
}
function includesKeyword(text, keywords) {
    const hay = text.toLowerCase();
    for (const k of keywords) {
        const kk = k.trim().toLowerCase();
        if (!kk)
            continue;
        if (hay.includes(kk))
            return true;
    }
    return false;
}
function cleanPairingPhone(raw) {
    return String(raw ?? "")
        .trim()
        .replace(/[^\d]/g, "")
        .slice(0, 20);
}
async function pushOutbound(runtime, to, text) {
    const msg = {
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
    });
}
function rememberDropReply(runtime, messageId, groupId, meta) {
    const id = (messageId ?? "").trim();
    if (!id)
        return;
    const group = (groupId ?? "").trim();
    if (!group || !group.endsWith("@g.us"))
        return;
    const rawIds = meta?.product_ids;
    const rawId = meta?.product_id;
    const scheduleIdRaw = meta?.schedule_id;
    const productIds = Array.isArray(rawIds) ? rawIds.filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0).map((x) => Math.floor(x)) : [];
    if (typeof rawId === "number" && Number.isFinite(rawId) && rawId > 0)
        productIds.push(Math.floor(rawId));
    const uniq = Array.from(new Set(productIds)).slice(0, 25);
    const scheduleId = typeof scheduleIdRaw === "number" && Number.isFinite(scheduleIdRaw) ? Math.floor(scheduleIdRaw) : undefined;
    runtime.dropReplyMap.set(id, { groupId: group, productIds: uniq, scheduleId, at: Date.now() });
    while (runtime.dropReplyMap.size > 500) {
        const first = runtime.dropReplyMap.keys().next();
        if (!first.done && first.value)
            runtime.dropReplyMap.delete(first.value);
        else
            break;
    }
}
export async function startVendorRuntime(vendorId) {
    const existing = runtimes.get(vendorId);
    if (existing)
        return existing;
    const inflight = startingRuntimes.get(vendorId);
    if (inflight)
        return await inflight;
    const p = (async () => {
        if (!isBaileysEnabled()) {
            throw new Error("Baileys is required. Set BAILEYS_ENABLED=true.");
        }
        const sessionDir = sessionDirForVendor(vendorId);
        await mkdir(sessionDir, { recursive: true });
        const emitter = new EventEmitter();
        emitter.setMaxListeners(50);
        let stopBaileys = null;
        const persistedConfig = await loadVendorConfig(vendorId);
        const runtime = {
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
                    for (const t of runtime.unlockTimers)
                        clearTimeout(t);
                    if (runtime.restartTimer)
                        clearTimeout(runtime.restartTimer);
                    if (runtime.resetTimer)
                        clearTimeout(runtime.resetTimer);
                    if (stopBaileys)
                        await stopBaileys();
                }
                finally {
                    runtimes.delete(vendorId);
                }
            },
        };
        emit(runtime, { type: "status", status: "connecting" });
        try {
            const br = await startBaileysRuntime(vendorId, sessionDir, {
                onStatus: (status) => emit(runtime, { type: "status", status }),
                onQr: (qr) => emit(runtime, { type: "qr", qr }),
                onRegistered: (registered) => {
                    runtime.registered = registered;
                },
                onInboundMessage: ({ id, from, participant, pushName, text, at, quotedMessageId, quotedRemoteJid, isStatusReply, mentionedJids, mentionsMe }) => {
                    runtime.messages.unshift({ id, dir: "in", peer: from, text, at });
                    emit(runtime, { type: "message_received", id, from, pushName, text, at });
                    void (async () => {
                        const groupId = (from ?? "").trim();
                        const sender = (participant ?? "").trim();
                        const quoted = (quotedMessageId ?? "").trim();
                        if (!groupId.endsWith("@g.us") || !sender || !quoted)
                            return;
                        const hit = runtime.dropReplyMap.get(quoted);
                        if (!hit)
                            return;
                        const firstProductId = Array.isArray(hit.productIds) && hit.productIds.length ? hit.productIds[0] : null;
                        const handle = sender.split("@")[0] ?? sender;
                        const dmKeyword = firstProductId ? `BUY ${firstProductId}` : "BUY";
                        let storeName = "Our Store";
                        try {
                            const cfg = await fetchVendorBotConfig(vendorId);
                            storeName = (cfg?.whatsappBotBrain?.storeName ?? cfg?.vendor?.name ?? "Our Store").trim() || "Our Store";
                        }
                        catch {
                            void 0;
                        }
                        const groupText = `@${handle} To continue, send me a DM with: "${dmKeyword}"`;
                        try {
                            if (runtime.baileysSendGroupText)
                                await runtime.baileysSendGroupText(groupId, groupText, [sender]);
                        }
                        catch {
                            void 0;
                        }
                        try {
                            if (runtime.baileysSendGroupCtaCard)
                                await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, dmKeyword, "Continue in DM");
                        }
                        catch {
                            void 0;
                        }
                    })();
                    void (async () => {
                        const groupId = (from ?? "").trim();
                        const sender = (participant ?? "").trim();
                        if (!groupId.endsWith("@g.us") || !sender)
                            return;
                        let cfg = null;
                        try {
                            cfg = await fetchVendorBotConfig(vendorId);
                        }
                        catch (e) {
                            return;
                        }
                        const gs = cfg?.whatsappGroupSettings ?? null;
                        if (!gs?.enabled)
                            return;
                        const tagOnly = typeof gs.tagOnly === "boolean" ? gs.tagOnly : true;
                        const tagBack = typeof gs.tagBack === "boolean" ? gs.tagBack : true;
                        if (tagOnly) {
                            const hasAnyMention = Array.isArray(mentionedJids) && mentionedJids.some((j) => typeof j === "string" && j.trim());
                            if (!mentionsMe && !hasAnyMention)
                                return;
                        }
                        const storeName = (cfg?.whatsappBotBrain?.storeName ?? cfg?.vendor?.name ?? "Our Store").trim() || "Our Store";
                        const handle = sender.split("@")[0] ?? sender;
                        const cleaned = String(text ?? "")
                            .replace(/@\S+/g, " ")
                            .replace(/\s+/g, " ")
                            .trim();
                        const mentionText = tagBack ? `@${handle} ` : "";
                        const mentions = tagBack ? [sender] : undefined;
                        const searchMode = typeof gs?.searchMode === "string" ? String(gs.searchMode).trim() : "dm_cta";
                        const askDmOnly = searchMode === "ask_dm";
                        if (searchMode === "dm_cta") {
                            try {
                                if (tagBack && runtime.baileysSendGroupText)
                                    await runtime.baileysSendGroupText(groupId, `${mentionText}Tap below to continue in DM.`, mentions);
                            }
                            catch (e) {
                                void e;
                            }
                            if (runtime.baileysSendGroupCtaCard) {
                                try {
                                    const prefill = cleaned || "Menu";
                                    await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, prefill, "Continue in DM");
                                }
                                catch (e) {
                                    void e;
                                }
                            }
                            else {
                                try {
                                    if (runtime.baileysSendGroupText)
                                        await runtime.baileysSendGroupText(groupId, `${mentionText}Please DM me to continue.`, mentions);
                                }
                                catch (e) {
                                    void e;
                                }
                            }
                            return;
                        }
                        if (!cleaned) {
                            try {
                                if (runtime.baileysSendGroupText)
                                    await runtime.baileysSendGroupText(groupId, `${mentionText}What product are you looking for?`, mentions);
                            }
                            catch {
                                void 0;
                            }
                            return;
                        }
                        function looksLikeProductQuery(input) {
                            const t = input.trim().toLowerCase();
                            if (!t)
                                return false;
                            if (/\b(price|cost|buy|sell|available|availability|how much|show|need|want|looking for|do you have)\b/i.test(t))
                                return true;
                            if (/\b(iphone|samsung|infinix|tecno|itel|pixel|nokia|laptop|macbook|hp|dell|lenovo|charger|earphone|headphone|airpods|router|modem|tv|ps5|xbox)\b/i.test(t))
                                return true;
                            if (/\b\d{2,}\b/.test(t) && /\b(iphone|samsung|infinix|tecno|itel|pixel|nokia|hp|dell|lenovo)\b/i.test(t))
                                return true;
                            return false;
                        }
                        function buildQuickReply(input) {
                            const t = input.trim().toLowerCase();
                            if (!t)
                                return null;
                            const delivery = cfg?.deliveryOptions ?? null;
                            const deliveryNotes = typeof delivery?.notes === "string" ? String(delivery.notes).trim() : "";
                            const deliveryMethods = Array.isArray(delivery?.methods) ? delivery.methods : [];
                            const deliveryMethodsText = deliveryMethods
                                .slice(0, 6)
                                .map((m) => String(m?.name ?? "").trim())
                                .filter((x) => x.length > 0)
                                .join(", ");
                            const shopPhoneRaw = typeof cfg?.whatsappBotBrain?.shopPhone === "string" ? String(cfg.whatsappBotBrain.shopPhone).trim() : "";
                            if (/\b(hi|hello|hey|good\s*morning|good\s*afternoon|good\s*evening)\b/i.test(t)) {
                                return `Hi! What are you looking for?`;
                            }
                            if (/\b(delivery|deliver|shipping|ship|pickup|pick\s*up|location|where\s+are\s+you|where\s+is\s+your\s+shop)\b/i.test(t)) {
                                const parts = [];
                                if (deliveryNotes)
                                    parts.push(deliveryNotes);
                                if (deliveryMethodsText)
                                    parts.push(`Delivery methods: ${deliveryMethodsText}`);
                                if (!parts.length)
                                    return `We offer delivery. Tell me your location and what item you need.`;
                                return parts.join("\n");
                            }
                            if (/\b(payment|pay|momo|mobile\s*money|paystack)\b/i.test(t)) {
                                return `For payment, tell me the item you want and I’ll guide you on the available payment options.`;
                            }
                            if (/\b(call|phone|number|contact)\b/i.test(t) && shopPhoneRaw) {
                                return `Shop contact: ${shopPhoneRaw}`;
                            }
                            return null;
                        }
                        const quick = buildQuickReply(cleaned);
                        if (quick && !looksLikeProductQuery(cleaned)) {
                            try {
                                if (runtime.baileysSendGroupText)
                                    await runtime.baileysSendGroupText(groupId, `${mentionText}${quick}`, mentions);
                            }
                            catch {
                                void 0;
                            }
                            return;
                        }
                        const products = await fetchProductsForVendor(vendorId).catch(() => []);
                        const openKeys = Array.isArray(cfg?.openrouter?.keys)
                            ? cfg.openrouter.keys
                                .filter((x) => typeof x === "string" && x.trim().length > 0)
                                .map((x) => x.trim())
                            : [];
                        const openModelRaw = typeof cfg?.openrouter?.model === "string" ? String(cfg.openrouter.model).trim() : "";
                        const openModel = openModelRaw || "openai/gpt-4o-mini";
                        function storeWebBase() {
                            return (process.env.STORE_WEB_BASE_URL ?? "http://localhost:5173").trim().replace(/\/$/, "");
                        }
                        function parseShowProduct(s) {
                            const m = String(s ?? "")
                                .trim()
                                .match(/^SHOW_PRODUCT:\s*(\d+)/i);
                            if (!m)
                                return null;
                            const id = Number(m[1]);
                            if (!Number.isFinite(id) || id <= 0)
                                return null;
                            return Math.floor(id);
                        }
                        function looksLikeProductList(s) {
                            const t = String(s ?? "").trim();
                            if (!t)
                                return false;
                            if (/^\s*\d+\)\s+/m.test(t))
                                return true;
                            if (/^\s*\d+\.\s+/m.test(t))
                                return true;
                            return false;
                        }
                        async function openRouterSmartReply(input) {
                            if (!openKeys.length || !openModel)
                                return null;
                            const key = openKeys[Math.floor(Math.random() * openKeys.length)];
                            const vendorSlug = typeof cfg?.vendor?.slug === "string" ? String(cfg.vendor.slug).trim() : "";
                            const storeUrl = vendorSlug ? `${storeWebBase()}/shop/store/${encodeURIComponent(vendorSlug)}` : "";
                            const delivery = cfg?.deliveryOptions ?? null;
                            const deliveryNotes = typeof delivery?.notes === "string" ? String(delivery.notes).trim() : "";
                            const deliveryMethods = Array.isArray(delivery?.methods) ? delivery.methods : [];
                            const deliveryText = [
                                deliveryNotes ? deliveryNotes.slice(0, 500) : "",
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
                            const shopPhoneRaw = typeof cfg?.whatsappBotBrain?.shopPhone === "string" ? String(cfg.whatsappBotBrain.shopPhone).trim() : "";
                            const headline = typeof cfg?.vendor?.headline === "string" ? String(cfg.vendor.headline).trim() : "";
                            const catalog = (Array.isArray(products) ? products : [])
                                .slice()
                                .sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0))
                                .slice(0, 20)
                                .map((p) => ({
                                id: Number(p?.id ?? 0),
                                title: String(p?.name ?? "").trim(),
                                subtitle: typeof p?.brand === "string" && p.brand.trim() ? p.brand.trim().slice(0, 120) : null,
                                description: typeof p?.description === "string" && p.description.trim() ? p.description.trim().slice(0, 240) : null,
                                price_cents: Number.isFinite(Number(p?.price)) ? Math.round(Number(p.price) * 100) : null,
                                currency: typeof p?.currency === "string" && p.currency.trim() ? p.currency.trim() : null,
                            }))
                                .filter((p) => Number.isFinite(p.id) && p.id > 0 && typeof p.title === "string" && p.title.trim());
                            const cats = Array.from(new Set((Array.isArray(products) ? products : [])
                                .map((p) => (typeof p?.category === "string" ? p.category.trim() : ""))
                                .filter((x) => x))).slice(0, 20);
                            const system = `You are Sarah, a human WhatsApp sales rep for ${storeName}.\n` +
                                `Keep replies short, natural, and helpful.\n` +
                                `Do not greet repeatedly. Only greet if the customer greets.\n` +
                                `Do not use markdown or asterisks. Plain text only.\n` +
                                `Never mention you are an AI.\n` +
                                `Never invent products, prices, stock, delivery fees, or policies.\n` +
                                `If the customer asks what is available, show up to 7 options in this format:\n` +
                                `1) <name> — <currency> <price>\n` +
                                `2) ...\n` +
                                `Do not include product IDs in lists.\n` +
                                `If the customer expresses interest in a specific item (e.g. 'I want iPhone 17'), reply strictly with: SHOW_PRODUCT: <id>\n` +
                                `Do not ask for delivery selection unless the customer asks about delivery.\n` +
                                (storeUrl ? `Store URL (share only if asked): ${storeUrl}\n` : "") +
                                (headline ? `Vendor headline: ${headline}\n` : "") +
                                (shopPhoneRaw ? `Support phone: ${shopPhoneRaw}\n` : "") +
                                (deliveryText ? `Delivery options (only mention if asked):\n${deliveryText}\n` : "") +
                                (cats.length ? `Available categories:\n${cats.join(", ")}\n` : "") +
                                `Catalog JSON:\n` +
                                JSON.stringify(catalog);
                            const controller = new AbortController();
                            const timeout = setTimeout(() => controller.abort(), 12_000);
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
                                        temperature: 0.4,
                                        max_tokens: 350,
                                    }),
                                    signal: controller.signal,
                                });
                                const json = (await resp.json().catch(() => null));
                                const content = String(json?.choices?.[0]?.message?.content ?? "").trim();
                                return content ? content : null;
                            }
                            catch {
                                return null;
                            }
                            finally {
                                clearTimeout(timeout);
                            }
                        }
                        function extractJson(s) {
                            const t = String(s ?? "");
                            const a = t.indexOf("{");
                            const b = t.lastIndexOf("}");
                            if (a >= 0 && b > a)
                                return t.slice(a, b + 1);
                            return "";
                        }
                        async function planWithAi(input) {
                            if (!openKeys.length || !openModel)
                                return null;
                            const key = openKeys[Math.floor(Math.random() * openKeys.length)];
                            const delivery = cfg?.deliveryOptions ?? null;
                            const deliveryNotes = typeof delivery?.notes === "string" ? String(delivery.notes).trim() : "";
                            const deliveryMethods = Array.isArray(delivery?.methods) ? delivery.methods : [];
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
                            const shopPhoneRaw = typeof cfg?.whatsappBotBrain?.shopPhone === "string" ? String(cfg.whatsappBotBrain.shopPhone).trim() : "";
                            const system = `You are a WhatsApp sales assistant for ${storeName}.\n` +
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
                                const json = (await resp.json().catch(() => null));
                                const content = String(json?.choices?.[0]?.message?.content ?? "").trim();
                                const raw = extractJson(content);
                                if (!raw)
                                    return null;
                                const parsed = JSON.parse(raw);
                                if (!parsed || typeof parsed !== "object")
                                    return null;
                                if (parsed.action === "reply") {
                                    const reply_text = typeof parsed.reply_text === "string" ? parsed.reply_text.trim() : "";
                                    if (!reply_text)
                                        return null;
                                    return { action: "reply", reply_text };
                                }
                                if (parsed.action === "search") {
                                    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
                                    const brand = typeof parsed.brand === "string" ? parsed.brand.trim() : null;
                                    const negative_keywords = Array.isArray(parsed.negative_keywords)
                                        ? parsed.negative_keywords
                                            .filter((x) => typeof x === "string" && x.trim().length > 0)
                                            .map((x) => x.trim().toLowerCase())
                                            .slice(0, 20)
                                        : [];
                                    const min_price = typeof parsed.min_price === "number" && Number.isFinite(parsed.min_price) ? parsed.min_price : null;
                                    const max_price = typeof parsed.max_price === "number" && Number.isFinite(parsed.max_price) ? parsed.max_price : null;
                                    const intro_message = typeof parsed.intro_message === "string" ? parsed.intro_message.trim().slice(0, 250) : "";
                                    if (!query && !brand)
                                        return null;
                                    return { action: "search", query: query || (brand ?? ""), brand, negative_keywords, min_price, max_price, intro_message };
                                }
                                return null;
                            }
                            catch {
                                return null;
                            }
                            finally {
                                clearTimeout(timeout);
                            }
                        }
                        function smartSearchLocal(query, allProducts, opts) {
                            const q = (query ?? "").trim().toLowerCase();
                            let filtered = Array.isArray(allProducts) ? allProducts : [];
                            const brand = typeof opts?.brand === "string" && opts.brand.trim() ? opts.brand.trim().toLowerCase() : null;
                            if (brand)
                                filtered = filtered.filter((p) => String(p?.brand ?? "").trim().toLowerCase() === brand);
                            const negative = Array.isArray(opts?.negative) ? opts.negative.filter((x) => typeof x === "string" && x.trim()) : [];
                            if (negative.length) {
                                filtered = filtered.filter((p) => {
                                    const hay = `${p?.name ?? ""} ${p?.brand ?? ""} ${p?.category ?? ""} ${p?.description ?? ""}`.toLowerCase();
                                    return !negative.some((bad) => hay.includes(String(bad)));
                                });
                            }
                            const min = typeof opts?.min === "number" && Number.isFinite(opts.min) ? opts.min : null;
                            const max = typeof opts?.max === "number" && Number.isFinite(opts.max) ? opts.max : null;
                            if (min !== null)
                                filtered = filtered.filter((p) => Number(p?.price ?? 0) >= min);
                            if (max !== null)
                                filtered = filtered.filter((p) => Number(p?.price ?? 0) <= max);
                            if (!q)
                                return filtered.slice(0, 6);
                            const stop = new Set(["i", "me", "want", "need", "show", "some", "any", "the", "a", "an", "and", "or", "for", "with", "please"]);
                            const tokens = q.replace(/[^a-z0-9\s]/g, " ").split(/\s+/g).filter((t) => t.length >= 2 && !stop.has(t));
                            const scored = [];
                            for (const p of filtered) {
                                let score = 0;
                                const name = String(p?.name ?? "").toLowerCase();
                                const cat = String(p?.category ?? "").toLowerCase();
                                const brandHay = String(p?.brand ?? "").toLowerCase();
                                const desc = String(p?.description ?? "").toLowerCase();
                                if (name === q)
                                    score += 500;
                                else if (name.includes(q))
                                    score += 120;
                                for (const tok of tokens) {
                                    if (name.includes(tok))
                                        score += 20;
                                    if (cat.includes(tok))
                                        score += 8;
                                    if (brandHay.includes(tok))
                                        score += 25;
                                    if (desc.includes(tok))
                                        score += 2;
                                }
                                if (score > 0)
                                    scored.push({ p, score });
                            }
                            scored.sort((a, b) => b.score - a.score);
                            return scored.map((s) => s.p).slice(0, 6);
                        }
                        const smart = await openRouterSmartReply(cleaned);
                        if (smart) {
                            const showId = parseShowProduct(smart);
                            if (showId) {
                                if (askDmOnly && runtime.baileysSendGroupCtaCard) {
                                    try {
                                        if (tagBack && runtime.baileysSendGroupText) {
                                            await runtime.baileysSendGroupText(groupId, `${mentionText}Tap below to continue.`, mentions);
                                        }
                                    }
                                    catch {
                                        void 0;
                                    }
                                    try {
                                        await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, `VIEW_PRODUCT ${showId}`, "Continue in DM");
                                    }
                                    catch {
                                        void 0;
                                    }
                                    return;
                                }
                            }
                            else if (askDmOnly && looksLikeProductList(smart) && runtime.baileysSendGroupCtaCard) {
                                try {
                                    if (tagBack && runtime.baileysSendGroupText) {
                                        await runtime.baileysSendGroupText(groupId, `${mentionText}I found options. Tap below to continue.`, mentions);
                                    }
                                }
                                catch {
                                    void 0;
                                }
                                try {
                                    await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, cleaned || "Menu", "Continue in DM");
                                }
                                catch {
                                    void 0;
                                }
                                return;
                            }
                            else if (!looksLikeProductList(smart) && !showId) {
                                try {
                                    if (runtime.baileysSendGroupText)
                                        await runtime.baileysSendGroupText(groupId, `${mentionText}${smart}`, mentions);
                                }
                                catch {
                                    void 0;
                                }
                                return;
                            }
                        }
                        const plan = await planWithAi(cleaned);
                        if (plan && plan.action === "reply") {
                            try {
                                if (runtime.baileysSendGroupText)
                                    await runtime.baileysSendGroupText(groupId, `${mentionText}${plan.reply_text}`, mentions);
                            }
                            catch {
                                void 0;
                            }
                            return;
                        }
                        const queryToSearch = plan && plan.action === "search" ? plan.query : cleaned;
                        const hits = smartSearchLocal(queryToSearch, products, {
                            brand: plan && plan.action === "search" ? (plan.brand ?? null) : null,
                            min: plan && plan.action === "search" ? (plan.min_price ?? null) : null,
                            max: plan && plan.action === "search" ? (plan.max_price ?? null) : null,
                            negative: plan && plan.action === "search" ? (plan.negative_keywords ?? []) : [],
                        });
                        if (!hits.length) {
                            try {
                                if (runtime.baileysSendGroupText)
                                    await runtime.baileysSendGroupText(groupId, `${mentionText}I couldn’t find a match for “${cleaned}”. Try another name.`, mentions);
                            }
                            catch {
                                void 0;
                            }
                            return;
                        }
                        if (askDmOnly) {
                            try {
                                if (tagBack && runtime.baileysSendGroupText) {
                                    await runtime.baileysSendGroupText(groupId, `${mentionText}I found options. Tap below to continue.`, mentions);
                                }
                            }
                            catch {
                                void 0;
                            }
                            if (runtime.baileysSendGroupCtaCard) {
                                try {
                                    const prefill = queryToSearch || cleaned || "Menu";
                                    await runtime.baileysSendGroupCtaCard(groupId, `Continue with ${storeName} in DM`, storeName, prefill, "Continue in DM");
                                }
                                catch {
                                    void 0;
                                }
                            }
                            return;
                        }
                        if (!runtime.baileysSendGroupProductImages)
                            return;
                        const cards = hits
                            .map((p) => ({
                            product_id: typeof p?.id === "number" ? p.id : undefined,
                            image_url: typeof p?.image_url === "string" && p.image_url.trim() ? p.image_url.trim() : "",
                            body: `*${String(p?.name ?? "").trim().slice(0, 60) || "Item"}*\n${String(p?.currency ?? "").trim()} ${Number(p?.price ?? 0)}`.trim(),
                            footer: storeName,
                        }))
                            .filter((c) => c.image_url);
                        if (!cards.length)
                            return;
                        try {
                            const intro = plan && plan.action === "search" && typeof plan.intro_message === "string" && plan.intro_message.trim()
                                ? plan.intro_message.trim().slice(0, 250)
                                : "Here are some options:";
                            if (runtime.baileysSendGroupText)
                                await runtime.baileysSendGroupText(groupId, `${mentionText}${intro}`, mentions);
                        }
                        catch {
                            void 0;
                        }
                        try {
                            await runtime.baileysSendGroupProductImages(groupId, "", "", cards, "Continue in DM");
                        }
                        catch {
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
                    }
                    else if (typeof from === "string" && !from.endsWith("@g.us") && from !== "status@broadcast") {
                        void logMessageToApi(vendorId, { peer: from, direction: "in", text, external_id: id, sent_at: at, display_name: pushName });
                    }
                },
                onError: (message) => {
                    emit(runtime, { type: "error", message });
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
            runtime.baileysGroupMentions = br.groupMentions;
            runtime.baileysSendGroupImage = br.sendGroupImage;
            runtime.baileysSendGroupProductImages = br.sendGroupProductImages;
            runtime.baileysSendGroupCtaCard = br.sendGroupCtaCard;
            runtime.baileysSendGroupCtaLinks = br.sendGroupCtaLinks;
            runtime.baileysSendStatusText = br.sendStatusText;
            runtime.baileysSendStatusImage = br.sendStatusImage;
            runtime.baileysSendStatusVideo = br.sendStatusVideo;
            runtime.baileysSendStatusAlbum = br.sendStatusAlbum;
        }
        catch (e) {
            runtime.mode = "baileys";
            emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Baileys init failed." });
            emit(runtime, { type: "status", status: "disconnected" });
        }
        runtimes.set(vendorId, runtime);
        return runtime;
    })();
    startingRuntimes.set(vendorId, p);
    try {
        return await p;
    }
    finally {
        if (startingRuntimes.get(vendorId) === p)
            startingRuntimes.delete(vendorId);
    }
}
export async function restartVendorRuntime(vendorId) {
    const inflight = startingRuntimes.get(vendorId);
    if (inflight) {
        try {
            await inflight;
        }
        catch {
            void 0;
        }
    }
    const existing = runtimes.get(vendorId);
    if (existing)
        await existing.stop();
    return await startVendorRuntime(vendorId);
}
export async function resetVendorRuntime(vendorId) {
    const inflight = startingRuntimes.get(vendorId);
    if (inflight) {
        try {
            await inflight;
        }
        catch {
            void 0;
        }
    }
    const existing = runtimes.get(vendorId);
    if (existing)
        await existing.stop();
    const sessionDir = sessionDirForVendor(vendorId);
    await rm(sessionDir, { recursive: true, force: true });
    return await startVendorRuntime(vendorId);
}
export async function purgeVendorData(vendorId) {
    const existing = runtimes.get(vendorId);
    if (existing)
        await existing.stop();
    const sessionDir = sessionDirForVendor(vendorId);
    await rm(sessionDir, { recursive: true, force: true });
    const cfgPath = configPathForVendor(vendorId);
    await rm(cfgPath, { force: true });
    backoff.delete(vendorId);
    sendQueue.delete(vendorId);
    return { ok: true };
}
export async function sendVendorMessage(vendorId, to, text) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        if (!runtime.baileysSend)
            throw new Error("WhatsApp runtime not ready.");
        try {
            await runtime.baileysSend(to, text);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "Send failed.";
            emit(runtime, { type: "error", message: msg });
            return { ok: false, message: msg };
        }
        await pushOutbound(runtime, to, text);
        return { ok: true };
    });
}
export async function sendVendorButtons(vendorId, to, text, buttons) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        if (!runtime.baileysSendButtons)
            throw new Error("WhatsApp runtime not ready.");
        try {
            await runtime.baileysSendButtons(to, text, buttons);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "Send failed.";
            emit(runtime, { type: "error", message: msg });
            return { ok: false, message: msg };
        }
        await pushOutbound(runtime, to, text);
        return { ok: true };
    });
}
export async function sendVendorImage(vendorId, to, imageUrl, caption) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        if (!runtime.baileysSendImage)
            throw new Error("WhatsApp runtime not ready.");
        const cap = typeof caption === "string" ? caption : "";
        try {
            console.log(`vendor ${vendorId}: send image capLen=${cap.trim() ? cap.length : 0}`);
            await runtime.baileysSendImage(to, imageUrl, cap);
            await new Promise((r) => setTimeout(r, 900));
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "Send failed.";
            emit(runtime, { type: "error", message: msg });
            return { ok: false, message: msg };
        }
        await pushOutbound(runtime, to, cap);
        return { ok: true };
    });
}
export async function sendVendorImages(vendorId, to, imageUrls, caption) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        if (!runtime.baileysSendImage)
            throw new Error("WhatsApp runtime not ready.");
        const urls = (Array.isArray(imageUrls) ? imageUrls : [])
            .filter((x) => typeof x === "string")
            .map((x) => String(x).trim())
            .filter((x) => x !== "")
            .slice(0, 10);
        const cap = typeof caption === "string" ? caption : "";
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < urls.length; i++) {
            const u = urls[i];
            try {
                if (i === 0) {
                    const len = cap.trim() ? cap.length : 0;
                    console.log(`vendor ${vendorId}: send image ${i + 1}/${urls.length} capLen=${len}`);
                    await runtime.baileysSendImage(to, u, cap);
                }
                else {
                    console.log(`vendor ${vendorId}: send image ${i + 1}/${urls.length} capLen=0`);
                    await runtime.baileysSendImage(to, u);
                }
                sent++;
            }
            catch (e) {
                failed++;
                const msg = e instanceof Error ? e.message : "Send failed.";
                emit(runtime, { type: "error", message: msg });
            }
            await new Promise((r) => setTimeout(r, urls.length > 1 ? 1200 : 900));
        }
        if (cap) {
            await pushOutbound(runtime, to, cap);
        }
        return { ok: failed === 0, sent, failed };
    });
}
export async function sendVendorMedia(vendorId, to, imageUrls, videoUrls, caption) {
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
        if (imgs.length && !sendImage)
            throw new Error("WhatsApp runtime not ready.");
        if (vids.length && !sendVideo)
            throw new Error("WhatsApp runtime not ready.");
        const cap = typeof caption === "string" ? caption : "";
        let imagesSent = 0;
        let imagesFailed = 0;
        let videosSent = 0;
        let videosFailed = 0;
        for (let i = 0; i < imgs.length; i++) {
            const u = imgs[i];
            try {
                if (i === 0) {
                    const len = cap.trim() ? cap.length : 0;
                    console.log(`vendor ${vendorId}: send image ${i + 1}/${imgs.length} capLen=${len}`);
                    await sendImage(to, u, cap);
                }
                else {
                    console.log(`vendor ${vendorId}: send image ${i + 1}/${imgs.length} capLen=0`);
                    await sendImage(to, u);
                }
                imagesSent++;
            }
            catch (e) {
                imagesFailed++;
                const msg = e instanceof Error ? e.message : "Send failed.";
                emit(runtime, { type: "error", message: msg });
            }
            await new Promise((r) => setTimeout(r, imgs.length > 1 ? 1200 : 900));
        }
        for (let i = 0; i < vids.length; i++) {
            const u = vids[i];
            const capForThis = imgs.length === 0 && i === 0 ? cap : "";
            try {
                console.log(`vendor ${vendorId}: send video ${i + 1}/${vids.length} capLen=${capForThis.trim() ? capForThis.length : 0}`);
                await sendVideo(to, u, capForThis);
                videosSent++;
            }
            catch (e) {
                videosFailed++;
                const msg = e instanceof Error ? e.message : "Send failed.";
                emit(runtime, { type: "error", message: msg });
                try {
                    if (runtime.baileysSend) {
                        await runtime.baileysSend(to, `Video: ${u}`);
                    }
                }
                catch {
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
export async function sendVendorVideo(vendorId, to, videoUrl, caption) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        if (!runtime.baileysSendVideo)
            throw new Error("WhatsApp runtime not ready.");
        const cap = typeof caption === "string" ? caption : "";
        try {
            console.log(`vendor ${vendorId}: send video capLen=${cap.trim() ? cap.length : 0}`);
            await runtime.baileysSendVideo(to, videoUrl, cap);
            await new Promise((r) => setTimeout(r, 1200));
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "Send failed.";
            emit(runtime, { type: "error", message: msg });
            try {
                if (runtime.baileysSend) {
                    await runtime.baileysSend(to, `Video: ${videoUrl}`);
                }
            }
            catch {
            }
            return { ok: false, message: msg };
        }
        await pushOutbound(runtime, to, cap);
        return { ok: true };
    });
}
export async function sendVendorBroadcast(vendorId, recipients, payload) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        const list = Array.isArray(recipients) ? recipients.map((x) => x.trim()).filter((x) => x !== "") : [];
        const mentionAll = payload.mentionAll === true;
        const baseMsg = typeof payload.text === "string" ? payload.text : "";
        const msg = mentionAll ? `@all\n\n${baseMsg}` : baseMsg;
        if (!msg.trim())
            return { ok: false, sent: 0, failed: 0, results: [] };
        const delaySecondsRaw = typeof payload.delaySeconds === "number" && Number.isFinite(payload.delaySeconds) ? payload.delaySeconds : 0;
        const delay = Math.max(0, Math.min(600_000, Math.floor(delaySecondsRaw * 1000)));
        const productCardsRaw = payload.productCards && typeof payload.productCards === "object" ? payload.productCards : null;
        const cardsRaw = Array.isArray(productCardsRaw?.cards) ? productCardsRaw?.cards : [];
        const cards = cardsRaw
            .filter((c) => c && typeof c === "object")
            .map((c) => c)
            .map((c) => ({
            image_url: typeof c.image_url === "string" ? c.image_url.trim() : "",
            body: typeof c.body === "string"
                ? c.body.trim()
                : (typeof c.title === "string" ? c.title.trim() : ""),
            footer: typeof c.footer === "string" ? c.footer.trim() : "",
            url: typeof c.url === "string"
                ? c.url.trim()
                : (typeof c.link_url === "string" ? c.link_url.trim() : ""),
            buttons: Array.isArray(c.buttons)
                ? c.buttons
                    .filter((b) => b && typeof b === "object")
                    .map((b) => b)
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
        const buttonsRaw = Array.isArray(payload.buttons) ? payload.buttons : [];
        const buttons = buttonsRaw
            .filter((b) => b && typeof b === "object")
            .map((b) => b)
            .map((b) => ({
            text: typeof b.text === "string" ? b.text.trim() : "",
            url: typeof b.url === "string" ? b.url.trim() : "",
        }))
            .filter((b) => b.text && b.url)
            .slice(0, 30);
        const chunk3 = (arr) => {
            const out = [];
            for (let i = 0; i < arr.length; i += 3)
                out.push(arr.slice(i, i + 3));
            return out;
        };
        const results = [];
        for (const to of list) {
            let ok = true;
            let err = undefined;
            try {
                const isGroup = to.endsWith("@g.us");
                const linkChunks = buttons.length ? chunk3(buttons) : [];
                if (isGroup && linkChunks.length && runtime.baileysSendGroupCtaLinks) {
                    await runtime.baileysSendGroupCtaLinks(to, msg, "", linkChunks[0]);
                    await pushOutbound(runtime, to, msg);
                    if (linkChunks.length > 1) {
                        for (let i = 1; i < linkChunks.length; i++) {
                            await runtime.baileysSendGroupCtaLinks(to, "More links", "", linkChunks[i]);
                            await new Promise((r) => setTimeout(r, 150));
                        }
                    }
                }
                else if (runtime.baileysSend) {
                    await runtime.baileysSend(to, msg);
                    await pushOutbound(runtime, to, msg);
                }
                else {
                    throw new Error("WhatsApp runtime not ready.");
                }
                if (hasCards && isGroup && runtime.baileysSendGroupProductImages) {
                    await runtime.baileysSendGroupProductImages(to, "", "", cards, buttonText || undefined);
                    if (fallbackText && fallbackText !== msg) {
                        await pushOutbound(runtime, to, fallbackText);
                    }
                }
                else if (hasCards && runtime.baileysSend) {
                    await runtime.baileysSend(to, fallbackText || msg);
                    if (fallbackText && fallbackText !== msg) {
                        await pushOutbound(runtime, to, fallbackText);
                    }
                }
            }
            catch (e) {
                ok = false;
                err = e instanceof Error ? e.message : "Send failed.";
                emit(runtime, { type: "error", message: err });
                try {
                    await pushOutbound(runtime, to, hasCards ? (fallbackText || msg) : msg);
                }
                catch {
                    void 0;
                }
            }
            results.push({ to, ok, error: err });
            if (delay > 0)
                await new Promise((r) => setTimeout(r, delay));
        }
        const sent = results.filter((r) => r.ok).length;
        const failed = results.length - sent;
        return { ok: failed === 0, sent, failed, results };
    });
}
export async function listVendorMessages(vendorId) {
    const runtime = await startVendorRuntime(vendorId);
    return runtime.messages;
}
export async function generatePairingCode(vendorId, phone) {
    const existing = runtimes.get(vendorId);
    if (existing?.status === "connected") {
        throw new Error("Already connected. Disconnect or reset first.");
    }
    const runtime = existing?.status === "disconnected" ? await restartVendorRuntime(vendorId) : await startVendorRuntime(vendorId);
    const at = new Date().toISOString();
    if (runtime.mode === "baileys" && runtime.baileysPair) {
        try {
            const cleaned = cleanPairingPhone(phone);
            if (!cleaned)
                throw new Error("Invalid phone number.");
            const code = await runtime.baileysPair(cleaned);
            emit(runtime, { type: "pairing_code", phone: cleaned, code, at });
            return { ok: true, code };
        }
        catch (e) {
            emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Pairing failed." });
        }
    }
    throw new Error(runtime.lastError ? `Pairing unavailable: ${runtime.lastError}` : "Pairing unavailable: WhatsApp runtime not ready.");
}
export async function updateVendorConfig(vendorId, patch) {
    const runtime = await startVendorRuntime(vendorId);
    const next = {
        strategyMode: patch.strategyMode ?? runtime.config.strategyMode,
        escalationKeywords: Array.isArray(patch.escalationKeywords) ? patch.escalationKeywords : runtime.config.escalationKeywords,
    };
    runtime.config = next;
    try {
        await saveVendorConfig(vendorId, next);
    }
    catch {
        void 0;
    }
    emit(runtime, { type: "config_updated", config: next, at: new Date().toISOString() });
    return { ok: true, config: next };
}
export async function setGroupLock(vendorId, name, locked) {
    const runtime = await startVendorRuntime(vendorId);
    const key = name.trim();
    if (!key)
        return { ok: false };
    if (!runtime.baileysSetGroupLocked)
        return { ok: false };
    if (!key.endsWith("@g.us"))
        return { ok: false };
    try {
        await runtime.baileysSetGroupLocked(key, locked);
    }
    catch (e) {
        emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Group lock failed." });
        return { ok: false };
    }
    const prev = runtime.groups.get(key);
    const display = prev?.name ?? key;
    runtime.groups.set(key, { name: display, locked, participantsCount: prev?.participantsCount ?? 0 });
    emit(runtime, { type: "group_locked", name: display, locked, at: new Date().toISOString() });
    return { ok: true };
}
export async function setGroupLockBulk(vendorId, targets, locked, delaySeconds, unlockAfterSeconds) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        const list = Array.isArray(targets) ? targets.map((x) => String(x).trim()).filter((x) => x.endsWith("@g.us")) : [];
        const delaySecondsRaw = typeof delaySeconds === "number" && Number.isFinite(delaySeconds) ? delaySeconds : 0;
        const delay = Math.max(0, Math.min(600_000, Math.floor(delaySecondsRaw * 1000)));
        const unlockAfter = typeof unlockAfterSeconds === "number" && Number.isFinite(unlockAfterSeconds)
            ? Math.max(0, Math.min(60 * 60, Math.floor(unlockAfterSeconds)))
            : 0;
        const results = [];
        for (const id of list) {
            let ok = true;
            let err = undefined;
            try {
                await setGroupLock(vendorId, id, locked);
                if (locked && unlockAfter > 0) {
                    const handle = setTimeout(() => {
                        void setGroupLock(vendorId, id, false);
                    }, unlockAfter * 1000);
                    runtime.unlockTimers.push(handle);
                }
            }
            catch (e) {
                ok = false;
                err = e instanceof Error ? e.message : "Group lock failed.";
            }
            results.push({ to: id, ok, error: err });
            if (delay > 0)
                await new Promise((r) => setTimeout(r, delay));
        }
        const sent = results.filter((r) => r.ok).length;
        const failed = results.length - sent;
        return { ok: failed === 0, sent, failed, results };
    });
}
export async function dropGroup(vendorId, name) {
    const runtime = await startVendorRuntime(vendorId);
    const key = name.trim();
    if (!key)
        return { ok: false };
    if (!runtime.baileysLeaveGroup)
        return { ok: false };
    if (!key.endsWith("@g.us"))
        return { ok: false };
    try {
        await runtime.baileysLeaveGroup(key);
    }
    catch (e) {
        emit(runtime, { type: "error", message: e instanceof Error ? e.message : "Leave group failed." });
        return { ok: false };
    }
    const display = runtime.groups.get(key)?.name ?? key;
    runtime.groups.delete(key);
    emit(runtime, { type: "group_dropped", name: display, at: new Date().toISOString() });
    return { ok: true };
}
export async function postDrop(vendorId, payload) {
    return await enqueueSend(vendorId, async () => {
        const runtime = await startVendorRuntime(vendorId);
        const describeError = (e) => {
            const base = e instanceof Error ? e.message : e ? String(e) : "";
            if (base && base !== "[object Object]" && !base.toLowerCase().includes("object object"))
                return base;
            try {
                const json = JSON.stringify(e);
                return json && json !== "{}" ? json : (base || "Unknown error.");
            }
            catch {
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
        const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : undefined;
        const productCardsRaw = payload.productCards && typeof payload.productCards === "object" ? payload.productCards : null;
        const cardsRaw = Array.isArray(productCardsRaw?.cards) ? productCardsRaw?.cards : [];
        const cards = cardsRaw
            .filter((c) => c && typeof c === "object")
            .map((c) => c)
            .map((c) => ({
            product_id: typeof c.product_id === "number" ? c.product_id : undefined,
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
        if (!text.trim())
            return { ok: false };
        const isVideoUrl = (u) => {
            const s = (u ?? "").toLowerCase();
            return s.includes(".mp4") || s.includes(".webm") || s.includes(".mov") || s.includes(".m4v") || s.includes(".3gp");
        };
        if (channel === "status") {
            const statusTargets = targets;
            const statusMessageIds = [];
            let statusError = null;
            if (runtime.mode === "baileys") {
                try {
                    if (!mediaUrls.length && runtime.baileysSendStatusText) {
                        const id = await runtime.baileysSendStatusText(text, statusTargets);
                        if (id)
                            statusMessageIds.push(id);
                    }
                    else if (mediaUrls.length > 1 && runtime.baileysSendStatusAlbum) {
                        const id = await runtime.baileysSendStatusAlbum(mediaUrls, text, statusTargets);
                        if (id) {
                            statusMessageIds.push(id);
                            void forwardStatusPostToApi(vendorId, { message_id: id, text, media_url: mediaUrls[0] ?? undefined, meta });
                        }
                    }
                    else {
                        for (let i = 0; i < mediaUrls.length; i++) {
                            const u = mediaUrls[i];
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
                }
                catch (e) {
                    statusError = e instanceof Error ? e.message : "Status post failed.";
                    emit(runtime, { type: "error", message: statusError });
                }
            }
            if (!statusMessageIds.length) {
                return { ok: false, message: statusError ?? "Status post failed." };
            }
            if (statusMessageIds.length === 1 && !mediaUrls.length) {
                void forwardStatusPostToApi(vendorId, { message_id: statusMessageIds[0], text, meta });
            }
            await pushOutbound(runtime, "status", text);
        }
        else {
            const lockBefore = payload.lockBefore === true;
            const unlockAfterSeconds = typeof payload.unlockAfterSeconds === "number" && Number.isFinite(payload.unlockAfterSeconds)
                ? Math.max(0, Math.min(60 * 60, Math.floor(payload.unlockAfterSeconds)))
                : 0;
            const delaySecondsRaw = typeof payload.delaySeconds === "number" && Number.isFinite(payload.delaySeconds) ? payload.delaySeconds : 0;
            const delay = Math.max(0, Math.min(600_000, Math.floor(delaySecondsRaw * 1000)));
            const groupErrors = [];
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
                    if (!target)
                        continue;
                    await setGroupLock(vendorId, target, true);
                }
            }
            for (const t of targets) {
                const target = t.trim();
                if (!target)
                    continue;
                if (runtime.mode === "baileys" && target.endsWith("@g.us")) {
                    try {
                        if (hasCards) {
                            if (canProductImages) {
                                const dropId = await runtime.baileysSendGroupProductImages(target, bodyText || text, footerText, cards, buttonText);
                                if (dropId)
                                    rememberDropReply(runtime, dropId, target, meta);
                            }
                            else if (canCardImages) {
                                let dropId = null;
                                for (const card of cards) {
                                    const capParts = [];
                                    if (card.body)
                                        capParts.push(card.body);
                                    if (card.footer)
                                        capParts.push(card.footer);
                                    if (forwardToStatus)
                                        capParts.push("Forward this image to your Status");
                                    const cap = capParts.join("\n\n").trim();
                                    const id = await runtime.baileysSendGroupImage(target, card.image_url, cap);
                                    if (!dropId && id)
                                        dropId = id;
                                }
                                if (dropId)
                                    rememberDropReply(runtime, dropId, target, meta);
                            }
                        }
                        else {
                            let mentions = [];
                            if (mentionAll && runtime.baileysGroupMentions) {
                                try {
                                    mentions = await runtime.baileysGroupMentions(target);
                                }
                                catch {
                                    mentions = [];
                                }
                            }
                            let dropId = null;
                            if (mediaUrls.length && canMedia) {
                                let sentText = false;
                                if (canText && mentions.length) {
                                    dropId = await runtime.baileysSendGroupText(target, text, mentions);
                                    sentText = true;
                                }
                                for (let i = 0; i < mediaUrls.length; i++) {
                                    const u = mediaUrls[i];
                                    if (isVideoUrl(u))
                                        throw new Error("Group video drops are not supported.");
                                    const cap = !sentText && i === 0 ? text : "";
                                    const id = await runtime.baileysSendGroupImage(target, u, cap);
                                    if (!dropId && id)
                                        dropId = id;
                                }
                            }
                            else if (canText) {
                                dropId = await runtime.baileysSendGroupText(target, text, mentions.length ? mentions : undefined);
                            }
                            else {
                                throw new Error("Group send unavailable.");
                            }
                            if (dropId)
                                rememberDropReply(runtime, dropId, target, meta);
                        }
                        groupPosted++;
                        await pushOutbound(runtime, `group:${target}`, fallbackText || text);
                    }
                    catch (e) {
                        let recovered = false;
                        if (hasCards && canCardImages) {
                            try {
                                for (const card of cards) {
                                    const capParts = [];
                                    if (card.body)
                                        capParts.push(card.body);
                                    if (card.footer)
                                        capParts.push(card.footer);
                                    if (forwardToStatus)
                                        capParts.push("Forward this image to your Status");
                                    const cap = capParts.join("\n\n").trim();
                                    await runtime.baileysSendGroupImage(target, card.image_url, cap);
                                }
                                groupPosted++;
                                await pushOutbound(runtime, `group:${target}`, fallbackText || text);
                                recovered = true;
                            }
                            catch (e2) {
                                const msg2 = e2 instanceof Error ? e2.message : "Drop send failed.";
                                groupErrors.push(`${target}: ${msg2}`);
                                emit(runtime, { type: "error", message: msg2 });
                                recovered = true;
                            }
                        }
                        if (!recovered) {
                            const msg = e instanceof Error ? e.message : "Drop send failed.";
                            groupErrors.push(`${target}: ${msg}`);
                            emit(runtime, { type: "error", message: msg });
                        }
                    }
                }
                if (lockBefore && unlockAfterSeconds > 0) {
                    const handle = setTimeout(() => {
                        void setGroupLock(vendorId, target, false);
                    }, unlockAfterSeconds * 1000);
                    runtime.unlockTimers.push(handle);
                }
                if (delay > 0)
                    await new Promise((r) => setTimeout(r, delay));
            }
            if (groupErrors.length) {
                return {
                    ok: false,
                    message: groupPosted > 0
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
        });
        return { ok: true };
    });
}
export async function listVendorGroups(vendorId) {
    const runtime = await startVendorRuntime(vendorId);
    if (!runtime.baileysListGroups)
        return { ok: false, mode: "baileys", groups: [] };
    try {
        const groups = await runtime.baileysListGroups();
        for (const g of groups) {
            const prev = runtime.groups.get(g.id);
            runtime.groups.set(g.id, { name: g.name, locked: prev?.locked ?? false, participantsCount: g.participantsCount });
        }
        return { ok: true, mode: "baileys", groups };
    }
    catch (e) {
        emit(runtime, { type: "error", message: e instanceof Error ? e.message : "List groups failed." });
        return { ok: false, mode: "baileys", groups: [] };
    }
}
