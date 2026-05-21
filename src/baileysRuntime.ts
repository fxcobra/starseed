import * as baileys from "@itsliaaa/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { createEllbot } from "./ellbot.js";

type WASocket = any;

export type BaileysHandlers = {
  onStatus: (status: "connecting" | "connected" | "disconnected") => void;
  onQr: (qr: string) => void;
  onRegistered?: (registered: boolean) => void;
  onInboundMessage: (msg: {
    id: string;
    from: string;
    participant?: string;
    pushName?: string;
    text: string;
    at: string;
    quotedMessageId?: string;
    quotedRemoteJid?: string;
    quotedParticipant?: string;
    isStatusReply?: boolean;
    mentionedJids?: string[];
    mentionsMe?: boolean;
  }) => void;
  onError: (message: string) => void;
};

export type BaileysGroup = { id: string; name: string; participantsCount: number };

const makeWASocket: any = (baileys as any)?.default ?? (baileys as any)?.makeWASocket;
const DisconnectReason: any = (baileys as any)?.DisconnectReason;
const fetchLatestBaileysVersion: any = (baileys as any)?.fetchLatestBaileysVersion;
const jidNormalizedUser: any = (baileys as any)?.jidNormalizedUser;
const useMultiFileAuthState: any = (baileys as any)?.useMultiFileAuthState;
const makeInMemoryStore: any = (baileys as any)?.makeInMemoryStore;
const prepareWAMessageMedia: any = (baileys as any)?.prepareWAMessageMedia;
const proto: any = (baileys as any)?.proto;
const generateWAMessageFromContent: any = (baileys as any)?.generateWAMessageFromContent;

function isEnabled() {
  const v = process.env.BAILEYS_ENABLED ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

function cleanPhone(raw: string) {
  const t = raw.trim();
  if (!t) return "";
  const hasPlus = t.startsWith("+");
  const digits = t.replace(/[^\d]/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

function unwrapMessage(m: unknown): unknown {
  let cur: unknown = m;
  for (let i = 0; i < 6; i++) {
    if (!cur || typeof cur !== "object") return cur;
    const obj = cur as Record<string, unknown>;
    const eph = obj["ephemeralMessage"];
    if (eph && typeof eph === "object") {
      const inner = (eph as Record<string, unknown>)["message"];
      if (inner) {
        cur = inner;
        continue;
      }
    }
    const vo = obj["viewOnceMessageV2"];
    if (vo && typeof vo === "object") {
      const inner = (vo as Record<string, unknown>)["message"];
      if (inner) {
        cur = inner;
        continue;
      }
    }
    const voe = obj["viewOnceMessageV2Extension"];
    if (voe && typeof voe === "object") {
      const inner = (voe as Record<string, unknown>)["message"];
      if (inner) {
        cur = inner;
        continue;
      }
    }
    return cur;
  }
  return cur;
}

function extractText(message: unknown): string {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped || typeof unwrapped !== "object") return "";
  const m = unwrapped as Record<string, unknown>;
  const irm = m["interactiveResponseMessage"];
  if (irm && typeof irm === "object") {
    const nfrm = (irm as Record<string, unknown>)["nativeFlowResponseMessage"];
    if (nfrm && typeof nfrm === "object") {
      const paramsJson = (nfrm as Record<string, unknown>)["paramsJson"];
      if (typeof paramsJson === "string") {
        try {
          const parsed = JSON.parse(paramsJson) as unknown;
          const p = parsed && typeof parsed === "object" ? (parsed as any) : null;
          const id =
            typeof p?.id === "string"
              ? p.id
              : typeof p?.params?.id === "string"
                ? p.params.id
                : typeof p?.button_reply?.id === "string"
                  ? p.button_reply.id
                  : typeof p?.reply?.id === "string"
                    ? p.reply.id
                    : null;
          if (typeof id === "string" && id.trim()) return id.trim();
        } catch {
          void 0;
        }
      }
    }
  }
  const tbr = m["templateButtonReplyMessage"];
  if (tbr && typeof tbr === "object") {
    const id = (tbr as Record<string, unknown>)["selectedId"];
    if (typeof id === "string" && id.trim()) return id;
    const t = (tbr as Record<string, unknown>)["selectedDisplayText"];
    if (typeof t === "string" && t.trim()) return t;
  }
  const buttons = m["buttonsResponseMessage"];
  if (buttons && typeof buttons === "object") {
    const id = (buttons as Record<string, unknown>)["selectedButtonId"];
    if (typeof id === "string" && id.trim()) return id;
    const t = (buttons as Record<string, unknown>)["selectedDisplayText"];
    if (typeof t === "string" && t.trim()) return t;
  }
  const list = m["listResponseMessage"];
  if (list && typeof list === "object") {
    const ssr = (list as Record<string, unknown>)["singleSelectReply"];
    if (ssr && typeof ssr === "object") {
      const rowId = (ssr as Record<string, unknown>)["selectedRowId"];
      if (typeof rowId === "string" && rowId.trim()) return rowId;
      const title = (ssr as Record<string, unknown>)["title"];
      if (typeof title === "string" && title.trim()) return title;
    }
  }
  const conv = m["conversation"];
  if (typeof conv === "string") return conv;
  const ext = m["extendedTextMessage"];
  if (ext && typeof ext === "object") {
    const t = (ext as Record<string, unknown>)["text"];
    if (typeof t === "string") return t;
  }
  const img = m["imageMessage"];
  if (img && typeof img === "object") {
    const c = (img as Record<string, unknown>)["caption"];
    if (typeof c === "string") return c;
  }
  const vid = m["videoMessage"];
  if (vid && typeof vid === "object") {
    const c = (vid as Record<string, unknown>)["caption"];
    if (typeof c === "string") return c;
  }
  const doc = m["documentMessage"];
  if (doc && typeof doc === "object") {
    const c = (doc as Record<string, unknown>)["caption"];
    if (typeof c === "string") return c;
  }
  return "";
}

function extractContext(message: unknown): {
  quotedMessageId?: string;
  quotedRemoteJid?: string;
  quotedParticipant?: string;
  isStatusReply?: boolean;
  mentionedJids?: string[];
} {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped || typeof unwrapped !== "object") return {};
  const m = unwrapped as Record<string, unknown>;

  const ctxs: any[] = [];
  for (const k of ["extendedTextMessage", "imageMessage", "videoMessage", "documentMessage"]) {
    const obj = m[k];
    if (obj && typeof obj === "object") {
      const ctx = (obj as Record<string, unknown>)["contextInfo"];
      if (ctx && typeof ctx === "object") ctxs.push(ctx);
    }
  }
  const ctx = ctxs.find((x) => x && typeof x === "object") as Record<string, unknown> | undefined;
  if (ctx) {
    const stanzaId = typeof ctx["stanzaId"] === "string" ? ctx["stanzaId"] : "";
    const remoteJid = typeof ctx["remoteJid"] === "string" ? ctx["remoteJid"] : "";
    const quotedParticipant = typeof ctx["participant"] === "string" ? ctx["participant"] : undefined;
    const quotedMessageId = stanzaId.trim() ? stanzaId.trim() : undefined;
    const quotedRemoteJid = remoteJid.trim() ? remoteJid.trim() : undefined;
    const isStatusReply = quotedRemoteJid === "status@broadcast";
    const mentionedJids = Array.isArray(ctx["mentionedJid"])
      ? (ctx["mentionedJid"] as unknown[])
          .filter((x: unknown): x is string => typeof x === "string" && String(x).trim().length > 0)
          .map((x: string) => x.trim())
          .slice(0, 50)
      : undefined;
    return { quotedMessageId, quotedRemoteJid, quotedParticipant, isStatusReply, mentionedJids };
  }

  return {};
}

export async function startBaileysRuntime(vendorId: string, sessionDir: string, handlers: BaileysHandlers) {
  if (!isEnabled()) {
    throw new Error("Baileys disabled.");
  }
  if (typeof makeWASocket !== "function") {
    throw new Error("Baileys makeWASocket is not available.");
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  handlers.onRegistered?.(Boolean((state as any)?.creds?.registered));
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" }) as any;

  handlers.onStatus("connecting");

  const sock: WASocket = makeWASocket({
    version,
    auth: state as any,
    logger,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  const store = typeof makeInMemoryStore === "function" ? makeInMemoryStore({ logger }) : null;
  if (store && typeof store.bind === "function") {
    store.bind((sock as any).ev);
  }

  const statusAudience = new Set<string>();
  let cachedMePhone = "";
  function updateCachedMePhoneFromSock() {
    const me = typeof (sock as any)?.user?.id === "string" ? String((sock as any).user.id) : "";
    const meBase = me.includes("@") ? me.split("@")[0] : me;
    const phone = meBase.split(":")[0].replace(/\D/g, "");
    if (phone) cachedMePhone = phone;
  }
  updateCachedMePhoneFromSock();
  function getWaMeBase() {
    updateCachedMePhoneFromSock();
    const phone = cachedMePhone;
    return phone ? `https://wa.me/${phone}` : "";
  }
  function buildStatusJidList(): string[] {
    const list = Array.from(statusAudience);
    try {
      const chats = store && typeof store === "object" ? (store as any).chats : null;
      if (chats && typeof chats === "object") {
        for (const jid of Object.keys(chats)) {
          if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) list.push(jid);
        }
      }
      const contacts = store && typeof store === "object" ? (store as any).contacts : null;
      if (contacts && typeof contacts === "object") {
        for (const jid of Object.keys(contacts)) {
          if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) list.push(jid);
        }
      }
    } catch {
      void 0;
    }
    const meJid = typeof (sock as any)?.user?.id === "string" ? String((sock as any).user.id) : "";
    if (meJid && meJid.includes("@")) list.push(meJid);
    return Array.from(new Set(list)).slice(0, 256);
  }

  function trackStatusAudience(jid: string) {
    const j = (jid ?? "").trim();
    if (!j) return;
    if (j.endsWith("@s.whatsapp.net") || j.endsWith("@lid")) statusAudience.add(j);
  }

  function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      void p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
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

  const processedInbound = new Map<string, number>();
  function seenInbound(remoteJid: string, messageId: string) {
    const id = (messageId ?? "").trim();
    const from = (remoteJid ?? "").trim();
    if (!id || !from) return false;
    const key = `${from}:${id}`;
    const now = Date.now();
    const prev = processedInbound.get(key);
    if (typeof prev === "number" && now - prev < 10 * 60_000) return true;
    processedInbound.set(key, now);
    if (processedInbound.size > 3000) {
      const cutoff = now - 10 * 60_000;
      for (const [k, ts] of processedInbound) {
        if (ts < cutoff) processedInbound.delete(k);
      }
    }
    return false;
  }

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    handlers.onRegistered?.(Boolean((state as any)?.creds?.registered));
  });

  sock.ev.on("connection.update", async (update: any) => {
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
        const code = (err as unknown as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          handlers.onError("Logged out.");
        } else {
          let msg = err instanceof Error ? err.message : err ? String(err) : "";
          if (msg === "[object Object]" || msg.toLowerCase().includes("object object")) {
            try {
              msg = JSON.stringify(err);
            } catch {
              void 0;
            }
          }
          const label = typeof code === "number" ? `code ${code}` : "unknown code";
          handlers.onError(msg ? `Connection closed (${label}): ${msg}` : `Connection closed (${label}).`);
        }
        handlers.onStatus("disconnected");
      }
    } catch (e: unknown) {
      handlers.onError(e instanceof Error ? e.message : "Connection update error.");
    }
  });

  sock.ev.on("messages.upsert", (upsert: any) => {
    try {
      const list = Array.isArray(upsert?.messages) ? upsert.messages : [];
      for (const msg of list) {
        if (!msg) continue;
        if ((msg as any)?.key?.fromMe) continue;
        const from = typeof (msg as any)?.key?.remoteJid === "string" ? String((msg as any).key.remoteJid) : "";
        if (!from) continue;
        const msgKeyId = typeof (msg as any)?.key?.id === "string" ? String((msg as any).key.id) : "";
        if (msgKeyId && seenInbound(from, msgKeyId)) continue;
        if (from.endsWith("@s.whatsapp.net") || from.endsWith("@lid")) {
          statusAudience.add(from);
        }
        const text = extractText((msg as any).message);
        if (!text.trim()) continue;
        const pushName = typeof (msg as any).pushName === "string" ? String((msg as any).pushName).slice(0, 200) : undefined;
        const at = new Date().toISOString();
        const id = msgKeyId ? msgKeyId : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const participant =
          typeof (msg as any)?.key?.participant === "string"
            ? String((msg as any).key.participant)
            : typeof (msg as any)?.participant === "string"
              ? String((msg as any).participant)
              : undefined;
        const ctx = extractContext((msg as any).message);
        const mentioned = Array.isArray((ctx as any)?.mentionedJids) ? ((ctx as any).mentionedJids as string[]) : [];
        const quotedParticipant = typeof (ctx as any)?.quotedParticipant === "string" ? String((ctx as any).quotedParticipant) : "";
        const me = typeof (sock as any)?.user?.id === "string" ? String((sock as any).user.id) : "";
        const meNorm = me ? jidNormalizedUser(me) : "";
        const meDigits = meNorm ? (meNorm.split("@")[0] ?? "").replace(/[^\d]/g, "") : "";
        const mentionsMe =
          Boolean(meNorm) &&
          (mentioned.some((j) => {
            try {
              const jNorm = jidNormalizedUser(j);
              if (jNorm === meNorm) return true;
              const jDigits = (jNorm.split("@")[0] ?? "").replace(/[^\d]/g, "");
              return Boolean(meDigits) && Boolean(jDigits) && meDigits === jDigits;
            } catch {
              return false;
            }
          }) ||
            (Boolean(meDigits) && String(text).includes(`@${meDigits}`)) ||
            (Boolean(quotedParticipant) &&
              (() => {
                try {
                  const qpNorm = jidNormalizedUser(quotedParticipant);
                  if (qpNorm === meNorm) return true;
                  const qpDigits = (qpNorm.split("@")[0] ?? "").replace(/[^\d]/g, "");
                  return Boolean(meDigits) && Boolean(qpDigits) && meDigits === qpDigits;
                } catch {
                  const qpDigits = (quotedParticipant.split("@")[0] ?? "").replace(/[^\d]/g, "");
                  return Boolean(meDigits) && Boolean(qpDigits) && meDigits === qpDigits;
                }
              })()));
        handlers.onInboundMessage({ id, from, participant, pushName, text, at, ...ctx, mentionsMe });
        if (from.endsWith("@g.us") || from === "status@broadcast") continue;
        void (async () => {
          try {
            await ellbot.handleDm(from, text, pushName);
          } catch (e: unknown) {
            handlers.onError(e instanceof Error ? e.message : "ellbot handler failed.");
          }
        })();
      }
    } catch (e: unknown) {
      handlers.onError(e instanceof Error ? e.message : "Inbound parse error.");
    }
  });

  async function stop() {
    try {
      const ws = (sock as any)?.ws ?? (sock as any)?.wsClient?.ws;
      if (ws && typeof ws.on === "function") {
        ws.on("error", () => void 0);
      }
      if (ws && ws.readyState === 0 && typeof ws.terminate === "function") {
        ws.terminate();
        return;
      }
      sock.end(undefined);
    } catch {
      void 0;
    }
  }

  async function sendText(to: string, text: string) {
    const target = (to ?? "").trim();
    if (!target) throw new Error("Invalid recipient.");
    if (target.includes("@")) {
      trackStatusAudience(target);
      await sock.sendMessage(target, { text });
      return;
    }
    const phone = cleanPhone(target);
    if (!phone) throw new Error("Invalid phone.");
    const jid = jidNormalizedUser(phone.replace("+", "") + "@s.whatsapp.net");
    trackStatusAudience(jid);
    await sock.sendMessage(jid, { text });
  }

  async function sendButtons(to: string, text: string, buttons: Array<{ id: string; text: string }>) {
    const target = (to ?? "").trim();
    if (!target) throw new Error("Invalid recipient.");
    const jid = target.includes("@") ? target : jidNormalizedUser(cleanPhone(target).replace("+", "") + "@s.whatsapp.net");
    trackStatusAudience(jid);

    const btns = (Array.isArray(buttons) ? buttons : [])
      .filter((b) => b && typeof b === "object" && typeof (b as any).id === "string" && typeof (b as any).text === "string")
      .slice(0, 3)
      .map((b) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: String((b as any).text).slice(0, 28),
          id: String((b as any).id).slice(0, 40),
        }),
      }));

    if (!btns.length || typeof generateWAMessageFromContent !== "function") {
      await sendText(to, text);
      return;
    }

    const msg = generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              body: { text },
              nativeFlowMessage: { buttons: btns },
            },
          },
        },
      } as any,
      { userJid: (sock as any)?.user?.id }
    );
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  }

  async function sendImage(to: string, imageUrl: string, caption?: string) {
    const target = (to ?? "").trim();
    if (!target) throw new Error("Invalid recipient.");
    const url = (imageUrl ?? "").trim();
    if (!url) throw new Error("Invalid image url.");
    const jid = target.includes("@") ? target : jidNormalizedUser(cleanPhone(target).replace("+", "") + "@s.whatsapp.net");
    trackStatusAudience(jid);
    const cap = typeof caption === "string" ? caption.trim() : "";
    try {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const content: any = { image: { url } };
        if (cap) content.caption = cap;
        await sock.sendMessage(jid, content);
        return;
      }
    } catch {
    }
    const buf = await downloadBuffer(url);
    const content: any = { image: buf };
    if (cap) content.caption = cap;
    await sock.sendMessage(jid, content);
  }

  async function sendVideo(to: string, videoUrl: string, caption?: string) {
    const target = (to ?? "").trim();
    if (!target) throw new Error("Invalid recipient.");
    const url = (videoUrl ?? "").trim();
    if (!url) throw new Error("Invalid video url.");
    const jid = target.includes("@") ? target : jidNormalizedUser(cleanPhone(target).replace("+", "") + "@s.whatsapp.net");
    trackStatusAudience(jid);
    const cap = typeof caption === "string" ? caption.trim() : "";
    const lower = url.toLowerCase();
    const mimetype =
      lower.includes(".webm") ? "video/webm" : lower.includes(".3gp") ? "video/3gpp" : lower.includes(".mov") ? "video/quicktime" : "video/mp4";
    try {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const content: any = { video: { url } };
        content.mimetype = mimetype;
        if (cap) content.caption = cap;
        await sock.sendMessage(jid, content);
        return;
      }
    } catch {
    }
    const buf = await downloadBuffer(url);
    const content: any = { video: buf };
    content.mimetype = mimetype;
    if (cap) content.caption = cap;
    await sock.sendMessage(jid, content);
  }

  async function requestPairingCode(phone: string) {
    const cleaned = cleanPhone(phone).replace("+", "");
    if (!cleaned) throw new Error("Invalid phone.");
    if (!("requestPairingCode" in sock)) throw new Error("Pairing not supported.");
    const fn = (sock as unknown as { requestPairingCode: (n: string) => Promise<string> }).requestPairingCode;
    return await fn(cleaned);
  }

  async function listGroups(): Promise<BaileysGroup[]> {
    const all = (await sock.groupFetchAllParticipating()) as Record<string, any>;
    const groups: BaileysGroup[] = Object.entries(all ?? {}).map(([id, g]) => ({
      id,
      name: g.subject ?? id,
      participantsCount: Array.isArray(g.participants) ? g.participants.length : 0,
    }));
    groups.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  }

  async function setGroupLocked(groupId: string, locked: boolean) {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    await sock.groupSettingUpdate(groupId, locked ? "announcement" : "not_announcement");
  }

  async function leaveGroup(groupId: string) {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    await sock.groupLeave(groupId);
  }

  async function groupMentions(groupId: string): Promise<string[]> {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    const md = await sock.groupMetadata(groupId);
    const parts = Array.isArray((md as any)?.participants) ? ((md as any).participants as any[]) : [];
    const ids: string[] = [];
    for (const p of parts) {
      const id = typeof p?.id === "string" ? String(p.id) : "";
      if (!id) continue;
      if (!id.endsWith("@s.whatsapp.net") && !id.endsWith("@lid")) continue;
      ids.push(id);
    }
    return Array.from(new Set(ids)).slice(0, 40);
  }

  async function sendGroupText(groupId: string, text: string, mentions?: string[]): Promise<string | null> {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    const m = Array.isArray(mentions) ? mentions.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()) : [];
    const r = (await sock.sendMessage(groupId, ({ text, ...(m.length ? { mentions: m } : {}) } as unknown) as any)) as unknown as
      | { key?: { id?: string } }
      | undefined;
    const id = r?.key?.id;
    return typeof id === "string" && id.trim() ? id : null;
  }

  function normalizeStatusJidList(targets?: string[]): string[] {
    const meJid = typeof (sock as any)?.user?.id === "string" ? String((sock as any).user.id) : "";
    const list: string[] = [];

    if (Array.isArray(targets) && targets.length) {
      for (const t of targets) {
        const raw = typeof t === "string" ? t.trim() : "";
        if (!raw) continue;
        if (raw.endsWith("@s.whatsapp.net") || raw.endsWith("@lid")) {
          list.push(raw);
          continue;
        }
        const phone = cleanPhone(raw).replace(/^\+/, "");
        if (!phone) continue;
        const jid = `${phone}@s.whatsapp.net`;
        list.push(typeof jidNormalizedUser === "function" ? jidNormalizedUser(jid) : jid);
      }
    } else {
      list.push(...buildStatusJidList());
    }

    if (meJid && meJid.includes("@")) list.push(meJid);
    return Array.from(new Set(list)).slice(0, 256);
  }

  async function sendStatusText(text: string, targets?: string[]): Promise<string | null> {
    const statusJidList = normalizeStatusJidList(targets);
    if (!statusJidList.length) throw new Error("Status post unavailable: no audience yet. Chat with at least one customer first.");
    const r = (await withTimeout(
      sock.sendMessage("status@broadcast", { text }, { statusJidList, broadcast: true }),
      15_000,
      "Status send timed out."
    )) as unknown as
      | { key?: { id?: string } }
      | undefined;
    const id = r?.key?.id;
    return typeof id === "string" && id.trim() ? id : null;
  }

  async function downloadBuffer(url: string) {
    const tries = 4;
    for (let attempt = 0; attempt < tries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error(`Media download failed (${resp.status}).`);
        const ab = await resp.arrayBuffer();
        return Buffer.from(ab);
      } catch (e: unknown) {
        if (attempt >= tries - 1) throw e instanceof Error ? e : new Error("Media download failed.");
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("Media download failed.");
  }

  async function sendGroupImage(groupId: string, imageUrl: string, caption?: string): Promise<string | null> {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    const buf = await downloadBuffer(imageUrl);
    const r = (await sock.sendMessage(groupId, { image: buf, caption: caption ?? "" })) as unknown as
      | { key?: { id?: string } }
      | undefined;
    const id = r?.key?.id;
    return typeof id === "string" && id.trim() ? id : null;
  }

  async function sendGroupProductImages(
    groupId: string,
    bodyText: string,
    footerText: string,
    cards: Array<{ product_id?: number; image_url: string; body: string; footer?: string; url?: string }>,
    buttonText?: string
  ): Promise<string | null> {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    const waBase = getWaMeBase();
    if (!waBase) throw new Error("Cannot build DM link (missing device phone).");
    const upload = (sock as any)?.waUploadToServer;
    if (typeof upload !== "function") throw new Error("Baileys upload not available.");
    const displayText = typeof buttonText === "string" && buttonText.trim() ? buttonText.trim().slice(0, 18) : "View Details";
    const forwardToStatus = typeof buttonText === "string" && /forward\s*to\s*status/i.test(buttonText);
    const cmd = forwardToStatus ? "STATUS_PRODUCT" : "VIEW_PRODUCT";

    const list = (Array.isArray(cards) ? cards : [])
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        product_id: typeof (c as any).product_id === "number" ? (c as any).product_id : undefined,
        image_url: typeof (c as any).image_url === "string" ? String((c as any).image_url).trim() : "",
        body: typeof (c as any).body === "string" ? String((c as any).body).trim() : "",
        footer: typeof (c as any).footer === "string" ? String((c as any).footer).trim() : "",
        url: typeof (c as any).url === "string" ? String((c as any).url).trim() : "",
      }))
      .filter((c) => c.image_url && c.body)
      .slice(0, 10);
    if (!list.length) throw new Error("No valid product cards.");

    const intro = (bodyText ?? "").trim();
    const footer = (footerText ?? "").trim();
    const introParts = [intro, footer].filter((x) => x);
    let firstId: string | null = null;
    if (introParts.length) {
      firstId = (await sendGroupText(groupId, introParts.join("\n\n"))) ?? null;
    }

    for (const c of list) {
      const dmUrl =
        typeof c.product_id === "number" && Number.isFinite(c.product_id) ? `${waBase}?text=${encodeURIComponent(`${cmd} ${c.product_id}`)}` : waBase;

      try {
        const buf = await withTimeout(downloadBuffer(c.image_url), 60_000, "Media download timed out.");
        const media = await withTimeout(Promise.resolve(prepareWAMessageMedia({ image: buf }, { upload })), 25_000, "Media prepare timed out.");

        const bodySafe = (c.body ?? "").trim().slice(0, 900);
        const footerSafe = ((c.footer ?? "").trim() || "Tap below to chat with us").slice(0, 60);

        const msg = generateWAMessageFromContent(
          groupId,
          {
            viewOnceMessage: {
              message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: {
                  header: { title: "", hasMediaAttachment: true, ...media },
                  body: { text: bodySafe },
                  footer: { text: footerSafe },
                  nativeFlowMessage: {
                    buttons: [
                      {
                        name: "cta_url",
                        buttonParamsJson: JSON.stringify({
                          display_text: `💬 ${displayText}`,
                          url: dmUrl,
                          merchant_url: dmUrl,
                        }),
                      },
                    ],
                  },
                },
              },
            },
          } as any,
          { userJid: (sock as any).user?.id }
        );

        await withTimeout((sock as any).relayMessage(groupId, msg.message, { messageId: msg.key.id }), 15_000, "Interactive relay timed out.");
        if (!firstId) firstId = msg.key.id;
      } catch (e: unknown) {
        const fallbackParts: string[] = [];
        const bodySafe = (c.body ?? "").trim().slice(0, 900);
        const footerSafe = (c.footer ?? "").trim().slice(0, 120);
        if (bodySafe) fallbackParts.push(bodySafe);
        if (footerSafe) fallbackParts.push(footerSafe);
        if (c.url) fallbackParts.push(c.url);
        fallbackParts.push(`${displayText}: ${dmUrl}`);
        try {
          const id = await sendGroupImage(groupId, c.image_url, fallbackParts.join("\n\n").trim());
          if (!firstId && id) firstId = id;
        } catch (e2: unknown) {
          handlers.onError(e2 instanceof Error ? e2.message : "Group drop failed.");
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return firstId;
  }

  async function sendGroupCtaCard(
    groupId: string,
    bodyText: string,
    footerText: string,
    prefillText: string,
    buttonText: string
  ): Promise<string | null> {
    if (!groupId.endsWith("@g.us")) throw new Error("Invalid group id.");
    const waBase = getWaMeBase();
    if (!waBase) throw new Error("Cannot build DM link (missing device phone).");
    const bodySafe = (bodyText ?? "").trim().slice(0, 900);
    const footerSafe = (footerText ?? "").trim().slice(0, 60) || "Tap below to chat with us";
    const displayText = (buttonText ?? "").trim().slice(0, 18) || "Continue in DM";
    const prefill = (prefillText ?? "").trim();
    const url = prefill ? `${waBase}?text=${encodeURIComponent(prefill)}` : waBase;

    const msg = generateWAMessageFromContent(
      groupId,
      {
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
      } as any,
      { userJid: (sock as any).user?.id }
    );

    await withTimeout((sock as any).relayMessage(groupId, msg.message, { messageId: msg.key.id }), 15_000, "Interactive relay timed out.");
    return typeof msg.key?.id === "string" && msg.key.id.trim() ? msg.key.id : null;
  }

  async function sendStatusImage(imageUrl: string, caption?: string, targets?: string[]): Promise<string | null> {
    const statusJidList = normalizeStatusJidList(targets);
    if (!statusJidList.length) throw new Error("Status post unavailable: no audience yet. Chat with at least one customer first.");
    try {
      const url = (imageUrl ?? "").trim();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const r = (await withTimeout(
          sock.sendMessage(
            "status@broadcast",
            { image: { url }, caption: caption ?? "" },
            { statusJidList, broadcast: true }
          ),
          20_000,
          "Status image send timed out."
        )) as unknown as { key?: { id?: string } } | undefined;
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
      }
    } catch {
    }
    const buf = await downloadBuffer(imageUrl);
    const r = (await withTimeout(
      sock.sendMessage("status@broadcast", { image: buf, caption: caption ?? "" }, { statusJidList, broadcast: true }),
      20_000,
      "Status image send timed out."
    )) as unknown as
      | { key?: { id?: string } }
      | undefined;
    const id = r?.key?.id;
    return typeof id === "string" && id.trim() ? id : null;
  }

  async function sendStatusVideo(videoUrl: string, caption?: string, targets?: string[]): Promise<string | null> {
    const url = (videoUrl ?? "").trim();
    if (!url) throw new Error("Invalid video url.");
    const statusJidList = normalizeStatusJidList(targets);
    if (!statusJidList.length) throw new Error("Status post unavailable: no audience yet. Chat with at least one customer first.");
    const lower = url.toLowerCase();
    const mimetype =
      lower.includes(".webm") ? "video/webm" : lower.includes(".3gp") ? "video/3gpp" : lower.includes(".mov") ? "video/quicktime" : "video/mp4";
    try {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const r = (await withTimeout(
          sock.sendMessage(
            "status@broadcast",
            { video: { url }, mimetype, caption: caption ?? "" },
            { statusJidList, broadcast: true }
          ),
          30_000,
          "Status video send timed out."
        )) as unknown as { key?: { id?: string } } | undefined;
        const id = r?.key?.id;
        return typeof id === "string" && id.trim() ? id : null;
      }
    } catch {
    }
    const buf = await downloadBuffer(url);
    const r = (await withTimeout(
      sock.sendMessage("status@broadcast", { video: buf, mimetype, caption: caption ?? "" }, { statusJidList, broadcast: true }),
      30_000,
      "Status video send timed out."
    )) as unknown as
      | { key?: { id?: string } }
      | undefined;
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
    sendStatusText,
    sendStatusImage,
    sendStatusVideo,
  };
}

