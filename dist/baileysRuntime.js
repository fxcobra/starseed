import * as baileys from "@itsliaaa/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { createEllbot } from "./ellbot.js";
const makeWASocket = baileys?.default ?? baileys?.makeWASocket;
const DisconnectReason = baileys?.DisconnectReason;
const fetchLatestBaileysVersion = baileys?.fetchLatestBaileysVersion;
const jidNormalizedUser = baileys?.jidNormalizedUser;
const useMultiFileAuthState = baileys?.useMultiFileAuthState;
const makeInMemoryStore = baileys?.makeInMemoryStore;
const prepareWAMessageMedia = baileys?.prepareWAMessageMedia;
const proto = baileys?.proto;
const generateWAMessageFromContent = baileys?.generateWAMessageFromContent;
function isEnabled() {
    const v = process.env.BAILEYS_ENABLED ?? "";
    return v === "1" || v.toLowerCase() === "true";
}
function cleanPhone(raw) {
    const t = raw.trim();
    if (!t)
        return "";
    const hasPlus = t.startsWith("+");
    const digits = t.replace(/[^\d]/g, "");
    if (!digits)
        return "";
    return hasPlus ? `+${digits}` : digits;
}
function unwrapMessage(m) {
    let cur = m;
    for (let i = 0; i < 6; i++) {
        if (!cur || typeof cur !== "object")
            return cur;
        const obj = cur;
        const eph = obj["ephemeralMessage"];
        if (eph && typeof eph === "object") {
            const inner = eph["message"];
            if (inner) {
                cur = inner;
                continue;
            }
        }
        const vo = obj["viewOnceMessageV2"];
        if (vo && typeof vo === "object") {
            const inner = vo["message"];
            if (inner) {
                cur = inner;
                continue;
            }
        }
        const voe = obj["viewOnceMessageV2Extension"];
        if (voe && typeof voe === "object") {
            const inner = voe["message"];
            if (inner) {
                cur = inner;
                continue;
            }
        }
        return cur;
    }
    return cur;
}
function extractText(message) {
    const unwrapped = unwrapMessage(message);
    if (!unwrapped || typeof unwrapped !== "object")
        return "";
    const m = unwrapped;
    const irm = m["interactiveResponseMessage"];
    if (irm && typeof irm === "object") {
        const nfrm = irm["nativeFlowResponseMessage"];
        if (nfrm && typeof nfrm === "object") {
            const paramsJson = nfrm["paramsJson"];
            if (typeof paramsJson === "string") {
                try {
                    const parsed = JSON.parse(paramsJson);
                    const p = parsed && typeof parsed === "object" ? parsed : null;
                    const id = typeof p?.id === "string"
                        ? p.id
                        : typeof p?.params?.id === "string"
                            ? p.params.id
                            : typeof p?.button_reply?.id === "string"
                                ? p.button_reply.id
                                : typeof p?.reply?.id === "string"
                                    ? p.reply.id
                                    : null;
                    if (typeof id === "string" && id.trim())
                        return id.trim();
                }
                catch {
                    void 0;
                }
            }
        }
    }
    const tbr = m["templateButtonReplyMessage"];
    if (tbr && typeof tbr === "object") {
        const id = tbr["selectedId"];
        if (typeof id === "string" && id.trim())
            return id;
        const t = tbr["selectedDisplayText"];
        if (typeof t === "string" && t.trim())
            return t;
    }
    const buttons = m["buttonsResponseMessage"];
    if (buttons && typeof buttons === "object") {
        const id = buttons["selectedButtonId"];
        if (typeof id === "string" && id.trim())
            return id;
        const t = buttons["selectedDisplayText"];
        if (typeof t === "string" && t.trim())
            return t;
    }
    const list = m["listResponseMessage"];
    if (list && typeof list === "object") {
        const ssr = list["singleSelectReply"];
        if (ssr && typeof ssr === "object") {
            const rowId = ssr["selectedRowId"];
            if (typeof rowId === "string" && rowId.trim())
                return rowId;
            const title = ssr["title"];
            if (typeof title === "string" && title.trim())
                return title;
        }
    }
    const conv = m["conversation"];
    if (typeof conv === "string")
        return conv;
    const ext = m["extendedTextMessage"];
    if (ext && typeof ext === "object") {
        const t = ext["text"];
        if (typeof t === "string")
            return t;
    }
    const img = m["imageMessage"];
    if (img && typeof img === "object") {
        const c = img["caption"];
        if (typeof c === "string")
            return c;
    }
    const vid = m["videoMessage"];
    if (vid && typeof vid === "object") {
        const c = vid["caption"];
        if (typeof c === "string")
            return c;
    }
    const doc = m["documentMessage"];
    if (doc && typeof doc === "object") {
        const c = doc["caption"];
        if (typeof c === "string")
            return c;
    }
    return "";
}
function extractContext(message) {
    const unwrapped = unwrapMessage(message);
    if (!unwrapped || typeof unwrapped !== "object")
        return {};
    const m = unwrapped;
    const ctxs = [];
    for (const k of ["extendedTextMessage", "imageMessage", "videoMessage", "documentMessage"]) {
        const obj = m[k];
        if (obj && typeof obj === "object") {
            const ctx = obj["contextInfo"];
            if (ctx && typeof ctx === "object")
                ctxs.push(ctx);
        }
    }
    const ctx = ctxs.find((x) => x && typeof x === "object");
    if (ctx) {
        const stanzaId = typeof ctx["stanzaId"] === "string" ? ctx["stanzaId"] : "";
        const remoteJid = typeof ctx["remoteJid"] === "string" ? ctx["remoteJid"] : "";
        const quotedParticipant = typeof ctx["participant"] === "string" ? ctx["participant"] : undefined;
        const quotedMessageId = stanzaId.trim() ? stanzaId.trim() : undefined;
        const quotedRemoteJid = remoteJid.trim() ? remoteJid.trim() : undefined;
        const isStatusReply = quotedRemoteJid === "status@broadcast";
        const mentionedJids = Array.isArray(ctx["mentionedJid"])
            ? ctx["mentionedJid"]
                .filter((x) => typeof x === "string" && String(x).trim().length > 0)
                .map((x) => x.trim())
                .slice(0, 50)
            : undefined;
        return { quotedMessageId, quotedRemoteJid, quotedParticipant, isStatusReply, mentionedJids };
    }
    return {};
}
export async function startBaileysRuntime(vendorId, sessionDir, handlers) {
    if (!isEnabled()) {
        throw new Error("Baileys disabled.");
    }
    if (typeof makeWASocket !== "function") {
        throw new Error("Baileys makeWASocket is not available.");
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    handlers.onRegistered?.(Boolean(state?.creds?.registered));
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: "silent" });
    handlers.onStatus("connecting");
    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });
    const store = typeof makeInMemoryStore === "function" ? makeInMemoryStore({ logger }) : null;
    if (store && typeof store.bind === "function") {
        store.bind(sock.ev);
    }
    const statusAudience = new Set();
    let cachedMePhone = "";
    function updateCachedMePhoneFromSock() {
        const me = typeof sock?.user?.id === "string" ? String(sock.user.id) : "";
        const meBase = me.includes("@") ? me.split("@")[0] : me;
        const phone = meBase.split(":")[0].replace(/\D/g, "");
        if (phone)
            cachedMePhone = phone;
    }
    updateCachedMePhoneFromSock();
    function getWaMeBase() {
        updateCachedMePhoneFromSock();
        const phone = cachedMePhone;
        return phone ? `https://wa.me/${phone}` : "";
    }
    function buildStatusJidList() {
        const list = Array.from(statusAudience);
        try {
            const chats = store && typeof store === "object" ? store.chats : null;
            if (chats && typeof chats === "object") {
                for (const jid of Object.keys(chats)) {
                    if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))
                        list.push(jid);
                }
            }
            const contacts = store && typeof store === "object" ? store.contacts : null;
            if (contacts && typeof contacts === "object") {
                for (const jid of Object.keys(contacts)) {
                    if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"))
                        list.push(jid);
                }
            }
        }
        catch {
            void 0;
        }
        const meJid = typeof sock?.user?.id === "string" ? String(sock.user.id) : "";
        if (meJid && meJid.includes("@"))
            list.push(meJid);
        return Array.from(new Set(list)).slice(0, 256);
    }
    function trackStatusAudience(jid) {
        const j = (jid ?? "").trim();
        if (!j)
            return;
        if (j.endsWith("@s.whatsapp.net") || j.endsWith("@lid"))
            statusAudience.add(j);
    }
    function withTimeout(p, ms, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), ms);
            void p.then((v) => {
                clearTimeout(timer);
                resolve(v);
            }, (e) => {
                clearTimeout(timer);
                reject(e);
            });
        });
    }
    function ensureConnected() {
        const me = typeof sock?.user?.id === "string" ? String(sock.user.id) : "";
        if (!me)
            throw new Error("WhatsApp not connected. Pair the vendor device and try again.");
    }
    const ellbot = createEllbot({
        vendorId,
        sock,
        prepareWAMessageMedia,
        generateWAMessageFromContent,
        cleanPhone,
        jidNormalizedUser,
        withTimeout,
        onError: handlers.onError,
    });
    const processedInbound = new Map();
    function seenInbound(remoteJid, messageId) {
        const id = (messageId ?? "").trim();
        const from = (remoteJid ?? "").trim();
        if (!id || !from)
            return false;
        const key = `${from}:${id}`;
        const now = Date.now();
        const prev = processedInbound.get(key);
        if (typeof prev === "number" && now - prev < 10 * 60_000)
            return true;
        processedInbound.set(key, now);
        if (processedInbound.size > 3000) {
            const cutoff = now - 10 * 60_000;
            for (const [k, ts] of processedInbound) {
                if (ts < cutoff)
                    processedInbound.delete(k);
            }
        }
        return false;
    }
    sock.ev.on("creds.update", async () => {
        await saveCreds();
        handlers.onRegistered?.(Boolean(state?.creds?.registered));
    });
    sock.ev.on("connection.update", async (update) => {
        try {
            if (update.qr) {
                const dataUrl = await QRCode.toDataURL(update.qr, { margin: 1, scale: 6 });
                handlers.onQr(dataUrl);
            }
            if (update.connection === "open") {
                updateCachedMePhoneFromSock();
                handlers.onStatus("connected");
            }
            if (update.connection === "close") {
                const err = update.lastDisconnect?.error;
                const code = err?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    handlers.onError("Logged out.");
                }
                else {
                    let msg = err instanceof Error ? err.message : err ? String(err) : "";
                    if (msg === "[object Object]" || msg.toLowerCase().includes("object object")) {
                        try {
                            msg = JSON.stringify(err);
                        }
                        catch {
                            void 0;
                        }
                    }
                    const label = typeof code === "number" ? `code ${code}` : "unknown code";
                    handlers.onError(msg ? `Connection closed (${label}): ${msg}` : `Connection closed (${label}).`);
                }
                handlers.onStatus("disconnected");
            }
        }
        catch (e) {
            handlers.onError(e instanceof Error ? e.message : "Connection update error.");
        }
    });
    sock.ev.on("messages.upsert", (upsert) => {
        try {
            const list = Array.isArray(upsert?.messages) ? upsert.messages : [];
            for (const msg of list) {
                if (!msg)
                    continue;
                if (msg?.key?.fromMe)
                    continue;
                const from = typeof msg?.key?.remoteJid === "string" ? String(msg.key.remoteJid) : "";
                if (!from)
                    continue;
                const msgKeyId = typeof msg?.key?.id === "string" ? String(msg.key.id) : "";
                if (msgKeyId && seenInbound(from, msgKeyId))
                    continue;
                if (from.endsWith("@s.whatsapp.net") || from.endsWith("@lid")) {
                    statusAudience.add(from);
                }
                const text = extractText(msg.message);
                if (!text.trim())
                    continue;
                const pushName = typeof msg.pushName === "string" ? String(msg.pushName).slice(0, 200) : undefined;
                const at = new Date().toISOString();
                const id = msgKeyId ? msgKeyId : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
                const participant = typeof msg?.key?.participant === "string"
                    ? String(msg.key.participant)
                    : typeof msg?.participant === "string"
                        ? String(msg.participant)
                        : undefined;
                const ctx = extractContext(msg.message);
                const mentioned = Array.isArray(ctx?.mentionedJids) ? ctx.mentionedJids : [];
                const quotedParticipant = typeof ctx?.quotedParticipant === "string" ? String(ctx.quotedParticipant) : "";
                const me = typeof sock?.user?.id === "string" ? String(sock.user.id) : "";
                const meNorm = me ? jidNormalizedUser(me) : "";
                const meDigits = meNorm ? (meNorm.split("@")[0] ?? "").replace(/[^\d]/g, "") : "";
                const mentionsMe = Boolean(meNorm) &&
                    (mentioned.some((j) => {
                        try {
                            const jNorm = jidNormalizedUser(j);
                            if (jNorm === meNorm)
                                return true;
                            const jDigits = (jNorm.split("@")[0] ?? "").replace(/[^\d]/g, "");
                            return Boolean(meDigits) && Boolean(jDigits) && meDigits === jDigits;
                        }
                        catch {
                            return false;
                        }
                    }) ||
                        (Boolean(meDigits) && String(text).includes(`@${meDigits}`)) ||
                        (Boolean(quotedParticipant) &&
                            (() => {
                                try {
                                    const qpNorm = jidNormalizedUser(quotedParticipant);
                                    if (qpNorm === meNorm)
                                        return true;
                                    const qpDigits = (qpNorm.split("@")[0] ?? "").replace(/[^\d]/g, "");
                                    return Boolean(meDigits) && Boolean(qpDigits) && meDigits === qpDigits;
                                }
                                catch {
                                    const qpDigits = (quotedParticipant.split("@")[0] ?? "").replace(/[^\d]/g, "");
                                    return Boolean(meDigits) && Boolean(qpDigits) && meDigits === qpDigits;
                                }
                            })()));
                handlers.onInboundMessage({ id, from, participant, pushName, text, at, ...ctx, mentionsMe });
                if (from.endsWith("@g.us") || from === "status@broadcast")
                    continue;
                void (async () => {
                    try {
                        await ellbot.handleDm(from, text, pushName);
                    }
                    catch (e) {
                        handlers.onError(e instanceof Error ? e.message : "ellbot handler failed.");
                    }
                })();
            }
        }
        catch (e) {
            handlers.onError(e instanceof Error ? e.message : "Inbound parse error.");
        }
    });
    async function stop() {
        try {
            const ws = sock?.ws ?? sock?.wsClient?.ws;
            if (ws && typeof ws.on === "function") {
                ws.on("error", () => void 0);
            }
            if (ws && ws.readyState === 0 && typeof ws.terminate === "function") {
                ws.terminate();
                return;
            }
            sock.end(undefined);
        }
        catch {
            void 0;
        }
    }
    async function sendText(to, text) {
        ensureConnected();
        const target = (to ?? "").trim();
        if (!target)
            throw new Error("Invalid recipient.");
        if (target.includes("@")) {
            trackStatusAudience(target);
            await sock.sendMessage(target, { text });
            return;
        }
        const phone = cleanPhone(target);
        if (!phone)
            throw new Error("Invalid phone.");
        const jid = jidNormalizedUser(phone.replace("+", "") + "@s.whatsapp.net");
        trackStatusAudience(jid);
        await sock.sendMessage(jid, { text });
    }
    async function sendButtons(to, text, buttons) {
        ensureConnected();
        const target = (to ?? "").trim();
        if (!target)
            throw new Error("Invalid recipient.");
        const jid = target.includes("@") ? target : jidNormalizedUser(cleanPhone(target).replace("+", "") + "@s.whatsapp.net");
        trackStatusAudience(jid);
        const btns = (Array.isArray(buttons) ? buttons : [])
            .filter((b) => b && typeof b === "object" && typeof b.id === "string" && typeof b.text === "string")
            .slice(0, 3)
            .map((b) => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: String(b.text).slice(0, 28),
                id: String(b.id).slice(0, 40),
            }),
        }));
        if (!btns.length || typeof generateWAMessageFromContent !== "function") {
            await sendText(to, text);
            return;
        }
        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text },
                        nativeFlowMessage: { buttons: btns },
                    },
                },
            },
        }, { userJid: sock?.user?.id });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    }
    async function sendImage(to, imageUrl, caption) {
        ensureConnected();
        const target = (to ?? "").trim();
        if (!target)
            throw new Error("Invalid recipient.");
        const url = (imageUrl ?? "").trim();
        if (!url)
            throw new Error("Invalid image url.");
        const jid = target.includes("@") ? target : jidNormalizedUser(cleanPhone(target).replace("+", "") + "@s.whatsapp.net");
        trackStatusAudience(jid);
        const cap = typeof caption === "string" ? caption.trim() : "";
        try {
            if (url.startsWith("http://") || url.startsWith("https://")) {
                const content = { image: { url } };
                if (cap)
                    content.caption = cap;
                await sock.sendMessage(jid, content);
                return;
            }
        }
        catch {
        }
        const buf = await downloadBuffer(url);
        const content = { image: buf };
        if (cap)
            content.caption = cap;
        await sock.sendMessage(jid, content);
    }
    async function sendVideo(to, videoUrl, caption) {
        ensureConnected();
        const target = (to ?? "").trim();
        if (!target)
            throw new Error("Invalid recipient.");
        const url = (videoUrl ?? "").trim();
        if (!url)
            throw new Error("Invalid video url.");
        const jid = target.includes("@") ? target : jidNormalizedUser(cleanPhone(target).replace("+", "") + "@s.whatsapp.net");
        trackStatusAudience(jid);
        const cap = typeof caption === "string" ? caption.trim() : "";
        const lower = url.toLowerCase();
        const mimetype = lower.includes(".webm") ? "video/webm" : lower.includes(".3gp") ? "video/3gpp" : lower.includes(".mov") ? "video/quicktime" : "video/mp4";
        try {
            if (url.startsWith("http://") || url.startsWith("https://")) {
                const content = { video: { url } };
                content.mimetype = mimetype;
                if (cap)
                    content.caption = cap;
                await sock.sendMessage(jid, content);
                return;
            }
        }
        catch {
        }
        const buf = await downloadBuffer(url);
        const content = { video: buf };
        content.mimetype = mimetype;
        if (cap)
            content.caption = cap;
        await sock.sendMessage(jid, content);
    }
    async function requestPairingCode(phone) {
        ensureConnected();
        const cleaned = cleanPhone(phone).replace("+", "");
        if (!cleaned)
            throw new Error("Invalid phone.");
        if (!("requestPairingCode" in sock))
            throw new Error("Pairing not supported.");
        const fn = sock.requestPairingCode;
        return await fn(cleaned);
    }
    async function listGroups() {
        const all = (await sock.groupFetchAllParticipating());
        const groups = Object.entries(all ?? {}).map(([id, g]) => ({
            id,
            name: g.subject ?? id,
            participantsCount: Array.isArray(g.participants) ? g.participants.length : 0,
        }));
        groups.sort((a, b) => a.name.localeCompare(b.name));
        return groups;
    }
    async function setGroupLocked(groupId, locked) {
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        await sock.groupSettingUpdate(groupId, locked ? "announcement" : "not_announcement");
    }
    async function leaveGroup(groupId) {
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        await sock.groupLeave(groupId);
    }
    async function groupMentions(groupId) {
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        const md = await sock.groupMetadata(groupId);
        const parts = Array.isArray(md?.participants) ? md.participants : [];
        const ids = [];
        for (const p of parts) {
            const id = typeof p?.id === "string" ? String(p.id) : "";
            if (!id)
                continue;
            if (!id.endsWith("@s.whatsapp.net") && !id.endsWith("@lid"))
                continue;
            ids.push(id);
        }
        return Array.from(new Set(ids)).slice(0, 40);
    }
    async function sendGroupText(groupId, text, mentions) {
        ensureConnected();
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        const m = Array.isArray(mentions) ? mentions.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()) : [];
        const r = (await sock.sendMessage(groupId, { text, ...(m.length ? { mentions: m } : {}) }));
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
    }
    function normalizeStatusJidList(targets) {
        const meJid = typeof sock?.user?.id === "string" ? String(sock.user.id) : "";
        const list = [];
        if (Array.isArray(targets) && targets.length) {
            for (const t of targets) {
                const raw = typeof t === "string" ? t.trim() : "";
                if (!raw)
                    continue;
                if (raw.endsWith("@s.whatsapp.net") || raw.endsWith("@lid")) {
                    list.push(raw);
                    continue;
                }
                const phone = cleanPhone(raw).replace(/^\+/, "");
                if (!phone)
                    continue;
                const jid = `${phone}@s.whatsapp.net`;
                list.push(typeof jidNormalizedUser === "function" ? jidNormalizedUser(jid) : jid);
            }
        }
        else {
            list.push(...buildStatusJidList());
        }
        if (meJid && meJid.includes("@"))
            list.push(meJid);
        return Array.from(new Set(list)).slice(0, 256);
    }
    async function sendStatusText(text, targets) {
        ensureConnected();
        const statusJidList = normalizeStatusJidList(targets);
        if (!statusJidList.length)
            throw new Error("Status post unavailable: no audience yet. Chat with at least one customer first.");
        const r = (await withTimeout(sock.sendMessage("status@broadcast", { text }, { statusJidList, broadcast: true }), 15_000, "Status send timed out."));
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
    }
    async function downloadBuffer(url) {
        const tries = 4;
        for (let attempt = 0; attempt < tries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60_000);
            try {
                const resp = await fetch(url, { signal: controller.signal });
                if (!resp.ok)
                    throw new Error(`Media download failed (${resp.status}).`);
                const ab = await resp.arrayBuffer();
                return Buffer.from(ab);
            }
            catch (e) {
                if (attempt >= tries - 1)
                    throw e instanceof Error ? e : new Error("Media download failed.");
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
            finally {
                clearTimeout(timeout);
            }
        }
        throw new Error("Media download failed.");
    }
    async function sendGroupImage(groupId, imageUrl, caption) {
        ensureConnected();
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        const buf = await downloadBuffer(imageUrl);
        const r = (await sock.sendMessage(groupId, { image: buf, caption: caption ?? "" }));
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
    }
    async function sendGroupProductImages(groupId, bodyText, footerText, cards, buttonText) {
        ensureConnected();
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        const waBase = getWaMeBase();
        if (!waBase)
            throw new Error("Cannot build DM link (missing device phone).");
        const upload = sock?.waUploadToServer;
        if (typeof upload !== "function")
            throw new Error("Baileys upload not available.");
        const displayText = typeof buttonText === "string" && buttonText.trim() ? buttonText.trim().slice(0, 18) : "View Details";
        const forwardToStatus = typeof buttonText === "string" && /forward\s*to\s*status/i.test(buttonText);
        const cmd = forwardToStatus ? "STATUS_PRODUCT" : "VIEW_PRODUCT";
        const list = (Array.isArray(cards) ? cards : [])
            .filter((c) => c && typeof c === "object")
            .map((c) => ({
            product_id: typeof c.product_id === "number" ? c.product_id : undefined,
            image_url: typeof c.image_url === "string" ? String(c.image_url).trim() : "",
            body: typeof c.body === "string" ? String(c.body).trim() : "",
            footer: typeof c.footer === "string" ? String(c.footer).trim() : "",
            url: typeof c.url === "string" ? String(c.url).trim() : "",
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
        if (!list.length)
            throw new Error("No valid product cards.");
        const intro = (bodyText ?? "").trim();
        const footer = (footerText ?? "").trim();
        const introParts = [intro, footer].filter((x) => x);
        let firstId = null;
        if (introParts.length) {
            firstId = (await sendGroupText(groupId, introParts.join("\n\n"))) ?? null;
        }
        const dmUrlForProduct = (id) => {
            return typeof id === "number" && Number.isFinite(id) ? `${waBase}?text=${encodeURIComponent(`${cmd} ${id}`)}` : waBase;
        };
        const buildCtaButtons = (c) => {
            const extras = Array.isArray(c.buttons) && c.buttons.length ? c.buttons.map((b) => ({ text: b.text, url: b.url })) : [];
            const primary = typeof c.product_id === "number" && Number.isFinite(c.product_id)
                ? { text: displayText, url: dmUrlForProduct(c.product_id) }
                : (c.url ? { text: displayText, url: c.url } : { text: displayText, url: waBase });
            const merged = [primary, ...extras];
            const seen = new Set();
            return merged
                .filter((b) => b.text && b.url)
                .filter((b) => {
                if (seen.has(b.url))
                    return false;
                seen.add(b.url);
                return true;
            })
                .slice(0, 24);
        };
        const chunks3 = (arr) => {
            const out = [];
            for (let i = 0; i < arr.length; i += 3)
                out.push(arr.slice(i, i + 3));
            return out;
        };
        for (const c of list) {
            const ctaButtons = buildCtaButtons(c);
            const firstBtn = ctaButtons.length ? ctaButtons[0] : null;
            const restChunks = chunks3(ctaButtons.slice(1));
            try {
                const buf = await withTimeout(downloadBuffer(c.image_url), 60_000, "Media download timed out.");
                const media = await withTimeout(Promise.resolve(prepareWAMessageMedia({ image: buf }, { upload })), 25_000, "Media prepare timed out.");
                const bodySafe = (c.body ?? "").trim().slice(0, 900);
                const footerSafe = ((c.footer ?? "").trim() || "Tap below to chat with us").slice(0, 60);
                const btnsFirst = firstBtn
                    ? [
                        {
                            name: "cta_url",
                            buttonParamsJson: JSON.stringify({
                                display_text: firstBtn.text.slice(0, 28),
                                url: firstBtn.url,
                                merchant_url: firstBtn.url,
                            }),
                        },
                    ]
                    : [];
                const msg = generateWAMessageFromContent(groupId, {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                            interactiveMessage: {
                                header: { title: "", hasMediaAttachment: true, ...media },
                                body: { text: bodySafe },
                                footer: { text: footerSafe },
                                nativeFlowMessage: {
                                    buttons: btnsFirst.length ? btnsFirst : undefined,
                                },
                            },
                        },
                    },
                }, { userJid: sock.user?.id });
                await withTimeout(sock.relayMessage(groupId, msg.message, { messageId: msg.key.id }), 15_000, "Interactive relay timed out.");
                if (!firstId)
                    firstId = msg.key.id;
                if (restChunks.length) {
                    for (const groupButtons of restChunks) {
                        await sendGroupCtaLinks(groupId, bodySafe, footerSafe, groupButtons);
                        await new Promise((r) => setTimeout(r, 150));
                    }
                }
            }
            catch (e) {
                const fallbackParts = [];
                const bodySafe = (c.body ?? "").trim().slice(0, 900);
                const footerSafe = (c.footer ?? "").trim().slice(0, 120);
                if (bodySafe)
                    fallbackParts.push(bodySafe);
                if (footerSafe)
                    fallbackParts.push(footerSafe);
                const fallbackUrl = typeof c.product_id === "number" && Number.isFinite(c.product_id) ? dmUrlForProduct(c.product_id) : (c.url ? c.url : "");
                if (fallbackUrl)
                    fallbackParts.push(fallbackUrl);
                try {
                    const id = await sendGroupImage(groupId, c.image_url, fallbackParts.join("\n\n").trim());
                    if (!firstId && id)
                        firstId = id;
                }
                catch (e2) {
                    handlers.onError(e2 instanceof Error ? e2.message : "Group drop failed.");
                }
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        return firstId;
    }
    async function sendGroupCtaLinks(groupId, bodyText, footerText, buttons) {
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        const list = (Array.isArray(buttons) ? buttons : [])
            .filter((b) => b && typeof b === "object")
            .map((b) => ({
            text: typeof b.text === "string" ? String(b.text).trim() : "",
            url: typeof b.url === "string" ? String(b.url).trim() : "",
        }))
            .filter((b) => b.text && b.url)
            .slice(0, 3);
        if (!list.length || typeof generateWAMessageFromContent !== "function")
            return null;
        const bodySafe = (bodyText ?? "").trim().slice(0, 900) || "Links";
        const footerSafe = (footerText ?? "").trim().slice(0, 60) || "Tap below";
        const msg = generateWAMessageFromContent(groupId, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: {
                        header: { title: "", hasMediaAttachment: false },
                        body: { text: bodySafe },
                        footer: { text: footerSafe },
                        nativeFlowMessage: {
                            buttons: list.map((b) => ({
                                name: "cta_url",
                                buttonParamsJson: JSON.stringify({
                                    display_text: b.text.slice(0, 28),
                                    url: b.url,
                                    merchant_url: b.url,
                                }),
                            })),
                        },
                    },
                },
            },
        }, { userJid: sock.user?.id });
        await withTimeout(sock.relayMessage(groupId, msg.message, { messageId: msg.key.id }), 15_000, "Interactive relay timed out.");
        return typeof msg.key?.id === "string" && msg.key.id.trim() ? msg.key.id : null;
    }
    async function sendGroupCtaCard(groupId, bodyText, footerText, prefillText, buttonText) {
        if (!groupId.endsWith("@g.us"))
            throw new Error("Invalid group id.");
        const waBase = getWaMeBase();
        if (!waBase)
            throw new Error("Cannot build DM link (missing device phone).");
        const bodySafe = (bodyText ?? "").trim().slice(0, 900);
        const footerSafe = (footerText ?? "").trim().slice(0, 60) || "Tap below to chat with us";
        const displayText = (buttonText ?? "").trim().slice(0, 18) || "Continue in DM";
        const prefill = (prefillText ?? "").trim();
        const url = prefill ? `${waBase}?text=${encodeURIComponent(prefill)}` : waBase;
        const msg = generateWAMessageFromContent(groupId, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: {
                        header: { title: "", hasMediaAttachment: false },
                        body: { text: bodySafe || "Continue in DM" },
                        footer: { text: footerSafe },
                        nativeFlowMessage: {
                            buttons: [
                                {
                                    name: "cta_url",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: `💬 ${displayText}`,
                                        url,
                                        merchant_url: url,
                                    }),
                                },
                            ],
                        },
                    },
                },
            },
        }, { userJid: sock.user?.id });
        await withTimeout(sock.relayMessage(groupId, msg.message, { messageId: msg.key.id }), 15_000, "Interactive relay timed out.");
        return typeof msg.key?.id === "string" && msg.key.id.trim() ? msg.key.id : null;
    }
    async function sendStatusImage(imageUrl, caption, targets) {
        const statusJidList = normalizeStatusJidList(targets);
        if (!statusJidList.length)
            throw new Error("Status post unavailable: no audience yet. Chat with at least one customer first.");
        try {
            const url = (imageUrl ?? "").trim();
            if (url.startsWith("http://") || url.startsWith("https://")) {
                const r = (await withTimeout(sock.sendMessage("status@broadcast", { image: { url }, caption: caption ?? "" }, { statusJidList, broadcast: true }), 20_000, "Status image send timed out."));
                const id = r?.key?.id;
                return typeof id === "string" && id.trim() ? id : null;
            }
        }
        catch {
        }
        const buf = await downloadBuffer(imageUrl);
        const r = (await withTimeout(sock.sendMessage("status@broadcast", { image: buf, caption: caption ?? "" }, { statusJidList, broadcast: true }), 20_000, "Status image send timed out."));
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
    }
    async function sendStatusVideo(videoUrl, caption, targets) {
        const url = (videoUrl ?? "").trim();
        if (!url)
            throw new Error("Invalid video url.");
        const statusJidList = normalizeStatusJidList(targets);
        if (!statusJidList.length)
            throw new Error("Status post unavailable: no audience yet. Chat with at least one customer first.");
        const lower = url.toLowerCase();
        const mimetype = lower.includes(".webm") ? "video/webm" : lower.includes(".3gp") ? "video/3gpp" : lower.includes(".mov") ? "video/quicktime" : "video/mp4";
        try {
            if (url.startsWith("http://") || url.startsWith("https://")) {
                const r = (await withTimeout(sock.sendMessage("status@broadcast", { video: { url }, mimetype, caption: caption ?? "" }, { statusJidList, broadcast: true }), 30_000, "Status video send timed out."));
                const id = r?.key?.id;
                return typeof id === "string" && id.trim() ? id : null;
            }
        }
        catch {
        }
        const buf = await downloadBuffer(url);
        const r = (await withTimeout(sock.sendMessage("status@broadcast", { video: buf, mimetype, caption: caption ?? "" }, { statusJidList, broadcast: true }), 30_000, "Status video send timed out."));
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
    }
    return {
        sock,
        stop,
        sendText,
        sendButtons,
        sendImage,
        sendVideo,
        requestPairingCode,
        listGroups,
        setGroupLocked,
        leaveGroup,
        sendGroupText,
        groupMentions,
        sendGroupImage,
        sendGroupProductImages,
        sendGroupCtaCard,
        sendGroupCtaLinks,
        sendStatusText,
        sendStatusImage,
        sendStatusVideo,
    };
}
