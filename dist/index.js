import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachEmitter, writeSseEvent } from "./sse.js";
import { getLogLines, installConsoleCapture } from "./logBuffer.js";
import { dropGroup, generatePairingCode, getRuntime, listRuntimes, listVendorGroups, listVendorMessages, purgeVendorData, postDrop, restartVendorRuntime, resetVendorRuntime, sendVendorButtons, sendVendorImage, sendVendorImages, sendVendorMedia, sendVendorVideo, sendVendorMessage, sendVendorBroadcast, setGroupLock, startVendorRuntime, updateVendorConfig, } from "./vendorRuntime.js";
const port = (() => {
    const raw = String(process.env.PORT ?? process.env.SERVER_PORT ?? process.env.P_SERVER_PORT ?? "8787").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 8787;
})();
const host = (process.env.HOST ?? "").trim() || "0.0.0.0";
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "").trim();
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const botSecret = (process.env.BOT_SERVER_SECRET ?? "").trim();
installConsoleCapture();
const serverStartedAt = new Date().toISOString();
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function resolveDataDir(raw, fallback) {
    const v = (raw ?? "").trim() || fallback;
    return path.isAbsolute(v) ? v : path.resolve(PKG_ROOT, v);
}
const SESSIONS_ROOT = resolveDataDir(process.env.SESSIONS_DIR, "./sessions");
console.log(`bot-server cwd=${process.cwd()} sessionsDir=${SESSIONS_ROOT}`);
process.on("uncaughtException", (err) => {
    try {
        process.stdout.write(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    }
    catch {
        void 0;
    }
});
process.on("unhandledRejection", (reason) => {
    try {
        process.stdout.write(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
    }
    catch {
        void 0;
    }
});
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()),
    credentials: true,
}));
app.get("/health", (_req, res) => {
    const v = process.env.BAILEYS_ENABLED ?? "";
    const baileysEnabled = v === "1" || v.toLowerCase() === "true";
    res.json({ ok: true, baileysEnabled });
});
app.get("/version", async (_req, res) => {
    try {
        const pkgPath = path.resolve(PKG_ROOT, "package.json");
        const distPath = path.resolve(PKG_ROOT, "dist", "index.js");
        const pkgRaw = await readFile(pkgPath, "utf8");
        const pkg = JSON.parse(pkgRaw);
        const st = await stat(distPath);
        res.json({
            ok: true,
            pid: process.pid,
            startedAt: serverStartedAt,
            node: process.version,
            pkg: { name: typeof pkg.name === "string" ? pkg.name : null, version: typeof pkg.version === "string" ? pkg.version : null },
            dist: { path: distPath, mtimeMs: st.mtimeMs },
        });
    }
    catch (e) {
        res.status(503).json({ ok: false, message: e instanceof Error ? e.message : "Version unavailable." });
    }
});
function getHeader(req, name) {
    const v = req.headers[name.toLowerCase()];
    if (typeof v === "string")
        return v;
    if (Array.isArray(v) && typeof v[0] === "string")
        return v[0];
    return "";
}
function isLoopbackRequest(req) {
    const ip = (req.ip ?? "").toLowerCase();
    if (ip === "127.0.0.1" || ip === "::1")
        return true;
    if (ip.startsWith("::ffff:127.0.0.1"))
        return true;
    const host = String(req.headers.host ?? "").toLowerCase();
    if (host.startsWith("127.0.0.1") || host.startsWith("localhost"))
        return true;
    return false;
}
function requireBotSecret(req, res, next) {
    if (isLoopbackRequest(req))
        return next();
    if (!botSecret)
        return next();
    const provided = getHeader(req, "x-bot-secret").trim();
    if (provided !== botSecret) {
        res.status(401).json({ message: "Unauthorized." });
        return;
    }
    next();
}
const buckets = new Map();
function takeRate(key, limit) {
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || now >= existing.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + 60_000 });
        return { ok: true };
    }
    existing.count += 1;
    if (existing.count > limit)
        return { ok: false, retryAfterMs: existing.resetAt - now };
    return { ok: true };
}
function vendorRateLimit(req, res, next) {
    const vendorId = req.params.vendorId ?? "unknown";
    const p = req.path;
    const group = p.startsWith("/events") ? "events" : p.startsWith("/broadcast") || p.startsWith("/drops") ? "send" : "default";
    const limit = group === "events" ? 30 : group === "send" ? 90 : 180;
    const r = takeRate(`vendor:${vendorId}:${group}`, limit);
    if (!r.ok) {
        res.status(429).json({ message: "Rate limit exceeded." });
        return;
    }
    next();
}
function isQrFresh(runtime, maxAgeMs = 25_000) {
    const at = runtime.lastQrAt;
    if (typeof at !== "number" || !Number.isFinite(at))
        return false;
    return Date.now() - at <= maxAgeMs;
}
function isBadSessionError(msg) {
    const m = (msg ?? "").toLowerCase();
    if (!m)
        return false;
    return (m.includes("bad mac") ||
        m.includes("restart required") ||
        m.includes("stream errored") ||
        m.includes("logged out") ||
        m.includes("code 515") ||
        m.includes("status code 515") ||
        m.includes("statuscode 515"));
}
app.param("vendorId", (req, res, next, vendorId) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(vendorId))) {
        res.status(422).json({ message: "Invalid vendorId." });
        return;
    }
    req.params.vendorId = String(vendorId);
    next();
});
app.use(requireBotSecret);
app.use("/vendors/:vendorId", vendorRateLimit);
app.get("/logs", (req, res) => {
    const limitRaw = typeof req.query.lines === "string" ? Number(req.query.lines) : typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, limitRaw)) : 200;
    res.json({ ok: true, lines: getLogLines(limit) });
});
app.get("/instances", (_req, res) => {
    res.json({
        instances: [
            {
                id: `bot-${process.pid}`,
                status: "online",
                pid: process.pid,
                uptime_seconds: Math.floor(process.uptime()),
                vendor_count: listRuntimes().length,
            },
        ],
    });
});
app.get("/vendors", (_req, res) => {
    res.json({ vendors: listRuntimes() });
});
function waitForVendorEvent(runtime, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            runtime.emitter.off("event", onEvent);
            resolve(null);
        }, Math.max(0, timeoutMs));
        const onEvent = (evt) => {
            if (!evt || typeof evt !== "object" || !("type" in evt))
                return;
            const e = evt;
            if (e.type === "qr" && typeof e.qr === "string") {
                clearTimeout(timer);
                runtime.emitter.off("event", onEvent);
                resolve({ type: "qr", qr: e.qr });
                return;
            }
            if (e.type === "status" && typeof e.status === "string") {
                clearTimeout(timer);
                runtime.emitter.off("event", onEvent);
                resolve({ type: "status", status: e.status });
                return;
            }
            if (e.type === "error" && typeof e.message === "string") {
                clearTimeout(timer);
                runtime.emitter.off("event", onEvent);
                resolve({ type: "error", message: e.message });
            }
        };
        runtime.emitter.on("event", onEvent);
    });
}
app.post("/vendors/:vendorId/connect", async (req, res) => {
    const vendorId = req.params.vendorId;
    try {
        let runtime = await startVendorRuntime(vendorId);
        if (runtime.status !== "connected" && runtime.registered === true && isBadSessionError(runtime.lastError)) {
            runtime = await resetVendorRuntime(vendorId);
        }
        if (runtime.status === "disconnected") {
            runtime = await restartVendorRuntime(vendorId);
        }
        if (runtime.status !== "connected" && runtime.lastQr && !isQrFresh(runtime, 60_000)) {
            runtime = await restartVendorRuntime(vendorId);
        }
        if (runtime.status === "connected") {
            res.json({ ok: true, vendorId, status: runtime.status, lastError: runtime.lastError ?? null });
            return;
        }
        if (runtime.lastQr && isQrFresh(runtime, 60_000)) {
            res.json({ ok: true, vendorId, status: runtime.status, qr: runtime.lastQr, lastError: runtime.lastError ?? null });
            return;
        }
        const evt = await waitForVendorEvent(runtime, 12_000);
        if (evt?.type === "qr") {
            res.json({ ok: true, vendorId, status: runtime.status, qr: evt.qr, lastError: runtime.lastError ?? null });
            return;
        }
        if (evt?.type === "error") {
            res.json({ ok: true, vendorId, status: runtime.status, lastError: evt.message });
            return;
        }
        if (evt?.type === "status") {
            res.json({ ok: true, vendorId, status: evt.status, lastError: runtime.lastError ?? null });
            return;
        }
        res.json({ ok: true, vendorId, status: runtime.status, lastError: runtime.lastError ?? null });
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Connect failed." });
    }
});
app.post("/vendors/:vendorId/reset", async (req, res) => {
    const vendorId = req.params.vendorId;
    try {
        const runtime = await resetVendorRuntime(vendorId);
        if (runtime.lastQr && isQrFresh(runtime, 60_000)) {
            res.json({ ok: true, vendorId, status: runtime.status, qr: runtime.lastQr, lastError: runtime.lastError ?? null });
            return;
        }
        const evt = await waitForVendorEvent(runtime, 12_000);
        if (evt?.type === "qr") {
            res.json({ ok: true, vendorId, status: runtime.status, qr: evt.qr, lastError: runtime.lastError ?? null });
            return;
        }
        if (evt?.type === "error") {
            res.json({ ok: true, vendorId, status: runtime.status, lastError: evt.message });
            return;
        }
        res.json({ ok: true, vendorId, status: runtime.status, lastError: runtime.lastError ?? null });
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Reset failed." });
    }
});
app.post("/vendors/:vendorId/purge", async (req, res) => {
    const vendorId = req.params.vendorId;
    try {
        await purgeVendorData(vendorId);
        res.json({ ok: true, vendorId });
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Purge failed." });
    }
});
app.get("/vendors/:vendorId/qr.png", async (req, res) => {
    const vendorId = req.params.vendorId;
    try {
        const runtime = await startVendorRuntime(vendorId);
        const qr = runtime.lastQr;
        if (!qr || !isQrFresh(runtime, 60_000)) {
            res.status(404).json({ message: "QR not available." });
            return;
        }
        const m = /^data:image\/png;base64,(.+)$/.exec(qr);
        if (!m?.[1]) {
            res.status(422).json({ message: "QR format invalid." });
            return;
        }
        const buf = Buffer.from(m[1], "base64");
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        res.status(200).send(buf);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "QR unavailable." });
    }
});
app.get("/vendors/:vendorId/groups", async (req, res) => {
    const vendorId = req.params.vendorId;
    try {
        const resp = await listVendorGroups(vendorId);
        if (!resp.ok) {
            res.status(503).json(resp);
            return;
        }
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "List groups failed." });
    }
});
app.post("/vendors/:vendorId/disconnect", async (req, res) => {
    const vendorId = req.params.vendorId;
    const runtime = getRuntime(vendorId);
    if (runtime)
        await runtime.stop();
    res.json({ ok: true, vendorId });
});
app.get("/vendors/:vendorId/events", async (req, res) => {
    const vendorId = req.params.vendorId;
    try {
        let runtime = await startVendorRuntime(vendorId);
        if (runtime.status !== "connected" && runtime.registered === true && isBadSessionError(runtime.lastError)) {
            runtime = await resetVendorRuntime(vendorId);
        }
        if (runtime.status === "disconnected") {
            runtime = await restartVendorRuntime(vendorId);
        }
        if (runtime.status !== "connected" && runtime.lastQr && !isQrFresh(runtime, 60_000)) {
            runtime = await restartVendorRuntime(vendorId);
        }
        attachEmitter(req, res, runtime.emitter);
        writeSseEvent(res, { type: "status", status: runtime.status });
        if (runtime.lastError)
            writeSseEvent(res, { type: "error", message: runtime.lastError });
        if (runtime.lastQr && isQrFresh(runtime, 60_000))
            writeSseEvent(res, { type: "qr", qr: runtime.lastQr });
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Events unavailable." });
    }
});
app.post("/vendors/:vendorId/messages", async (req, res) => {
    const vendorId = req.params.vendorId;
    const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : null;
    const imageUrl = typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : typeof req.body?.image_url === "string" ? req.body.image_url.trim() : "";
    const imageUrlsRaw = Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : Array.isArray(req.body?.image_urls) ? req.body.image_urls : null;
    const imageUrls = Array.isArray(imageUrlsRaw) ? imageUrlsRaw.filter((x) => typeof x === "string").map((x) => String(x).trim()).filter((x) => x !== "") : [];
    const videoUrl = typeof req.body?.videoUrl === "string" ? req.body.videoUrl.trim() : typeof req.body?.video_url === "string" ? req.body.video_url.trim() : "";
    const videoUrlsRaw = Array.isArray(req.body?.videoUrls)
        ? req.body.videoUrls
        : Array.isArray(req.body?.video_urls)
            ? req.body.video_urls
            : null;
    const videoUrls = Array.isArray(videoUrlsRaw) ? videoUrlsRaw.filter((x) => typeof x === "string").map((x) => String(x).trim()).filter((x) => x !== "") : [];
    const caption = typeof req.body?.caption === "string" ? req.body.caption : "";
    if (!to || (!text.trim() && !imageUrl && !imageUrls.length && !videoUrl && !videoUrls.length)) {
        res.status(422).json({ message: "to and (text or imageUrl or imageUrls or videoUrl or videoUrls) are required." });
        return;
    }
    try {
        if (imageUrls.length && (videoUrls.length || videoUrl)) {
            const vids = videoUrls.length ? videoUrls : videoUrl ? [videoUrl] : [];
            const cap = (caption || text || "").slice(0, 2000);
            console.log(`vendor ${vendorId}: queued ${imageUrls.length} image(s) + ${vids.length} video(s) to=${to}`);
            void sendVendorMedia(vendorId, to, imageUrls, vids, cap)
                .then((r) => console.log(`vendor ${vendorId}: media result ${JSON.stringify(r)}`))
                .catch((e) => console.log(`vendor ${vendorId}: media error ${e?.message ?? String(e)}`));
            res.status(202).json({ ok: true, queued: true });
            return;
        }
        if (imageUrls.length) {
            const cap = (caption || text || "").slice(0, 2000);
            console.log(`vendor ${vendorId}: queued ${imageUrls.length} image(s) to=${to}`);
            void sendVendorImages(vendorId, to, imageUrls, cap).then((r) => console.log(`vendor ${vendorId}: images result ${JSON.stringify(r)}`)).catch((e) => console.log(`vendor ${vendorId}: images error ${e?.message ?? String(e)}`));
            res.status(202).json({ ok: true, queued: true });
            return;
        }
        if (imageUrl) {
            const cap = (caption || text || "").slice(0, 2000);
            console.log(`vendor ${vendorId}: queued image to=${to}`);
            void sendVendorImage(vendorId, to, imageUrl, cap).then((r) => console.log(`vendor ${vendorId}: image result ${JSON.stringify(r)}`)).catch((e) => console.log(`vendor ${vendorId}: image error ${e?.message ?? String(e)}`));
            res.status(202).json({ ok: true, queued: true });
            return;
        }
        if (videoUrls.length) {
            const cap = (caption || text || "").slice(0, 2000);
            console.log(`vendor ${vendorId}: queued ${videoUrls.length} video(s) to=${to}`);
            void sendVendorMedia(vendorId, to, [], videoUrls, cap)
                .then((r) => console.log(`vendor ${vendorId}: videos result ${JSON.stringify(r)}`))
                .catch((e) => console.log(`vendor ${vendorId}: videos error ${e?.message ?? String(e)}`));
            res.status(202).json({ ok: true, queued: true });
            return;
        }
        if (videoUrl) {
            const cap = (caption || text || "").slice(0, 2000);
            console.log(`vendor ${vendorId}: queued video to=${to}`);
            void sendVendorVideo(vendorId, to, videoUrl, cap)
                .then((r) => console.log(`vendor ${vendorId}: video result ${JSON.stringify(r)}`))
                .catch((e) => console.log(`vendor ${vendorId}: video error ${e?.message ?? String(e)}`));
            res.status(202).json({ ok: true, queued: true });
            return;
        }
        if (buttons && buttons.length) {
            const list = buttons
                .filter((b) => b && typeof b === "object")
                .map((b) => ({
                id: typeof b.id === "string" ? b.id.trim() : "",
                text: typeof b.text === "string" ? b.text : "",
            }))
                .filter((b) => b.id && b.text);
            const resp = await sendVendorButtons(vendorId, to, text, list);
            if (!resp.ok) {
                res.status(503).json(resp);
                return;
            }
            res.json(resp);
            return;
        }
        const resp = await sendVendorMessage(vendorId, to, text);
        if (!resp.ok) {
            res.status(503).json(resp);
            return;
        }
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Send failed." });
    }
});
app.post("/vendors/:vendorId/broadcast", async (req, res) => {
    const vendorId = req.params.vendorId;
    const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const delayMsRaw = typeof req.body?.delay_ms === "number" ? req.body.delay_ms : typeof req.body?.delayMs === "number" ? req.body.delayMs : 250;
    const delayMs = Number.isFinite(delayMsRaw) ? Math.max(0, Math.min(2000, delayMsRaw)) : 250;
    const list = recipients.filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "");
    if (!list.length || !text.trim()) {
        res.status(422).json({ message: "recipients and text are required." });
        return;
    }
    if (list.length > 200) {
        res.status(422).json({ message: "max 200 recipients." });
        return;
    }
    if (text.length > 2000) {
        res.status(422).json({ message: "max 2000 chars." });
        return;
    }
    try {
        const resp = await sendVendorBroadcast(vendorId, list, text, delayMs);
        if (!resp.ok) {
            res.status(503).json(resp);
            return;
        }
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Broadcast failed." });
    }
});
app.put("/vendors/:vendorId/config", async (req, res) => {
    const vendorId = req.params.vendorId;
    const strategyMode = typeof req.body?.strategyMode === "string" ? req.body.strategyMode : undefined;
    const escalationKeywords = Array.isArray(req.body?.escalationKeywords) ? req.body.escalationKeywords : undefined;
    const allowed = strategyMode === "ai_lead" ? strategyMode : undefined;
    const keywords = escalationKeywords && escalationKeywords.every((x) => typeof x === "string") ? escalationKeywords : undefined;
    const resp = await updateVendorConfig(vendorId, { strategyMode: allowed, escalationKeywords: keywords });
    res.json(resp);
});
app.post("/vendors/:vendorId/groups/lock", async (req, res) => {
    const vendorId = req.params.vendorId;
    const key = typeof req.body?.id === "string"
        ? req.body.id.trim()
        : typeof req.body?.name === "string"
            ? req.body.name.trim()
            : "";
    const locked = typeof req.body?.locked === "boolean" ? req.body.locked : null;
    if (!key || locked === null) {
        res.status(422).json({ message: "id (or name) and locked are required." });
        return;
    }
    try {
        const resp = await setGroupLock(vendorId, key, locked);
        if (!resp.ok) {
            res.status(503).json(resp);
            return;
        }
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Group lock failed." });
    }
});
app.post("/vendors/:vendorId/groups/drop", async (req, res) => {
    const vendorId = req.params.vendorId;
    const key = typeof req.body?.id === "string"
        ? req.body.id.trim()
        : typeof req.body?.name === "string"
            ? req.body.name.trim()
            : "";
    if (!key) {
        res.status(422).json({ message: "id (or name) is required." });
        return;
    }
    try {
        const resp = await dropGroup(vendorId, key);
        if (!resp.ok) {
            res.status(503).json(resp);
            return;
        }
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Drop group failed." });
    }
});
app.post("/vendors/:vendorId/drops", async (req, res) => {
    const vendorId = req.params.vendorId;
    const channel = req.body?.channel === "group" || req.body?.channel === "status" ? req.body.channel : null;
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const lockBefore = req.body?.lockBefore === true || req.body?.lock_before === true || req.body?.lock === true ? true : false;
    const unlockAfterSecondsRaw = typeof req.body?.unlockAfterSeconds === "number"
        ? req.body.unlockAfterSeconds
        : typeof req.body?.unlock_after_seconds === "number"
            ? req.body.unlock_after_seconds
            : null;
    const unlockAfterSeconds = unlockAfterSecondsRaw !== null && Number.isFinite(unlockAfterSecondsRaw) ? unlockAfterSecondsRaw : 0;
    const mediaUrls = Array.isArray(req.body?.media_urls)
        ? req.body.media_urls.filter((x) => typeof x === "string")
        : [];
    const mediaUrl = typeof req.body?.mediaUrl === "string"
        ? req.body.mediaUrl
        : typeof req.body?.media_url === "string"
            ? req.body.media_url
            : "";
    const mentionAll = req.body?.mentionAll === true || req.body?.mention_all === true ? true : false;
    const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : undefined;
    const productCards = (req.body?.productCards && typeof req.body.productCards === "object"
        ? req.body.productCards
        : req.body?.product_cards && typeof req.body.product_cards === "object"
            ? req.body.product_cards
            : undefined) ?? undefined;
    if (!channel || !text.trim()) {
        res.status(422).json({ message: "channel and text are required." });
        return;
    }
    try {
        const resp = await postDrop(vendorId, {
            channel,
            targets: targets.filter((x) => typeof x === "string"),
            text,
            lockBefore,
            unlockAfterSeconds,
            mediaUrl,
            mediaUrls,
            mentionAll,
            meta,
            productCards,
        });
        if (!resp.ok) {
            res.status(503).json(resp);
            return;
        }
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Drop failed." });
    }
});
app.get("/vendors/:vendorId/messages", async (req, res) => {
    const vendorId = req.params.vendorId;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, limitRaw)) : 200;
    const messages = await listVendorMessages(vendorId);
    res.json({ messages: messages.slice(0, limit) });
});
app.post("/vendors/:vendorId/inbound", async (req, res) => {
    res.status(404).json({ message: "Not found." });
});
app.post("/vendors/:vendorId/pairing-code", async (req, res) => {
    const vendorId = req.params.vendorId;
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    if (!phone) {
        res.status(422).json({ message: "phone is required." });
        return;
    }
    try {
        const resp = await generatePairingCode(vendorId, phone);
        res.json(resp);
    }
    catch (e) {
        res.status(503).json({ message: e instanceof Error ? e.message : "Pairing code failed." });
    }
});
async function listSessionVendorIds() {
    try {
        const entries = await readdir(SESSIONS_ROOT, { withFileTypes: true });
        const ids = [];
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const m = /^vendor_id_(\d{1,18})$/.exec(e.name);
            if (m?.[1])
                ids.push(m[1]);
        }
        return ids;
    }
    catch {
        return [];
    }
}
async function isVendorSessionRegistered(vendorId) {
    const credsPath = path.join(SESSIONS_ROOT, `vendor_id_${vendorId}`, "creds.json");
    try {
        const raw = await readFile(credsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object")
            return false;
        const obj = parsed;
        return obj["registered"] === true;
    }
    catch {
        return false;
    }
}
async function bootstrapRuntimes() {
    const vendorIds = await listSessionVendorIds();
    for (const vendorId of vendorIds) {
        try {
            const registered = await isVendorSessionRegistered(vendorId);
            if (!registered)
                continue;
            const existing = getRuntime(vendorId);
            if (!existing)
                await startVendorRuntime(vendorId);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "Bootstrap failed.";
            process.stdout.write(`bootstrap: vendor ${vendorId}: ${msg}\n`);
        }
    }
}
async function reconcileRuntimes() {
    const vendorIds = await listSessionVendorIds();
    for (const vendorId of vendorIds) {
        try {
            const registered = await isVendorSessionRegistered(vendorId);
            if (!registered)
                continue;
            const existing = getRuntime(vendorId);
            if (!existing) {
                await startVendorRuntime(vendorId);
                continue;
            }
            if (existing.status === "disconnected") {
                await restartVendorRuntime(vendorId);
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : "Reconcile failed.";
            process.stdout.write(`reconcile: vendor ${vendorId}: ${msg}\n`);
        }
    }
}
app.listen(port, host, () => {
    const localUrl = host === "0.0.0.0" ? `http://127.0.0.1:${port}` : `http://${host}:${port}`;
    process.stdout.write(`bot-server listening on ${localUrl}\n`);
    const pterodactylIp = (process.env.SERVER_IP ?? process.env.P_SERVER_IP ?? "").trim();
    const pterodactylPort = (process.env.SERVER_PORT ?? process.env.P_SERVER_PORT ?? "").trim();
    const inferredPublic = pterodactylIp ? `http://${pterodactylIp}:${pterodactylPort || String(port)}` : "";
    const publicUrl = (publicBaseUrl || inferredPublic).replace(/\/$/, "");
    if (publicUrl)
        process.stdout.write(`bot-server public url: ${publicUrl}\n`);
    else
        process.stdout.write(`bot-server public url: (set PUBLIC_BASE_URL to show your domain)\n`);
    process.stdout.write(`bot-server port=${port} corsOrigin=${corsOrigin}\n`);
    void bootstrapRuntimes();
    setInterval(() => void reconcileRuntimes(), 45_000);
});
