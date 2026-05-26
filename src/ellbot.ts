import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";

type WASocket = any;

type Session = {
  state:
    | "chat"
    | "awaiting_qty"
    | "awaiting_name"
    | "awaiting_delivery_method"
    | "awaiting_delivery_address"
    | "awaiting_email"
    | "reviewing_checkout"
    | "selecting_payment_method"
    | "awaiting_momo_number";
  cart: CartItem | null;
  botPaused?: boolean;
  handoffToken?: string;
  customerName?: string;
  customerPushName?: string;
  email?: string;
  momoNumber?: string;
  lastReference?: string;
  greetedAt?: number;
  lastNudgeAt?: number;
  lastNudgeSig?: string;
  aiFallbackAt?: number;
  deliveryMethodId?: string;
  deliveryMethodName?: string;
  deliveryFeeCents?: number;
  deliveryAddress?: string;
  profileFetchedAt?: number;
  history?: { dir: "in" | "out"; text: string; at: number }[];
  lastProductTopic?: string;
  lastSearchAiAt?: number;
  lastSearchAiSig?: string;
  lastPlanAiAt?: number;
  lastPlanAiSig?: string;
  pendingShopText?: string;
  pendingDidYouMean?: { at: number; suggestion: string; planningText: string };
  lastCatalog?: { at: number; title: string; ids: number[]; per: number; page: number };
  menu?: { at: number; step: "categories" | "actions" | "brands"; categories: string[]; category: string | null; brands: string[]; brand: string | null };
  pendingConfirm?: {
    at: number;
    planningText: string;
    topic: string;
    catName: string | null;
    min: number | null;
    max: number | null;
    sort: "random" | "price_asc" | "price_desc" | "latest" | null;
    ids: number[];
  };
  lastResultsMinPrice?: number;
  lastResultsCategory?: string;
};

export type ProductVariation = {
  id: number;
  name: string;
  price: number | null;
  images: string[];
};

export type Product = {
  id: number;
  name: string;
  price: number;
  currency: string;
  description: string;
  category: string;
  brand: string;
  image_url: string;
  images: string[];
  videos: string[];
  variations: ProductVariation[];
  link: string;
  stock: number;
  track_inventory: boolean;
};

type CartItem = {
  product: Product;
  variation: ProductVariation | null;
  title: string;
  unitPrice: number;
  qty: number;
  image_url: string;
};

export type EllbotDeps = {
  vendorId: string;
  sock: WASocket;
  prepareWAMessageMedia: any;
  generateWAMessageFromContent: any;
  cleanPhone: (raw: string) => string;
  jidNormalizedUser: (jid: string) => string;
  withTimeout: <T>(p: Promise<T>, ms: number, message: string) => Promise<T>;
  onError: (message: string) => void;
};

type StoreSlug = { id: number | null; slug: string } | null;

const storeSlugCache = new Map<string, { slug: string; at: number }>();
const vendorBotConfigCache = new Map<
  string,
  {
    at: number;
    cfg: {
      vendor: { id: number; slug: string; name: string };
      openrouter: { keys: string[]; model: string | null };
      manualPayment: { enabled: boolean; title: string; instructions: string };
      payments?: { paystack?: { enabled?: boolean; configured?: boolean } };
      whatsappBotBrain: {
        storeName: string;
        shopPhone: string;
        greeting: string;
        fallback: string;
        serviceInquiryReply: string;
        assistantStyle: "straightforward" | "balanced" | "interactive";
        memoryTurns: number;
        extraNotes: string;
      };
      whatsappCatalogSettings: {
        catalogCount: number;
        itemsPerPage: number;
        allowRandom: boolean;
        allowPriceSort: boolean;
        allowPriceRange: boolean;
        allowCategories: boolean;
        allowLatest: boolean;
      };
      deliveryOptions?: {
        currency: string;
        notes: string;
        methods: Array<{
          id: string;
          name: string;
          feeCents: number;
          eta: string;
          areas: string[];
          instructions: string;
        }>;
      };
      whatsappGroupSettings?: {
        enabled: boolean;
        tagOnly: boolean;
        tagBack: boolean;
        searchMode: "dm_cta" | "ask_dm" | "in_group";
      };
      whatsappHandoffSettings?: {
        enabled: boolean;
        pauseBot: boolean;
        notifyPortal: boolean;
        notifyPeers: string[];
        stages: {
          view_product: boolean;
          select_product: boolean;
          select_variation: boolean;
          before_payment: boolean;
        };
      };
      whatsappExcludedPeers?: string[];
    };
  }
>();

const productsSource = (process.env.BOT_PRODUCTS_SOURCE ?? "supabase").trim().toLowerCase();

const supabaseUrl = (process.env.SUPABASE_URL ?? "").trim();
const supabaseKey = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY ?? "").trim();
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } }) : null;

function apiBase() {
  const raw = (process.env.API_SERVER_BASE_URL ?? "http://127.0.0.1:8000/api").trim().replace(/\/$/, "");
  if (!raw) return raw;
  if (/\/api(\/|$)/.test(raw)) return raw;
  return `${raw}/api`;
}

function apiOrigin() {
  const b = apiBase();
  if (b.endsWith("/api")) return b.slice(0, -4);
  if (b.endsWith("/api/")) return b.slice(0, -5);
  return b;
}

function storeWebBase() {
  return (process.env.STORE_WEB_BASE_URL ?? "http://localhost:5173").trim().replace(/\/$/, "");
}

function absolutizeMediaUrl(url: string) {
  const u = (url ?? "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  const origin = apiOrigin();
  if (!origin) return u;
  if (u.startsWith("/")) return `${origin}${u}`;
  return `${origin}/${u}`;
}

export async function fetchVendorBotConfig(vendorId: string) {
  const cached = vendorBotConfigCache.get(vendorId);
  if (cached && Date.now() - cached.at < 5_000) return cached.cfg;
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  const url = `${base}/internal/bot/vendor-config/${encodeURIComponent(vendorId)}`;
  const { ok, json } = await requestJson(url, "GET", null, secret ? { "x-bot-secret": secret } : {}, 4_000).catch(() => ({
    ok: false,
    status: 0,
    json: null as any,
  }));
  if (!ok || !json || typeof json !== "object") return null;
  const vendor = (json as any)?.vendor;
  const vendorName = typeof vendor?.name === "string" ? vendor.name.trim() : "";
  const vendorSlug = typeof vendor?.slug === "string" ? vendor.slug.trim() : "";
  const vendorIdNum = typeof vendor?.id === "number" ? vendor.id : Number(vendor?.id);

  const openrouter = (json as any)?.openrouter;
  const keysRaw: unknown[] = Array.isArray(openrouter?.keys) ? (openrouter.keys as unknown[]) : [];
  const keys: string[] = keysRaw
    .filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "")
    .map((k: string) => k.trim());
  const model = typeof openrouter?.model === "string" && openrouter.model.trim() ? openrouter.model.trim() : null;
  const manual = (json as any)?.manualPayment;
  const enabled = Boolean(manual?.enabled);
  const title = typeof manual?.title === "string" && manual.title.trim() ? manual.title.trim() : "Manual payment";
  const instructions = typeof manual?.instructions === "string" ? manual.instructions.trim() : "";
  const payments = (json as any)?.payments;
  const paystack = payments?.paystack;
  const paystackEnabled = Boolean(paystack?.enabled);
  const paystackConfigured = Boolean(paystack?.configured);

  const brain = (json as any)?.whatsappBotBrain;
  const brainStoreName = typeof brain?.storeName === "string" ? brain.storeName.trim() : "";
  const brainPhone = typeof brain?.shopPhone === "string" ? brain.shopPhone.trim() : "";
  const brainGreeting = typeof brain?.greeting === "string" ? brain.greeting.trim() : "";
  const brainFallback = typeof brain?.fallback === "string" ? brain.fallback.trim() : "";
  const brainServiceInquiryReply = typeof brain?.serviceInquiryReply === "string" ? brain.serviceInquiryReply.trim() : "";
  const brainStyleRaw = typeof brain?.assistantStyle === "string" ? brain.assistantStyle.trim() : "balanced";
  const brainStyle =
    brainStyleRaw === "straightforward" || brainStyleRaw === "interactive" || brainStyleRaw === "balanced" ? brainStyleRaw : "balanced";
  const memoryTurnsRaw = typeof brain?.memoryTurns === "number" ? brain.memoryTurns : Number(brain?.memoryTurns);
  const memoryTurns = Number.isFinite(memoryTurnsRaw) ? Math.max(0, Math.min(12, Math.floor(memoryTurnsRaw))) : 6;
  const brainExtraNotes = typeof brain?.extraNotes === "string" ? brain.extraNotes.trim() : "";

  const cat = (json as any)?.whatsappCatalogSettings;
  const catalogCountRaw = typeof cat?.catalogCount === "number" ? cat.catalogCount : Number(cat?.catalogCount);
  const itemsPerPageRaw =
    typeof cat?.itemsPerPage === "number"
      ? cat.itemsPerPage
      : typeof cat?.carouselSlideCount === "number"
        ? cat.carouselSlideCount
        : Number(cat?.itemsPerPage ?? cat?.carouselSlideCount);
  const catalogCount = Number.isFinite(catalogCountRaw) ? Math.max(1, Math.min(50, Math.floor(catalogCountRaw))) : 20;
  const itemsPerPage = Number.isFinite(itemsPerPageRaw) ? Math.max(1, Math.min(10, Math.floor(itemsPerPageRaw))) : 10;
  const allowRandom = typeof cat?.allowRandom === "boolean" ? cat.allowRandom : true;
  const allowPriceSort = typeof cat?.allowPriceSort === "boolean" ? cat.allowPriceSort : true;
  const allowPriceRange = typeof cat?.allowPriceRange === "boolean" ? cat.allowPriceRange : true;
  const allowCategories = typeof cat?.allowCategories === "boolean" ? cat.allowCategories : true;
  const allowLatest = typeof cat?.allowLatest === "boolean" ? cat.allowLatest : true;

  const delivery = (json as any)?.deliveryOptions ?? null;
  const deliveryCurrency = typeof delivery?.currency === "string" && delivery.currency.trim() ? String(delivery.currency).trim() : "GHS";
  const deliveryNotes = typeof delivery?.notes === "string" ? String(delivery.notes) : "";
  type DeliveryMethod = {
    id: string;
    name: string;
    feeCents: number;
    eta: string;
    areas: string[];
    instructions: string;
  };
  type DeliveryOptions = { currency: string; notes: string; methods: DeliveryMethod[] };

  const methodsRaw: unknown[] = Array.isArray(delivery?.methods) ? (delivery.methods as unknown[]) : [];
  const deliveryMethods: DeliveryMethod[] = methodsRaw
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const o = m as any;
      return {
        id: typeof o.id === "string" ? o.id.trim() : "",
        name: typeof o.name === "string" ? o.name.trim() : "",
        feeCents: typeof o.feeCents === "number" && Number.isFinite(o.feeCents) ? Math.max(0, Math.round(o.feeCents)) : 0,
        eta: typeof o.eta === "string" ? o.eta : "",
        areas: Array.isArray(o.areas) ? o.areas.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "") : [],
        instructions: typeof o.instructions === "string" ? o.instructions : "",
      };
    })
    .filter((m) => m.id && m.name)
    .slice(0, 20);

  const cfg: {
    vendor: { id: number; slug: string; name: string };
    openrouter: { keys: string[]; model: string | null };
    manualPayment: { enabled: boolean; title: string; instructions: string };
    payments: { paystack: { enabled: boolean; configured: boolean } };
    whatsappBotBrain: {
      storeName: string;
      shopPhone: string;
      greeting: string;
      fallback: string;
      serviceInquiryReply: string;
      assistantStyle: "straightforward" | "balanced" | "interactive";
      memoryTurns: number;
      extraNotes: string;
    };
    whatsappCatalogSettings: {
      catalogCount: number;
      itemsPerPage: number;
      allowRandom: boolean;
      allowPriceSort: boolean;
      allowPriceRange: boolean;
      allowCategories: boolean;
      allowLatest: boolean;
    };
    deliveryOptions: DeliveryOptions;
    whatsappGroupSettings: {
      enabled: boolean;
      tagOnly: boolean;
      tagBack: boolean;
      searchMode: "dm_cta" | "ask_dm" | "in_group";
    };
    whatsappHandoffSettings: {
      enabled: boolean;
      pauseBot: boolean;
      notifyPortal: boolean;
      notifyPeers: string[];
      stages: {
        view_product: boolean;
        select_product: boolean;
        select_variation: boolean;
        before_payment: boolean;
      };
    };
  } = {
    vendor: {
      id: Number.isFinite(vendorIdNum) ? vendorIdNum : Number(vendorId),
      slug: vendorSlug,
      name: vendorName,
    },
    openrouter: { keys: Array.from(new Set(keys)).slice(0, 10), model },
    manualPayment: { enabled, title, instructions },
    payments: { paystack: { enabled: paystackEnabled, configured: paystackConfigured } },
    whatsappBotBrain: {
      storeName: brainStoreName || vendorName || "Our Store",
      shopPhone: brainPhone,
      greeting: brainGreeting,
      fallback: brainFallback,
      serviceInquiryReply: brainServiceInquiryReply,
      assistantStyle: brainStyle,
      memoryTurns,
      extraNotes: brainExtraNotes,
    },
    whatsappCatalogSettings: {
      catalogCount,
      itemsPerPage,
      allowRandom,
      allowPriceSort,
      allowPriceRange,
      allowCategories,
      allowLatest,
    },
    deliveryOptions: {
      currency: deliveryCurrency,
      notes: deliveryNotes,
      methods: deliveryMethods,
    },
    whatsappGroupSettings: {
      enabled: Boolean((json as any)?.whatsappGroupSettings?.enabled),
      tagOnly: typeof (json as any)?.whatsappGroupSettings?.tagOnly === "boolean" ? Boolean((json as any).whatsappGroupSettings.tagOnly) : true,
      tagBack: typeof (json as any)?.whatsappGroupSettings?.tagBack === "boolean" ? Boolean((json as any).whatsappGroupSettings.tagBack) : true,
      searchMode: ((): "dm_cta" | "ask_dm" | "in_group" => {
        const sm = typeof (json as any)?.whatsappGroupSettings?.searchMode === "string" ? String((json as any).whatsappGroupSettings.searchMode).trim() : "dm_cta";
        if (sm === "in_group") return "in_group";
        if (sm === "ask_dm") return "ask_dm";
        return "dm_cta";
      })(),
    },
    whatsappHandoffSettings: {
      enabled: Boolean((json as any)?.whatsappHandoffSettings?.enabled),
      pauseBot: Boolean((json as any)?.whatsappHandoffSettings?.pauseBot),
      notifyPortal: typeof (json as any)?.whatsappHandoffSettings?.notifyPortal === "boolean" ? Boolean((json as any).whatsappHandoffSettings.notifyPortal) : true,
      notifyPeers: Array.isArray((json as any)?.whatsappHandoffSettings?.notifyPeers)
        ? (json as any).whatsappHandoffSettings.notifyPeers
            .filter((x: unknown) => typeof x === "string" && String(x).trim())
            .map((x: string) => x.trim())
            .slice(0, 10)
        : [],
      stages: {
        view_product: Boolean((json as any)?.whatsappHandoffSettings?.stages?.view_product),
        select_product: Boolean((json as any)?.whatsappHandoffSettings?.stages?.select_product),
        select_variation: Boolean((json as any)?.whatsappHandoffSettings?.stages?.select_variation),
        before_payment: Boolean((json as any)?.whatsappHandoffSettings?.stages?.before_payment),
      },
    },
  };
  vendorBotConfigCache.set(vendorId, { at: Date.now(), cfg });
  return cfg;
}

type CustomerProfile = {
  phone: string;
  name: string | null;
  email: string | null;
  delivery_address: string | null;
  delivery_method_id: string | null;
  delivery_method_name: string | null;
};

async function fetchCustomerProfile(vendorId: string, peer: string): Promise<CustomerProfile | null> {
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  const url = `${base}/internal/bot/customer-profile/${encodeURIComponent(vendorId)}?peer=${encodeURIComponent(peer)}`;
  const { ok, json } = await requestJson(url, "GET", null, secret ? { "x-bot-secret": secret } : {}, 4_000).catch(() => ({
    ok: false,
    status: 0,
    json: null as any,
  }));
  if (!ok || !json || typeof json !== "object") return null;
  const cust = (json as any)?.customer ?? null;
  if (!cust || typeof cust !== "object") return null;
  const phone = typeof cust.phone === "string" ? cust.phone.trim() : "";
  if (!phone) return null;
  return {
    phone,
    name: typeof cust.name === "string" && cust.name.trim() ? cust.name.trim() : null,
    email: typeof cust.email === "string" && cust.email.trim() ? cust.email.trim() : null,
    delivery_address: typeof cust.delivery_address === "string" && cust.delivery_address.trim() ? cust.delivery_address.trim() : null,
    delivery_method_id: typeof cust.delivery_method_id === "string" && cust.delivery_method_id.trim() ? cust.delivery_method_id.trim() : null,
    delivery_method_name:
      typeof cust.delivery_method_name === "string" && cust.delivery_method_name.trim() ? cust.delivery_method_name.trim() : null,
  };
}

async function upsertCustomerProfile(
  vendorId: string,
  payload: {
    peer: string;
    push_name?: string;
    name?: string;
    email?: string;
    delivery_address?: string;
    delivery_method_id?: string;
    delivery_method_name?: string;
  }
) {
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  const url = `${base}/internal/bot/customer-profile/${encodeURIComponent(vendorId)}`;
  await requestJson(url, "POST", payload, secret ? { "x-bot-secret": secret } : {}, 4_000).catch(() => void 0);
}

async function createHandoff(
  vendorId: string,
  payload: { customer_peer: string; customer_name?: string | null; stage: string; context?: Record<string, unknown> | null }
) {
  const base = apiBase();
  const secret = (process.env.BOT_SERVER_SECRET ?? "").trim();
  const url = `${base}/internal/bot/handoffs/${encodeURIComponent(vendorId)}`;
  const { ok, json } = await requestJson(url, "POST", payload, secret ? { "x-bot-secret": secret } : {}, 4_000).catch(() => ({
    ok: false,
    status: 0,
    json: null as any,
  }));
  if (!ok || !json || typeof json !== "object") return null;
  const idRaw = (json as any)?.handoff_id;
  const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
  return Number.isFinite(id) ? Math.floor(id) : null;
}

async function requestJson(url: string, method: "GET" | "POST", body: unknown, headers: Record<string, string>, timeoutMs: number) {
  const u = new URL(url);
  const rawBody = body === undefined || body === null ? "" : JSON.stringify(body);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  const opts: http.RequestOptions = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: `${u.pathname}${u.search}`,
    method,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "EllTekBotServer/1.0",
      ...(method === "POST"
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(rawBody),
          }
        : {}),
      ...headers,
    },
  };
  return await new Promise<{ ok: boolean; status: number; json: any }>((resolve) => {
    const req = mod.request(opts, (res) => {
      const status = typeof res.statusCode === "number" ? res.statusCode : 0;
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json: any = null;
        if (text && text.trim()) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        resolve({ ok: status >= 200 && status < 300, status, json });
      });
    });
    req.on("error", () => resolve({ ok: false, status: 0, json: null }));
    req.setTimeout(Math.max(0, timeoutMs), () => {
      try {
        req.destroy(new Error("Request timed out."));
      } catch {
        void 0;
      }
    });
    if (method === "POST" && rawBody) req.write(rawBody);
    req.end();
  });
}

async function fetchJson(url: string, timeoutMs: number) {
  return await requestJson(url, "GET", null, {}, timeoutMs);
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) {
  return await requestJson(url, "POST", body, headers, timeoutMs);
}

async function fetchStoreSlug(vendorId: string): Promise<StoreSlug> {
  const cached = storeSlugCache.get(vendorId);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    const idNum = Number(vendorId);
    return { id: Number.isFinite(idNum) ? idNum : null, slug: cached.slug };
  }
  const url = `${apiBase()}/marketplace/stores`;
  const { ok, json } = await fetchJson(url, 4_000).catch(() => ({ ok: false, status: 0, json: null as any }));
  if (!ok || !json || typeof json !== "object") return null;
  const stores = (json as any)?.stores;
  if (!Array.isArray(stores)) return null;
  const idNum = Number(vendorId);
  for (const s of stores) {
    const id = typeof s?.id === "number" ? s.id : Number(s?.id);
    const slug = typeof s?.slug === "string" ? s.slug : "";
    if (slug && (slug === vendorId || (Number.isFinite(idNum) && Number.isFinite(id) && id === idNum))) {
      storeSlugCache.set(vendorId, { slug, at: Date.now() });
      return { id: Number.isFinite(id) ? id : null, slug };
    }
  }
  return null;
}

export async function fetchProductsForVendor(vendorId: string): Promise<Product[]> {
  if (productsSource === "supabase" && supabase) {
    const isNum = /^\d+$/.test(String(vendorId));
    let q: any = supabase.from("products_with_variations").select("*").order("created_at", { ascending: false });
    q = isNum ? q.eq("vendor_id", Number(vendorId)) : q.eq("vendor_id", String(vendorId));
    const { data, error } = await q;
    if (error) return [];
    const rows: any[] = Array.isArray(data) ? data : [];
    const base = storeWebBase();
    const mapped: Product[] = [];
    for (const row of rows) {
      const id = typeof row?.id === "number" ? row.id : Number(row?.id);
      const name = typeof row?.title === "string" ? row.title : typeof row?.name === "string" ? row.name : "";
      if (!Number.isFinite(id) || id <= 0 || !name.trim()) continue;
      const desc = typeof row?.description === "string" ? row.description : "";
      const category = typeof row?.category === "string" ? row.category : "";
      const brand = typeof row?.brand === "string" ? row.brand : "";
      const currency = typeof row?.currency === "string" && row.currency.trim() ? row.currency.trim() : "GHS";
      const priceCents = typeof row?.price_cents === "number" ? row.price_cents : Number(row?.price_cents);
      const priceRaw = typeof row?.price === "number" ? row.price : Number(row?.price);
      const price = Number.isFinite(priceRaw) ? Math.round(priceRaw * 100) / 100 : Number.isFinite(priceCents) ? Math.round(priceCents) / 100 : 0;
      const stockRaw = typeof row?.stock === "number" ? row.stock : Number(row?.stock);
      const stock = Number.isFinite(stockRaw) ? Math.max(0, Math.floor(stockRaw)) : 0;
      const track_inventory = Boolean(row?.track_inventory);
      const imgsRaw = Array.isArray(row?.images) ? (row.images as unknown[]) : [];
      const imgs = imgsRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
        .map((x: string) => absolutizeMediaUrl(x));
      const vidsRaw = Array.isArray(row?.videos) ? (row.videos as unknown[]) : [];
      const vids = vidsRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
        .map((x: string) => absolutizeMediaUrl(x));
      const image0 = typeof imgs?.[0] === "string" ? String(imgs[0]).trim() : "";
      const imageUrlRaw = typeof row?.image_url === "string" ? row.image_url.trim() : "";
      const image_url = absolutizeMediaUrl(imageUrlRaw) || image0 || `https://placehold.co/600x400/103629/ffffff/png?text=${encodeURIComponent(name.trim() || `Item ${id}`)}`;
      const link = typeof row?.link === "string" && row.link.trim() ? row.link.trim() : `${base}/shop/product/${id}`;

      const varsRaw = Array.isArray(row?.variations) ? (row.variations as unknown[]) : Array.isArray(row?.product_variations) ? (row.product_variations as unknown[]) : [];
      const variations: ProductVariation[] = [];
      for (const v of varsRaw) {
        const vid = typeof (v as any)?.id === "number" ? (v as any).id : Number((v as any)?.id);
        const vname = typeof (v as any)?.name === "string" ? String((v as any).name).trim() : "";
        const vPriceCents = typeof (v as any)?.price_cents === "number" ? (v as any).price_cents : Number((v as any)?.price_cents);
        const vPriceRaw = typeof (v as any)?.price === "number" ? (v as any).price : Number((v as any)?.price);
        const vPrice = Number.isFinite(vPriceRaw) ? Math.round(vPriceRaw * 100) / 100 : Number.isFinite(vPriceCents) ? Math.round(vPriceCents) / 100 : null;
        const vImgsRaw = Array.isArray((v as any)?.images) ? ((v as any).images as unknown[]) : [];
        const vImgs = vImgsRaw
          .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
          .map((x: string) => absolutizeMediaUrl(x));
        if (!Number.isFinite(vid) || vid <= 0 || !vname) continue;
        if (typeof vPrice !== "number" || !Number.isFinite(vPrice) || vPrice <= 0) continue;
        variations.push({ id: vid, name: vname, price: vPrice, images: vImgs });
      }

      const varPrices = variations
        .map((v) => (typeof v.price === "number" && Number.isFinite(v.price) ? v.price : null))
        .filter((x): x is number => typeof x === "number");
      const listPrice = varPrices.length ? Math.min(...varPrices) : Number.isFinite(price) ? price : 0;

      mapped.push({
        id,
        name: name.trim(),
        price: listPrice,
        currency,
        description: desc.trim(),
        category: category.trim(),
        brand: brand.trim(),
        image_url: image_url.trim(),
        images: imgs,
        videos: vids,
        variations,
        link,
        stock,
        track_inventory,
      });
    }
    const byId = new Map<number, Product>();
    for (const p of mapped) if (!byId.has(p.id)) byId.set(p.id, p);
    const list = Array.from(byId.values());
    try {
      const store = await fetchStoreSlug(vendorId);
      if (store && store.slug) {
        const url = `${apiBase()}/marketplace/stores/${encodeURIComponent(store.slug)}/products`;
        const { ok, json } = await fetchJson(url, 6_000).catch(() => ({ ok: false, status: 0, json: null as any }));
        const apiProducts = ok && json && typeof json === "object" ? (json as any)?.products : null;
        if (Array.isArray(apiProducts) && apiProducts.length) {
          const byApiId = new Map<number, { stock: number; track_inventory: boolean; brand: string }>();
          for (const p of apiProducts) {
            const id = typeof p?.id === "number" ? p.id : Number(p?.id);
            if (!Number.isFinite(id) || id <= 0) continue;
            const stockRaw = typeof p?.stock === "number" ? p.stock : Number(p?.stock);
            const stock = Number.isFinite(stockRaw) ? Math.max(0, Math.floor(stockRaw)) : 0;
            const track_inventory = Boolean(p?.track_inventory);
            const brand = typeof p?.brand === "string" ? String(p.brand).trim() : "";
            byApiId.set(id, { stock, track_inventory, brand });
          }
          for (const p of list) {
            const api = byApiId.get(p.id);
            if (!api) continue;
            if (api.track_inventory || api.stock > 0) {
              p.stock = api.stock;
              p.track_inventory = api.track_inventory;
            }
            if (api.brand) p.brand = api.brand;
          }
        }
      }
    } catch {
      void 0;
    }
    return list;
  }

  const store = await fetchStoreSlug(vendorId);
  if (!store) return [];
  const url = `${apiBase()}/marketplace/stores/${encodeURIComponent(store.slug)}/products`;
  const { ok, json } = await fetchJson(url, 6_000).catch(() => ({ ok: false, status: 0, json: null as any }));
  if (!ok || !json || typeof json !== "object") return [];
  const products = (json as any)?.products;
  if (!Array.isArray(products)) return [];
  const base = storeWebBase();
  const mapped: Product[] = [];
  for (const p of products) {
    const id = typeof p?.id === "number" ? p.id : Number(p?.id);
    const name = typeof p?.title === "string" ? p.title : typeof p?.name === "string" ? p.name : "";
    const desc = typeof p?.description === "string" ? p.description : "";
    const category = typeof p?.category === "string" ? p.category : "";
    const brand = typeof p?.brand === "string" ? p.brand : "";
    const currency = typeof p?.currency === "string" && p.currency.trim() ? p.currency.trim() : "GHS";
    const priceCents = typeof p?.price_cents === "number" ? p.price_cents : Number(p?.price_cents);
    const price = Number.isFinite(priceCents) ? Math.round(priceCents) / 100 : 0;
    const stockRaw = typeof p?.stock === "number" ? p.stock : Number(p?.stock);
    const stock = Number.isFinite(stockRaw) ? Math.max(0, Math.floor(stockRaw)) : 0;
    const track_inventory = Boolean(p?.track_inventory);
    const imgsRaw = Array.isArray(p?.images) ? (p.images as unknown[]) : [];
    const imgs = imgsRaw
      .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
      .map((x: string) => absolutizeMediaUrl(x));
    const vidsRaw = Array.isArray(p?.videos) ? (p.videos as unknown[]) : [];
    const vids = vidsRaw
      .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
      .map((x: string) => absolutizeMediaUrl(x));
    const image0 = typeof imgs?.[0] === "string" ? String(imgs[0]).trim() : "";
    const image_url = image0 || `https://placehold.co/600x400/103629/ffffff/png?text=${encodeURIComponent(name.trim() || `Item ${id}`)}`;
    if (!Number.isFinite(id) || id <= 0 || !name.trim()) continue;
    const link = `${base}/shop/product/${id}`;

    const varsRaw = Array.isArray(p?.variations) ? (p.variations as unknown[]) : [];
    const variations: ProductVariation[] = [];
    for (const v of varsRaw) {
      const vid = typeof (v as any)?.id === "number" ? (v as any).id : Number((v as any)?.id);
      const vname = typeof (v as any)?.name === "string" ? String((v as any).name).trim() : "";
      const vPriceCents = typeof (v as any)?.price_cents === "number" ? (v as any).price_cents : Number((v as any)?.price_cents);
      const vPrice = Number.isFinite(vPriceCents) ? Math.round(vPriceCents) / 100 : null;
      const vImgsRaw = Array.isArray((v as any)?.images) ? ((v as any).images as unknown[]) : [];
      const vImgs = vImgsRaw
        .filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
        .map((x: string) => absolutizeMediaUrl(x));
      if (!Number.isFinite(vid) || vid <= 0 || !vname) continue;
      if (typeof vPrice !== "number" || !Number.isFinite(vPrice) || vPrice <= 0) continue;
      variations.push({ id: vid, name: vname, price: vPrice, images: vImgs });
    }
    const varPrices = variations
      .map((v) => (typeof v.price === "number" && Number.isFinite(v.price) ? v.price : null))
      .filter((x): x is number => typeof x === "number");
    const listPrice = varPrices.length ? Math.min(...varPrices) : Number.isFinite(price) ? price : 0;
    mapped.push({
      id,
      name: name.trim(),
      price: listPrice,
      currency,
      description: desc.trim(),
      category: category.trim(),
      brand: brand.trim(),
      image_url: image_url.trim(),
      images: imgs,
      videos: vids,
      variations,
      link,
      stock,
      track_inventory,
    });
  }
  if (!mapped.length) return [];
  const byId = new Map<number, Product>();
  for (const p of mapped) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  return Array.from(byId.values());
}

type OpenRouterResult =
  | { ok: true; content: string; tool_calls?: any[] }
  | { ok: false; status: number; message: string; retryAfterSeconds?: number };

type CircuitState = {
  openUntil: number;
  fails: number;
  windowStart: number;
};

function parseRetryAfterSeconds(v: string | null) {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return undefined;
}

function extractOpenRouterContent(json: any) {
  const choice = json?.choices?.[0] ?? null;
  const msg = choice?.message ?? choice?.delta ?? null;
  const content = msg?.content;
  const tool_calls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null;
  if (typeof content === "string" && content.trim()) return { content: content.trim(), tool_calls, debug: null as string | null };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string" && item.trim()) parts.push(item.trim());
      else if (item && typeof item === "object") {
        const t = typeof (item as any).text === "string" ? (item as any).text : null;
        if (t && t.trim()) parts.push(t.trim());
      }
    }
    const joined = parts.join("\n").trim();
    if (joined) return { content: joined, tool_calls, debug: null as string | null };
  }
  if (tool_calls) return { content: "", tool_calls, debug: null as string | null };
  const refusal = typeof msg?.refusal === "string" ? msg.refusal.trim() : "";
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
  const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  const topKeys = json && typeof json === "object" ? Object.keys(json).slice(0, 30) : [];
  const choiceKeys = choice && typeof choice === "object" ? Object.keys(choice).slice(0, 30) : [];
  const msgKeys = msg && typeof msg === "object" ? Object.keys(msg).slice(0, 30) : [];
  let choiceExcerpt: string | null = null;
  try {
    choiceExcerpt = choice ? JSON.stringify(choice).slice(0, 600) : null;
  } catch {
    choiceExcerpt = null;
  }
  const hint = JSON.stringify({
    top_keys: topKeys,
    choice_keys: choiceKeys,
    message_keys: msgKeys,
    finish_reason: finish || null,
    refusal: refusal ? refusal.slice(0, 120) : null,
    content_type: Array.isArray(content) ? "array" : typeof content,
    has_tool_calls: hasToolCalls,
    choice_excerpt: choiceExcerpt,
  });
  return { content: null as string | null, debug: hint };
}

function normalizeOpenRouterMessages(messages: readonly any[], cacheControl: any, isAnthropic: boolean) {
  const list = Array.isArray(messages) ? messages : [];
  if (!cacheControl || !isAnthropic) return list;
  return list.map((m) => {
    const role = typeof m?.role === "string" ? m.role : "";
    const c = (m as any)?.content;
    if (typeof c !== "string") return m;
    if (role === "system") return { ...m, content: [{ type: "text", text: c, cache_control: cacheControl }] };
    if (role === "user" || role === "assistant") return { ...m, content: [{ type: "text", text: c }] };
    return m;
  });
}

function openRouterTimeoutMsForModel(model: string) {
  const rawBase = Number((process.env.OPENROUTER_TIMEOUT_MS ?? "").trim());
  const base = Number.isFinite(rawBase) && rawBase > 0 ? Math.floor(rawBase) : 20_000;
  const m = (model ?? "").toLowerCase();
  const isFree = m.includes(":free");
  const isLarge = /\b(70b|72b|120b|405b)\b/.test(m);
  const bumped = isFree || isLarge ? Math.max(base, 35_000) : base;
  return Math.max(5_000, Math.min(120_000, bumped));
}

async function openRouterChatOneAdvanced(
  key: string,
  model: string,
  payload: { messages: readonly any[]; tools?: any[]; temperature?: number; max_tokens?: number }
): Promise<OpenRouterResult> {
  const k = (key ?? "").trim();
  if (!k) return { ok: false, status: 0, message: "OpenRouter API key is missing." };
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const cacheEnabled = /^(1|true|yes)$/i.test(String(process.env.OPENROUTER_PROMPT_CACHE ?? "1").trim());
  const modelLc = (model ?? "").toLowerCase();
  const isAnthropic = modelLc.startsWith("anthropic/") || modelLc.includes("claude");
  const cacheControl = cacheEnabled ? ({ type: "ephemeral", ttl: "1h" } as const) : null;
  const messages = normalizeOpenRouterMessages(payload.messages, cacheControl, isAnthropic);

  const body: any = {
    model,
    ...(cacheControl && isAnthropic ? { cache_control: cacheControl } : {}),
    messages,
    temperature: typeof payload.temperature === "number" && Number.isFinite(payload.temperature) ? payload.temperature : 0.1,
    max_tokens: typeof payload.max_tokens === "number" && Number.isFinite(payload.max_tokens) ? payload.max_tokens : 500,
    ...(Array.isArray(payload.tools) && payload.tools.length ? { tools: payload.tools } : {}),
  };
  const hdrs = {
    Authorization: `Bearer ${k}`,
    "HTTP-Referer": (process.env.OPENROUTER_HTTP_REFERER ?? "http://localhost").trim() || "http://localhost",
    "X-Title": (process.env.OPENROUTER_APP_TITLE ?? "EllTek Bot Server").trim() || "EllTek Bot Server",
  };
  const state = (openRouterChatOneAdvanced as any)._circuit as CircuitState | undefined;
  const now = Date.now();
  if (state && now < state.openUntil) {
    return { ok: false, status: 0, message: "OpenRouter temporarily disabled due to recent network failures." };
  }
  const circuit: CircuitState =
    state ??
    ({
      openUntil: 0,
      fails: 0,
      windowStart: now,
    } satisfies CircuitState);
  (openRouterChatOneAdvanced as any)._circuit = circuit;

  const timeoutMs = openRouterTimeoutMsForModel(model);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await httpsPostJson(url, body, hdrs, timeoutMs);
      const retryAfterSeconds = parseRetryAfterSeconds(resp.headers["retry-after"] ?? null);
      const rawText = resp.body ?? "";
      const contentType = String(resp.headers["content-type"] ?? "");
      let json: any = null;
      if (rawText && rawText.trim()) {
        try {
          json = JSON.parse(rawText);
        } catch {
          json = null;
        }
      }
      if (resp.status < 200 || resp.status >= 300) {
        const msgFromJson =
          typeof json?.error?.message === "string"
            ? String(json.error.message)
            : typeof json?.message === "string"
              ? String(json.message)
              : null;
        const msgFromText = rawText && rawText.trim() ? rawText.trim().slice(0, 400) : null;
        const msg = msgFromJson ?? msgFromText ?? `OpenRouter request failed (HTTP ${resp.status}).`;
        return { ok: false, status: resp.status, message: msg, retryAfterSeconds };
      }
      if (!json || typeof json !== "object") {
        const snippet = rawText && rawText.trim() ? rawText.trim().slice(0, 400) : "";
        if (!snippet && attempt < 2) {
          await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
          continue;
        }
        if (shouldCircuitOpen(circuit, Date.now())) {
          circuit.openUntil = Date.now() + 5 * 60_000;
        }
        return {
          ok: false,
          status: resp.status,
          message: snippet
            ? `OpenRouter returned non-JSON response (content-type=${contentType || "unknown"}): ${snippet}`
            : `OpenRouter returned empty/non-JSON response (content-type=${contentType || "unknown"}).`,
        };
      }
      const extracted = extractOpenRouterContent(json) as any;
      const tool_calls = Array.isArray(extracted?.tool_calls) ? extracted.tool_calls : undefined;
      if (typeof extracted.content === "string") return { ok: true, content: extracted.content.trim(), tool_calls };
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        continue;
      }
      if (shouldCircuitOpen(circuit, Date.now())) {
        circuit.openUntil = Date.now() + 5 * 60_000;
      }
      return {
        ok: false,
        status: resp.status,
        message: extracted.debug ? `OpenRouter response missing content. ${extracted.debug}` : "OpenRouter response missing content.",
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "OpenRouter request failed.";
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
        continue;
      }
      if (shouldCircuitOpen(circuit, Date.now())) {
        circuit.openUntil = Date.now() + 5 * 60_000;
      }
      return { ok: false, status: 0, message: msg };
    }
  }
  return { ok: false, status: 0, message: "OpenRouter request failed." };
}

function shouldCircuitOpen(state: CircuitState, now: number) {
  const windowMs = 2 * 60_000;
  const failLimit = 3;
  if (now - state.windowStart > windowMs) {
    state.windowStart = now;
    state.fails = 0;
  }
  state.fails += 1;
  return state.fails >= failLimit;
}

async function httpsPostJson(url: string, payload: unknown, headers: Record<string, string>, timeoutMs: number) {
  const u = new URL(url);
  const body = JSON.stringify(payload ?? {});
  const opts: https.RequestOptions = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: `${u.pathname}${u.search}`,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "EllTekBotServer/1.0",
      ...headers,
    },
  };
  return await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const status = typeof res.statusCode === "number" ? res.statusCode : 0;
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") outHeaders[k.toLowerCase()] = v;
        else if (Array.isArray(v) && typeof v[0] === "string") outHeaders[k.toLowerCase()] = v[0];
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status, headers: outHeaders, body: buf.toString("utf8") });
      });
    });
    const timer = setTimeout(() => {
      try {
        req.destroy(new Error("Request timed out."));
      } catch {
        void 0;
      }
    }, Math.max(0, timeoutMs));
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("close", () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

async function openRouterChatOne(key: string, model: string, systemPrompt: string, userText: string): Promise<OpenRouterResult> {
  return await openRouterChatOneAdvanced(key, model, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });
}

function looksLikeKeyFailure(r: OpenRouterResult) {
  if (r.ok) return false;
  const msg = (r.message ?? "").toLowerCase();
  if (r.status === 401 || r.status === 403) return true;
  if (r.status === 402) return true;
  if (r.status === 429) return true;
  if (r.status >= 500) return true;
  if (r.status === 0 && (msg.includes("fetch failed") || msg.includes("timed out") || msg.includes("timeout") || msg.includes("econn") || msg.includes("socket"))) {
    return true;
  }
  if (msg.includes("temporarily disabled")) return true;
  return false;
}

async function openRouterChatWithKeys(keys: string[], model: string, systemPrompt: string, userText: string): Promise<OpenRouterResult> {
  const list = (Array.isArray(keys) ? keys : []).map((k) => (k ?? "").trim()).filter(Boolean);
  if (!list.length) return { ok: false, status: 0, message: "No OpenRouter API keys configured." };
  let last: OpenRouterResult | null = null;
  for (let i = 0; i < list.length; i++) {
    const r = await openRouterChatOne(list[i] as string, model, systemPrompt, userText);
    if (r.ok) return r;
    last = r;
    if (!looksLikeKeyFailure(r)) return r;
  }
  return last ?? { ok: false, status: 0, message: "OpenRouter request failed." };
}

function buildCatalogData(products: Product[]) {
  return products
    .map((p) => `[ID: ${p.id}] ${p.name} - ${formatMoney(p.currency, p.price)}. Details: ${p.description}`)
    .join("\n");
}

function formatMoney(currency: string, amount: number) {
  const cur = (currency ?? "").trim().toUpperCase() || "GHS";
  const symbol =
    cur === "GHS"
      ? "GH₵"
      : cur === "USD"
        ? "$"
        : cur === "EUR"
          ? "€"
          : cur === "GBP"
            ? "£"
            : cur === "NGN"
              ? "₦"
              : cur === "KES"
                ? "KSh"
                : cur === "ZAR"
                  ? "R"
                  : cur;
  const n = typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
  const frac = Math.abs(n % 1) < 1e-9 ? 0 : 2;
  const s = n.toFixed(frac).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${symbol} ${s}`.trim();
}

function mostCommonCurrency(products: Product[]) {
  const counts = new Map<string, number>();
  for (const p of Array.isArray(products) ? products : []) {
    const c = (p?.currency ?? "").trim().toUpperCase();
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = "GHS";
  let bestN = 0;
  for (const [c, n] of counts.entries()) {
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

function stripTag(text: string, tag: string) {
  return text.includes(tag) ? text.replace(tag, "").trim() : text.trim();
}

function parseTriggerIds(text: string): { triggerCatalog: boolean; filterIds: string[]; viewId: string | null; buyId: string | null; clean: string } {
  let out = text ?? "";
  let triggerCatalog = false;
  let filterIds: string[] = [];
  let viewId: string | null = null;
  let buyId: string | null = null;
  if (out.includes("[TRIGGER_CATALOG]")) {
    triggerCatalog = true;
    out = stripTag(out, "[TRIGGER_CATALOG]");
  }
  const filterMatch = out.match(/\[TRIGGER_FILTER_([\d,\s]+)\]/);
  if (filterMatch) {
    filterIds = filterMatch[1].split(",").map((id) => id.trim()).filter(Boolean);
    out = out.replace(filterMatch[0], "").trim();
  }
  const viewMatch = out.match(/\[TRIGGER_VIEW_(\d+)\]/);
  if (viewMatch) {
    viewId = viewMatch[1];
    out = out.replace(viewMatch[0], "").trim();
  }
  const buyMatch = out.match(/\[TRIGGER_BUY_(\d+)\]/);
  if (buyMatch) {
    buyId = buyMatch[1];
    out = out.replace(buyMatch[0], "").trim();
  }
  return { triggerCatalog, filterIds, viewId, buyId, clean: out.trim() };
}

function normText(text: string) {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function parseConfirmDecision(text: string) {
  const t = normText(text);
  if (!t) return null as "yes" | "no" | null;
  if (t === "1" || t === "yes" || t === "y" || t === "ok" || t === "okay" || t === "sure" || t === "go ahead") return "yes";
  if (t.includes("yes") || t.includes("show") || t.includes("send") || t.includes("that is it") || t.includes("thats it")) return "yes";
  if (t === "2" || t === "no" || t === "n") return "no";
  if (t.includes("no") || t.includes("change") || t.includes("edit") || t.includes("not that") || t.includes("wrong")) return "no";
  return null;
}

function looksLikeCheckPermissionPrompt(text: string) {
  const t = normText(text);
  if (!t) return false;
  if (!t.includes("check my system")) return false;
  if (!t.includes("would you like")) return false;
  if (t.includes("pull up") || t.includes("show") || t.includes("options")) return true;
  return false;
}

function simpleLocalSearch(products: Product[], query: string) {
  const raw = normText(query);
  if (!raw) return [];
  const stop = new Set([
    "i",
    "me",
    "my",
    "we",
    "us",
    "you",
    "your",
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "for",
    "of",
    "in",
    "on",
    "at",
    "want",
    "need",
    "looking",
    "show",
    "see",
    "give",
    "get",
    "have",
    "with",
    "please",
    "some",
    "any",
    "something",
    "one",
    "ones",
    "option",
    "options",
    "available",
    "like",
    "which",
    "better",
    "best",
    "recommend",
    "recommended",
    "suggest",
    "vs",
    "versus",
    "between",
    "from",
    "into",
    "around",
    "about",
  ]);
  const tokens = raw
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && t.length >= 3 && !stop.has(t))
    .slice(0, 10);
  if (!tokens.length) return [];

  const scored: Array<{ p: Product; score: number }> = [];
  for (const p of Array.isArray(products) ? products : []) {
    const hay = normText(`${p.name ?? ""} ${p.category ?? ""} ${p.description ?? ""}`);
    if (!hay) continue;
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 1;
      if (normText(p.name ?? "").includes(tok)) score += 2;
      if (normText(p.category ?? "").includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.p.price ?? 0) - (b.p.price ?? 0));
  return scored.map((s) => s.p);
}

function parsePriceConstraint(text: string) {
  const raw = (text ?? "").toLowerCase();
  const parseAmount = (s: string) => {
    const t = (s ?? "").toLowerCase().replace(/,/g, "").trim();
    const m = t.match(/^(\d+(?:\.\d{1,2})?)(k)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    return m[2] ? Math.round(n * 1000) : Math.round(n);
  };
  const nums = Array.from(raw.matchAll(/(\d[\d,]{1,7}(?:\.\d{1,2})?k?)/g))
    .map((m) => parseAmount(m[1] ?? ""))
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
  const between = raw.match(
    /between\s+(?:[a-z]{2,4}|[€£$₦₵])?\s*(\d[\d,]{1,7}(?:\.\d{1,2})?k?)\s*(?:and|to|-|–)\s*(?:[a-z]{2,4}|[€£$₦₵])?\s*(\d[\d,]{1,7}(?:\.\d{1,2})?k?)/
  );
  if (between) {
    const a = parseAmount(between[1] ?? "");
    const b = parseAmount(between[2] ?? "");
    if (typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
  }
  const dash = raw.match(
    /(?:^|\s)(?:[a-z]{2,4}|[€£$₦₵])?\s*(\d[\d,]{1,7}(?:\.\d{1,2})?k?)\s*(?:-|–)\s*(?:[a-z]{2,4}|[€£$₦₵])?\s*(\d[\d,]{1,7}(?:\.\d{1,2})?k?)(?:\s|$)/
  );
  if (dash) {
    const a = parseAmount(dash[1] ?? "");
    const b = parseAmount(dash[2] ?? "");
    if (typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
  }
  const under = raw.match(/(?:under|below|less than|max|budget)\s+(?:[a-z]{2,4}|[€£$₦₵])?\s*(\d[\d,]{1,7}(?:\.\d{1,2})?k?)/);
  if (under) {
    const max = parseAmount(under[1] ?? "");
    if (typeof max === "number" && Number.isFinite(max)) return { max };
  }
  const over = raw.match(/(?:over|above|more than|at least|minimum|min)\s+(?:[a-z]{2,4}|[€£$₦₵])?\s*(\d[\d,]{1,7}(?:\.\d{1,2})?k?)/);
  if (over) {
    const min = parseAmount(over[1] ?? "");
    if (typeof min === "number" && Number.isFinite(min)) return { min };
  }
  if (nums.length === 1 && (/\b(ghs|usd|eur|gbp|ngn|kes|zar|cad|aud|inr|cny|jpy)\b/i.test(raw) || /[€£$₦₵]/.test(raw))) {
    const max = nums[0]!;
    if (Number.isFinite(max)) return { max };
  }
  return {};
}

function looksLikeServiceInquiry(text: string) {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const patterns = [
    /\b(software|website|web\s*site|web\s*app|mobile\s*app|application|pos|point of sale)\b/i,
    /\b(pharmacy|school|hotel|management system|automation|saas|ocr)\b/i,
    /\b(bot|whatsapp bot)\b/i,
  ];
  return patterns.some((re) => re.test(t));
}

export function createEllbot(deps: EllbotDeps) {
  const userSessions: Record<string, Session> = {};
  const openRouterErrorThrottle = new Map<string, number>();
  let openRouterCursor = 0;
  const vendorProductsCache = new Map<string, { at: number; products: Product[] }>();
  const handoffControls = new Map<string, { peer: string; at: number }>();
  const sessionsDir = path.join(process.cwd(), "data");
  const sessionsPath = path.join(sessionsDir, `whatsapp-sessions-${deps.vendorId}.json`);
  let sessionsLoaded = false;
  let sessionsLoadPromise: Promise<void> | null = null;
  let saveTimer: NodeJS.Timeout | null = null;
  let saveInFlight: Promise<void> | null = null;
  let dirty = false;

  function nowMs() {
    return Date.now();
  }

  function normalizePeer(raw: string) {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    if (s.includes("@")) return deps.jidNormalizedUser(s);
    const phone = deps.cleanPhone(s).replace(/^\+/, "");
    return phone ? deps.jidNormalizedUser(`${phone}@s.whatsapp.net`) : "";
  }

  function dmUrlForPeer(peer: string) {
    const p = String(peer ?? "").trim();
    if (!p) return null;
    if (p.endsWith("@lid")) return null;
    if (!p.includes("@")) return null;
    const left = p.includes("@") ? p.split("@")[0] ?? "" : p;
    const digits = left.replace(/[^\d]/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return `https://wa.me/${digits}`;
  }

  function newHandoffToken() {
    const a = nowMs().toString(36);
    const b = Math.random().toString(36).slice(2, 10);
    return `${a}${b}`.slice(-12).toUpperCase();
  }

  function rememberHandoffToken(token: string, peer: string) {
    if (!token || !peer) return;
    const now = nowMs();
    handoffControls.set(token, { peer, at: now });
    const maxAgeMs = 48 * 60 * 60_000;
    for (const [k, v] of handoffControls.entries()) {
      if (!v || typeof v.at !== "number" || now - v.at > maxAgeMs) handoffControls.delete(k);
    }
  }

  async function sendHandoffNotifyCard(to: string, body: string, dmUrl: string | null, token: string) {
    const text = (body ?? "").trim().slice(0, 1024) || "Handoff";
    const buttons: any[] = [];
    if (dmUrl) {
      buttons.push({
        name: "cta_url",
        buttonParamsJson: JSON.stringify({
          display_text: "View chat",
          url: dmUrl,
          merchant_url: dmUrl,
        }),
      });
    } else {
      buttons.push({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: "View chat", id: `HANDOFF_VIEW_CHAT:${token}` }),
      });
    }
    buttons.push(
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: "Enable bot", id: `HANDOFF_BOT_ON:${token}` }),
      },
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: "Disable bot", id: `HANDOFF_BOT_OFF:${token}` }),
      }
    );
    const msg = deps.generateWAMessageFromContent(
      to,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage: {
              header: { title: "", hasMediaAttachment: false },
              body: { text },
              footer: { text: "EllTek" },
              nativeFlowMessage: {
                buttons,
              },
            },
          },
        },
      } as any
      ,
      { userJid: (deps.sock as any).user?.id }
    );
    await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Handoff relay timed out.");
  }

  function isExcludedPeer(to: string, excluded: unknown) {
    if (!Array.isArray(excluded) || !excluded.length) return false;
    const target = normalizePeer(to);
    if (!target) return false;
    for (const x of excluded) {
      if (typeof x !== "string") continue;
      const norm = normalizePeer(x);
      if (norm && norm === target) return true;
    }
    return false;
  }

  function isValidEmail(email: string) {
    const e = String(email ?? "").trim();
    if (!e) return false;
    if (e.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  function sessionLastAt(s: Session) {
    const h = Array.isArray(s.history) && s.history.length ? s.history[s.history.length - 1]?.at : undefined;
    const n = typeof h === "number" && Number.isFinite(h) ? h : 0;
    return n || (typeof s.greetedAt === "number" && Number.isFinite(s.greetedAt) ? s.greetedAt : 0) || 0;
  }

  async function loadSessionsFromDisk() {
    try {
      const raw = await fs.readFile(sessionsPath, "utf8");
      const json = JSON.parse(raw);
      const sessions = (json && typeof json === "object" ? (json as any).sessions : null) as any;
      if (!sessions || typeof sessions !== "object") return;
      const now = nowMs();
      const maxAgeMs = 7 * 24 * 60 * 60_000;
      const entries = Object.entries(sessions) as Array<[string, any]>;
      for (const [jid, v] of entries) {
        if (!jid || typeof v !== "object" || !v) continue;
        const lastAt = typeof v.lastAt === "number" ? v.lastAt : Number(v.lastAt);
        if (Number.isFinite(lastAt) && lastAt > 0 && now - lastAt > maxAgeMs) continue;
        const stateRaw = typeof v.state === "string" ? v.state : "chat";
        const state =
          stateRaw === "awaiting_qty" ||
          stateRaw === "awaiting_delivery_method" ||
          stateRaw === "awaiting_delivery_address" ||
          stateRaw === "awaiting_email" ||
          stateRaw === "selecting_payment_method" ||
          stateRaw === "awaiting_momo_number" ||
          stateRaw === "chat"
            ? stateRaw
            : "chat";
        const hist = Array.isArray(v.history) ? (v.history as any[]) : [];
        const history = hist
          .map((h) => ({
            dir: (h?.dir === "out" ? "out" : "in") as "in" | "out",
            text: typeof h?.text === "string" ? h.text.slice(0, 1200) : "",
            at: typeof h?.at === "number" && Number.isFinite(h.at) ? h.at : 0,
          }))
          .filter((h) => h.text && h.at > 0)
          .slice(-30);
        userSessions[jid] = {
          state,
          cart: null,
          email: typeof v.email === "string" ? v.email : undefined,
          momoNumber: typeof v.momoNumber === "string" ? v.momoNumber : undefined,
          lastReference: typeof v.lastReference === "string" ? v.lastReference : undefined,
          greetedAt: typeof v.greetedAt === "number" && Number.isFinite(v.greetedAt) ? v.greetedAt : undefined,
          lastNudgeAt: typeof v.lastNudgeAt === "number" && Number.isFinite(v.lastNudgeAt) ? v.lastNudgeAt : undefined,
          lastNudgeSig: typeof v.lastNudgeSig === "string" ? v.lastNudgeSig : undefined,
          aiFallbackAt: typeof v.aiFallbackAt === "number" && Number.isFinite(v.aiFallbackAt) ? v.aiFallbackAt : undefined,
          deliveryMethodId: typeof v.deliveryMethodId === "string" ? v.deliveryMethodId : undefined,
          deliveryMethodName: typeof v.deliveryMethodName === "string" ? v.deliveryMethodName : undefined,
          deliveryFeeCents: typeof v.deliveryFeeCents === "number" && Number.isFinite(v.deliveryFeeCents) ? v.deliveryFeeCents : undefined,
          deliveryAddress: typeof v.deliveryAddress === "string" ? v.deliveryAddress : undefined,
          history: history.length ? history : undefined,
          lastProductTopic: typeof v.lastProductTopic === "string" ? v.lastProductTopic : undefined,
          lastResultsMinPrice: typeof v.lastResultsMinPrice === "number" && Number.isFinite(v.lastResultsMinPrice) ? v.lastResultsMinPrice : undefined,
          lastResultsCategory: typeof v.lastResultsCategory === "string" ? v.lastResultsCategory : undefined,
        };
      }
    } catch {
      void 0;
    }
  }

  async function ensureSessionsLoaded() {
    if (sessionsLoaded) return;
    if (sessionsLoadPromise) return await sessionsLoadPromise;
    sessionsLoadPromise = (async () => {
      sessionsLoaded = true;
      await loadSessionsFromDisk();
    })();
    await sessionsLoadPromise;
  }

  async function saveSessionsToDisk() {
    if (saveInFlight) return await saveInFlight;
    saveInFlight = (async () => {
      if (!dirty) return;
      dirty = false;
      const now = nowMs();
      const max = 500;
      const list = Object.entries(userSessions)
        .map(([jid, s]) => ({ jid, s, lastAt: sessionLastAt(s) }))
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, max);
      const sessions: Record<string, any> = {};
      for (const it of list) {
        sessions[it.jid] = {
          lastAt: it.lastAt,
          state: it.s.state,
          email: it.s.email,
          momoNumber: it.s.momoNumber,
          lastReference: it.s.lastReference,
          greetedAt: it.s.greetedAt,
          lastNudgeAt: it.s.lastNudgeAt,
          lastNudgeSig: it.s.lastNudgeSig,
          aiFallbackAt: it.s.aiFallbackAt,
          deliveryMethodId: it.s.deliveryMethodId,
          deliveryMethodName: it.s.deliveryMethodName,
          deliveryFeeCents: it.s.deliveryFeeCents,
          deliveryAddress: it.s.deliveryAddress,
          history: Array.isArray(it.s.history) ? it.s.history.slice(-30) : undefined,
          lastProductTopic: it.s.lastProductTopic,
          lastResultsMinPrice: it.s.lastResultsMinPrice,
          lastResultsCategory: it.s.lastResultsCategory,
        };
      }
      const payload = JSON.stringify({ v: 1, savedAt: now, sessions }, null, 2);
      await fs.mkdir(sessionsDir, { recursive: true });
      const tmp = `${sessionsPath}.tmp`;
      await fs.writeFile(tmp, payload, "utf8");
      await fs.rename(tmp, sessionsPath);
    })().finally(() => {
      saveInFlight = null;
    });
    await saveInFlight;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveSessionsToDisk();
    }, 1200);
  }

  async function getOpenRouterConfig() {
    const cfg = await fetchVendorBotConfig(deps.vendorId);
    const vendorKeys = cfg?.openrouter?.keys ?? [];
    const envKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
    const keys = vendorKeys.length ? vendorKeys : envKey ? [envKey] : [];
    const modelFromVendor =
      typeof (cfg as any)?.openrouter?.model === "string" ? String((cfg as any).openrouter.model).trim() : "";
    const modelFromEnv = (process.env.OPENROUTER_MODEL ?? "").trim();
    const defaultModel = "meta-llama/llama-3-8b-instruct:free";
    const model = (modelFromVendor || modelFromEnv || defaultModel).trim();
    const fallbackModel = (modelFromEnv || defaultModel).trim();
    return { keys, model, modelFromVendor: modelFromVendor || null, fallbackModel };
  }

  async function fetchProductsForVendorCached(vendorId: string) {
    const cached = vendorProductsCache.get(vendorId);
    if (cached && nowMs() - cached.at < 45_000) return cached.products;
    const products = await fetchProductsForVendor(vendorId);
    vendorProductsCache.set(vendorId, { at: nowMs(), products });
    return products;
  }

  async function openRouterChatVendor(arg1: any, arg2?: any): Promise<OpenRouterResult> {
    const { keys, model, modelFromVendor, fallbackModel } = await getOpenRouterConfig();
    if (!keys.length) return { ok: false, status: 0, message: "No OpenRouter API keys configured." };
    const payload =
      typeof arg1 === "string"
        ? ({
            messages: [
              { role: "system", content: String(arg1) },
              { role: "user", content: String(arg2 ?? "") },
            ],
            temperature: 0.1,
            max_tokens: 500,
          } as const)
        : (arg1 as { messages: readonly any[]; tools?: any[]; temperature?: number; max_tokens?: number });
    if (openRouterCursor >= keys.length) openRouterCursor = 0;
    const ordered = keys.slice(openRouterCursor).concat(keys.slice(0, openRouterCursor));
    let last: OpenRouterResult | null = null;
    for (let i = 0; i < ordered.length; i++) {
      const idx = (openRouterCursor + i) % keys.length;
      const r = await openRouterChatOneAdvanced(ordered[i] as string, model, payload);
      if (!r.ok && modelFromVendor && model === modelFromVendor && fallbackModel && fallbackModel !== model && looksLikeModelNotFound(r)) {
        const retry = await openRouterChatOneAdvanced(ordered[i] as string, fallbackModel, payload);
        if (retry.ok) {
          openRouterCursor = idx;
          return retry;
        }
        last = retry;
        if (!looksLikeKeyFailure(retry)) return retry;
        openRouterCursor = (idx + 1) % keys.length;
        continue;
      }
      if (r.ok) {
        openRouterCursor = idx;
        return r;
      }
      last = r;
      if (!looksLikeKeyFailure(r)) return r;
      openRouterCursor = (idx + 1) % keys.length;
    }
    return last ?? { ok: false, status: 0, message: "OpenRouter request failed." };
  }

  function pushHistory(session: Session, dir: "in" | "out", text: string) {
    const t = (text ?? "").toString().trim();
    if (!t) return;
    if (!session.history) session.history = [];
    session.history.push({ dir, text: t.slice(0, 1200), at: nowMs() });
    const limit = 50;
    if (session.history.length > limit) session.history = session.history.slice(session.history.length - limit);
    scheduleSave();
  }

  function formatHistoryForAI(session: Session, turns: number) {
    const n = Number.isFinite(turns) ? Math.max(0, Math.min(12, Math.floor(turns))) : 6;
    const hist = Array.isArray(session.history) ? session.history : [];
    if (!n || !hist.length) return "";
    const slice = hist.slice(Math.max(0, hist.length - n * 2));
    return slice.map((h) => `${h.dir === "in" ? "Customer" : "Agent"}: ${h.text}`).join("\n");
  }

  async function withLocalTimeout<T>(p: Promise<T>, ms: number, message: string) {
    return await deps.withTimeout(p, ms, message);
  }

  async function sendText(to: string, text: string) {
    await deps.withTimeout(deps.sock.sendMessage(to, { text } as any), 25_000, "Send timed out.");
  }

  async function sendWithMenu(to: string, session: Session, text: string, footerText?: string) {
    const choices: Array<{ label: string; id: string }> = session.cart
      ? [
          { label: "Cancel Order", id: "CANCEL_CHECKOUT" },
          { label: "Menu", id: "SHOW_CATALOG" },
        ]
      : [{ label: "Menu", id: "SHOW_CATALOG" }];
    await sendChoiceCard(to, text, choices, footerText ?? "EllTek");
  }

  async function sendMenuAndRemember(to: string, session: Session, text: string, footerText?: string) {
    await sendWithMenu(to, session, text, footerText);
    pushHistory(session, "out", text);
  }

  async function sendWithCancel(to: string, session: Session, text: string) {
    if (session.cart) {
      await sendChoiceCard(to, text, [{ label: "Cancel Order", id: "CANCEL_CHECKOUT" }], "EllTek");
      return;
    }
    await sendText(to, text);
  }

  async function sendAndRemember(to: string, session: Session, text: string) {
    await sendWithCancel(to, session, text);
    pushHistory(session, "out", text);
  }

  async function maybeTriggerHandoff(
    to: string,
    session: Session,
    vendorCfg: Awaited<ReturnType<typeof fetchVendorBotConfig>> | null,
    storeName: string,
    stage: "view_product" | "select_product" | "select_variation" | "before_payment",
    context: Record<string, unknown>
  ) {
    const hs = vendorCfg?.whatsappHandoffSettings;
    if (!hs || !hs.enabled) return false;
    const enabled =
      stage === "view_product"
        ? Boolean(hs.stages?.view_product)
        : stage === "select_product"
          ? Boolean(hs.stages?.select_product)
          : stage === "select_variation"
            ? Boolean(hs.stages?.select_variation)
            : Boolean(hs.stages?.before_payment);
    if (!enabled) return false;

    const customerName = (session.customerName ?? "").trim() || (session.customerPushName ?? "").trim() || null;

    const tokenRaw = typeof session.handoffToken === "string" && session.handoffToken.trim() ? session.handoffToken.trim() : newHandoffToken();
    const token = tokenRaw.toUpperCase();
    session.handoffToken = token;
    rememberHandoffToken(token, to);

    session.botPaused = true;
    scheduleSave();
    await sendChoiceCard(
      to,
      "I’ve handed this chat over to an assistant.\n\nI won’t reply until you tap *Continue with Bot* or type *Menu*.",
      [
        { label: "Continue with Bot", id: "RESUME_BOT" },
        { label: "Menu", id: "SHOW_CATALOG" },
      ],
      storeName
    );
    pushHistory(session, "out", "I’ve handed this chat over to an assistant.");
    void (async () => {
      if (hs.notifyPortal) {
        void createHandoff(deps.vendorId, {
          customer_peer: to,
          customer_name: customerName,
          stage,
          context: context && typeof context === "object" ? context : null,
        });
      }

      const peers = Array.isArray(hs.notifyPeers) ? hs.notifyPeers : [];
      const msgParts: string[] = [];
      msgParts.push(`Handoff (${stage})`);
      msgParts.push(`Customer: ${to}`);
      if (customerName) msgParts.push(`Name: ${customerName}`);
      const title = typeof (context as any)?.title === "string" ? String((context as any).title).trim() : "";
      if (title) msgParts.push(`Item: ${title.slice(0, 80)}`);
      const notifyText = msgParts.join("\n");
      const dmUrl = dmUrlForPeer(to);

      for (const p of peers) {
        const peer = normalizePeer(p);
        if (!peer) continue;
        try {
          await deps.withTimeout(sendHandoffNotifyCard(peer, notifyText, dmUrl, token), 25_000, "Notify send timed out.");
        } catch (e: unknown) {
          void 0;
        }
      }
    })();
    return true;
  }

  async function smartSearch(
    query: string,
    vendorId: string,
    allProducts: Product[],
    opts?: {
      category?: string | null;
      excludeCategory?: string | null;
      brand?: string | null;
      min?: number | null;
      max?: number | null;
      negativeKeywords?: string[];
    }
  ) {
    void vendorId;
    const q = (query ?? "").trim().toLowerCase();
    let filtered = Array.isArray(allProducts) ? allProducts : [];
    const negativeKeywords = Array.isArray(opts?.negativeKeywords)
      ? opts!.negativeKeywords
          .map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
          .filter((k) => k)
          .slice(0, 30)
      : [];

    const brand = typeof opts?.brand === "string" && opts.brand.trim() ? opts.brand.trim().toLowerCase() : null;
    if (brand) filtered = filtered.filter((p) => (p.brand ?? "").trim().toLowerCase() === brand);

    if (negativeKeywords.length) {
      filtered = filtered.filter((p) => {
        const parts = [
          typeof p?.name === "string" ? p.name : "",
          typeof p?.category === "string" ? p.category : "",
          typeof p?.brand === "string" ? p.brand : "",
          typeof p?.description === "string" ? p.description : "",
          ...(Array.isArray(p?.variations) ? p.variations.map((v) => (typeof v?.name === "string" ? v.name : "")) : []),
        ];
        const haystack = parts.join(" ").toLowerCase();
        return !negativeKeywords.some((bad) => haystack.includes(bad));
      });
    }

    const category = typeof opts?.category === "string" && opts.category.trim() ? opts.category.trim().toLowerCase() : null;
    if (category) filtered = filtered.filter((p) => (p.category ?? "").toLowerCase() === category);
    const excludeCategory = typeof opts?.excludeCategory === "string" && opts.excludeCategory.trim() ? opts.excludeCategory.trim().toLowerCase() : null;
    if (excludeCategory) filtered = filtered.filter((p) => (p.category ?? "").toLowerCase() !== excludeCategory);
    const min = typeof opts?.min === "number" && Number.isFinite(opts.min) ? opts.min : null;
    if (min !== null) filtered = filtered.filter((p) => typeof p.price === "number" && Number.isFinite(p.price) && p.price >= min);
    const max = typeof opts?.max === "number" && Number.isFinite(opts.max) ? opts.max : null;
    if (max !== null) filtered = filtered.filter((p) => typeof p.price === "number" && Number.isFinite(p.price) && p.price <= max);

    if (!q) return filtered.slice(0, 15);

    const stop = new Set([
      "i",
      "me",
      "want",
      "need",
      "show",
      "some",
      "any",
      "the",
      "a",
      "an",
      "and",
      "or",
      "for",
      "with",
      "please",
      "looking",
      "available",
    ]);
    const tokens = q
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !stop.has(t));

    if (!tokens.length) return filtered.slice(0, 15);

    const scored: Array<{ p: Product; score: number }> = [];
    for (const p of filtered) {
      let score = 0;
      const nameHay = (p.name ?? "").toLowerCase();
      const catHay = (p.category ?? "").toLowerCase();
      const descHay = (p.description ?? "").toLowerCase();
      const brandHay = (p.brand ?? "").toLowerCase();

      if (nameHay === q) score += 1000;
      else if (nameHay.includes(q)) score += 300;

      let tokensFoundInName = 0;
      for (const tok of tokens) {
        const exactRe = new RegExp(`\\b${tok}\\b`, "i");

        if (exactRe.test(nameHay)) {
          score += 50;
          tokensFoundInName++;
        } else if (nameHay.includes(tok)) {
          score += 10;
        }

        if (exactRe.test(catHay)) score += 20;
        if (exactRe.test(brandHay)) score += 100;
        if (exactRe.test(descHay)) score += 2;
      }

      if (tokens.length > 1 && tokensFoundInName === tokens.length) score += 150;

      const accessories = ["case", "cover", "charger", "cable", "protector", "screen", "dock", "earbud"];
      const wantsAccessory = accessories.some((acc) => q.includes(acc));
      if (!wantsAccessory) {
        for (const acc of accessories) {
          if (nameHay.includes(acc)) score -= 100;
        }
      }

      if (score > 0) scored.push({ p, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aLen = (a.p.name?.length ?? 0) | 0;
      const bLen = (b.p.name?.length ?? 0) | 0;
      if (aLen !== bLen) return aLen - bLen;
      return a.p.price - b.p.price;
    });
    return scored.map((s) => s.p).slice(0, 15);
  }

  function agentMessagesFromSession(session: Session, memoryTurns: number) {
    const n = Number.isFinite(memoryTurns) ? Math.max(0, Math.min(12, Math.floor(memoryTurns))) : 6;
    const hist = Array.isArray(session.history) ? session.history : [];
    const slice = n ? hist.slice(Math.max(0, hist.length - n * 2)) : [];
    return slice
      .map((h) => {
        const role = h.dir === "in" ? "user" : "assistant";
        const content = (h.text ?? "").toString().trim().slice(0, 1200);
        if (!content) return null;
        return { role, content };
      })
      .filter((m): m is { role: "user" | "assistant"; content: string } => Boolean(m));
  }

  function safeJsonParse(input: unknown) {
    if (typeof input !== "string" || !input.trim()) return null;
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }

  function extractFirstJsonObject(text: string) {
    const t = (text ?? "").toString();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return safeJsonParse(m[0]);
  }

  function looksLikeToolsUnsupported(r: OpenRouterResult) {
    if (r.ok) return false;
    if (r.status !== 400) return false;
    const msg = (r.message ?? "").toLowerCase();
    return msg.includes("tool") || msg.includes("tools") || msg.includes("tool_calls") || msg.includes("tool_choice") || msg.includes("function calling");
  }

  function looksLikeModelNotFound(r: OpenRouterResult) {
    if (r.ok) return false;
    if (!(r.status === 400 || r.status === 404)) return false;
    const msg = (r.message ?? "").toLowerCase();
    if (!msg.includes("model")) return false;
    return msg.includes("not found") || msg.includes("unknown") || msg.includes("does not exist") || msg.includes("invalid");
  }

  function looksLikeShoppingText(text: string) {
    const t = (text ?? "").toLowerCase();
    if (!t.trim()) return false;
    if (t.includes("menu") || t.includes("catalog")) return true;
    if (t.includes("show me") || t.includes("what do you have") || t.includes("available")) return true;
    if (/\b(buy|order|price|cost|budget|under|below|above|between)\b/.test(t)) return true;
    if (/\b(i need|need a|need an|i want|want a|want an|looking for|do you have)\b/.test(t)) return true;
    return false;
  }

  async function aiPlanCatalogSearchNoTools(args: { session: Session; input: string; storeName: string; memoryTurns: number }) {
    const cfg = await getOpenRouterConfig();
    const aiTimeoutMs = openRouterTimeoutMsForModel(cfg.model) + 5_000;
    const systemPrompt =
      `You are an elite WhatsApp sales agent for ${args.storeName}.\n` +
      `Return ONLY one line of JSON with keys:\n` +
      `query (string), brand (string|null), negative_keywords (string[]), min_price (number|null), max_price (number|null), intro_message (string).\n\n` +
      `Rules:\n` +
      `- If the user mentions a brand, set brand to that brand name (otherwise null).\n` +
      `- If the user wants to browse or says "show me", set query to the most relevant product type/category from context.\n` +
      `- negative_keywords must be an array (can be empty) to exclude accessories/irrelevant items for the context.\n` +
      `- intro_message must be brief.\n`;
    const history = agentMessagesFromSession(args.session, args.memoryTurns)
      .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
      .join("\n")
      .trim();
    const userPrompt = `${history ? `Conversation:\n${history}\n\n` : ""}Customer: ${(args.input ?? "").trim()}`;
    const resp = await withLocalTimeout(openRouterChatVendor(systemPrompt, userPrompt), aiTimeoutMs, "AI timed out.");
    if (!resp.ok) return null;
    const parsed = extractFirstJsonObject(resp.content ?? "");
    if (!parsed || typeof parsed !== "object") return null;
    const query = typeof (parsed as any).query === "string" ? String((parsed as any).query).trim() : "";
    const negative_keywords = Array.isArray((parsed as any).negative_keywords)
      ? (parsed as any).negative_keywords
          .map((k: unknown) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
          .filter((k: string) => k)
          .slice(0, 20)
      : [];
    const brand = typeof (parsed as any).brand === "string" ? String((parsed as any).brand).trim() : "";
    const min_price = typeof (parsed as any).min_price === "number" && Number.isFinite((parsed as any).min_price) ? (parsed as any).min_price : null;
    const max_price = typeof (parsed as any).max_price === "number" && Number.isFinite((parsed as any).max_price) ? (parsed as any).max_price : null;
    const intro_message = typeof (parsed as any).intro_message === "string" ? String((parsed as any).intro_message).trim() : "";
    if (!query && !brand) return null;
    return { query, brand: brand || null, negative_keywords, min_price, max_price, intro_message };
  }

  async function aiRefineCatalogHits(args: {
    session: Session;
    input: string;
    query: string;
    storeName: string;
    hits: Product[];
    memoryTurns: number;
  }) {
    const input = (args.input ?? "").trim();
    const query = (args.query ?? "").trim();
    const hits = Array.isArray(args.hits) ? args.hits : [];
    if (!hits.length) return hits;
    if (!input || !query) return hits;

    const strongTokens = (() => {
      const t = input.toLowerCase();
      const stop = new Set([
        "i",
        "me",
        "want",
        "need",
        "show",
        "some",
        "any",
        "the",
        "a",
        "an",
        "and",
        "or",
        "for",
        "with",
        "please",
        "looking",
        "available",
        "price",
        "cost",
        "buy",
        "order",
      ]);
      const raw = t
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x && !stop.has(x))
        .slice(0, 30);
      const out: string[] = [];
      const keepWords = new Set([
        "iphone",
        "ipad",
        "macbook",
        "samsung",
        "pixel",
        "tecno",
        "infinix",
        "nokia",
        "xiaomi",
        "redmi",
        "pro",
        "max",
        "mini",
        "plus",
        "ultra",
        "xr",
        "xs",
        "se",
        "air",
        "note",
      ]);
      for (const tok of raw) {
        if (/^\d{1,4}$/.test(tok)) {
          out.push(tok);
          continue;
        }
        if (/^\d+gb$/.test(tok)) {
          out.push(tok);
          continue;
        }
        const m = tok.match(/^(\d{1,4})([a-z]{2,})$/);
        if (m) {
          out.push(m[1], m[2]);
          continue;
        }
        if (keepWords.has(tok)) out.push(tok);
      }
      return Array.from(new Set(out)).slice(0, 12);
    })();

    const hardFilter = (list: Product[]) => {
      if (!strongTokens.length) return list;
      const out: Product[] = [];
      for (const p of list) {
        const parts = [
          typeof p?.name === "string" ? p.name : "",
          typeof p?.category === "string" ? p.category : "",
          typeof p?.brand === "string" ? p.brand : "",
          typeof p?.description === "string" ? p.description : "",
          ...(Array.isArray(p?.variations) ? p.variations.map((v) => (typeof v?.name === "string" ? v.name : "")) : []),
        ];
        const hay = parts
          .join(" ")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!hay) continue;
        const tokens = new Set(hay.split(" ").filter((x) => x));
        let ok = true;
        for (const s of strongTokens) {
          if (!tokens.has(s)) {
            ok = false;
            break;
          }
        }
        if (ok) out.push(p);
      }
      return out;
    };

    const cfg = await getOpenRouterConfig();
    const aiTimeoutMs = openRouterTimeoutMsForModel(cfg.model) + 5_000;

    const history = agentMessagesFromSession(args.session, args.memoryTurns)
      .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
      .join("\n")
      .trim();

    const candidates = hits
      .slice(0, 15)
      .map((p) => {
        const parts: string[] = [];
        parts.push(`id=${p.id}`);
        parts.push(`name=${(p.name ?? "").toString().trim().slice(0, 120)}`);
        const cat = (p.category ?? "").toString().trim();
        if (cat) parts.push(`category=${cat.slice(0, 60)}`);
        const brand = (p.brand ?? "").toString().trim();
        if (brand) parts.push(`brand=${brand.slice(0, 60)}`);
        parts.push(`price=${formatMoney(p.currency, Number.isFinite(p.price) ? p.price : 0)}`);
        const vs = Array.isArray(p.variations) ? p.variations : [];
        const vnames = vs
          .map((v) => (typeof v?.name === "string" ? v.name.trim() : ""))
          .filter((x) => x)
          .slice(0, 10);
        if (vnames.length) parts.push(`variations=${vnames.join(", ")}`);
        const desc = (p.description ?? "").toString().trim();
        if (desc) parts.push(`desc=${desc.slice(0, 140)}`);
        return `- ${parts.join(" | ")}`;
      })
      .join("\n");

    const systemPrompt =
      `You are a WhatsApp product matching engine for ${args.storeName}.\n` +
      `Your job is to FILTER the candidate results to only what truly fits the customer's request.\n` +
      `Be STRICT. If you are not confident a candidate matches, EXCLUDE it.\n\n` +
      `Return ONLY one line of JSON:\n` +
      `{ "keep_ids": number[] }\n\n` +
      `Rules:\n` +
      `- Only include IDs from the candidates list.\n` +
      `- Keep the best matches first.\n` +
      `- Max 6 results.\n` +
      `- If the customer specifies model/storage/specs (e.g. "iPhone 14 Pro 256GB"), ONLY keep exact matches.\n` +
      `- If the customer specifies a brand, exclude other brands.\n` +
      `- If nothing fits, return an empty array.\n` +
      `- Do NOT include any other keys or text.\n`;

    const userPrompt =
      `${history ? `Conversation:\n${history}\n\n` : ""}` +
      `Customer request: ${input}\n` +
      `Search query used: ${query}\n\n` +
      `Candidates:\n${candidates}\n\n` +
      `Return JSON now.`;

    const resp = await withLocalTimeout(openRouterChatVendor(systemPrompt, userPrompt), aiTimeoutMs, "AI timed out.");
    if (!resp.ok) return hardFilter(hits);

    const parsed = extractFirstJsonObject(resp.content ?? "");
    if (!parsed || typeof parsed !== "object") return hardFilter(hits);
    const keep_ids = Array.isArray((parsed as any).keep_ids) ? (parsed as any).keep_ids : null;
    if (!keep_ids) return hardFilter(hits);

    const allowed = new Map<number, Product>();
    for (const p of hits) allowed.set(p.id, p);
    const out: Product[] = [];
    for (const raw of keep_ids) {
      const id = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(id)) continue;
      const p = allowed.get(id);
      if (!p) continue;
      if (!out.includes(p)) out.push(p);
      if (out.length >= 6) break;
    }
    const filteredOut = hardFilter(out);
    return filteredOut.length ? filteredOut : out;
  }

  async function runAgenticTurn(args: {
    to: string;
    session: Session;
    input: string;
    products: Product[];
    storeName: string;
    shopPhone: string;
    storeFacts: string;
    slideCount: number;
    memoryTurns: number;
    assistantStyle: string;
    extraNotes: string;
  }) {
    const cfg = await getOpenRouterConfig();
    const aiTimeoutMs = openRouterTimeoutMsForModel(cfg.model) + 5_000;
    const styleGuide =
      args.assistantStyle === "interactive"
        ? "You are highly conversational. Ask clarifying questions to understand their exact needs, preferences, or budget BEFORE offering to check the system."
        : args.assistantStyle === "straightforward"
          ? "You are direct and efficient. Show products immediately using the search tool as soon as they mention a need."
          : "You are helpful and balanced. Converse naturally, offer brief recommendations, and check the system once their intent is clear.";
    const tools: any[] = [
      {
        type: "function",
        function: {
          name: "search_catalog",
          description:
            "Search the database and display interactive product cards. Call this ONLY after the user explicitly agrees to let you check the system/show products.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The specific product or brand to search (e.g., 'iPhone', 'Nike', 'Toyota')." },
              brand: {
                type: "string",
                description: "The specific brand requested by the user (e.g., 'Apple', 'Samsung', 'Nike'). Leave blank if no brand is specified.",
              },
              negative_keywords: {
                type: "array",
                items: { type: "string" },
                description:
                  "CRITICAL: Dynamically list words to exclude accessories or irrelevant items based on the context. (e.g., if they want a phone, exclude 'case', 'charger', 'light'. If they want a dress, exclude 'belt', 'bag').",
              },
              min_price: { type: "number" },
              max_price: { type: "number" },
              intro_message: {
                type: "string",
                description:
                  "Write a short, engaging header to introduce the products based on the conversation (e.g., 'I checked the system, here are the options we have!').",
              },
            },
            required: ["query", "negative_keywords", "intro_message"],
          },
        },
      },
    ];

    const systemInstruction =
      `You are a friendly WhatsApp sales assistant for ${args.storeName}.\n` +
      `Behavior Style: ${styleGuide}\n\n` +
      `STORE & DELIVERY INFO (YOU MAY USE THIS TO ANSWER QUESTIONS DIRECTLY):\n` +
      `${(args.storeFacts ?? "").trim() || "No extra store info provided."}\n\n` +
      `If the customer asks about delivery, payment, location, support phone, or store policies, answer using the STORE & DELIVERY INFO above. If you don't know, say so and offer the shop phone.\n\n` +
      `CRITICAL INVENTORY RULES (YOU MUST OBEY):\n` +
      `1) YOU ARE BLIND TO INVENTORY: You DO NOT know what is actually in stock. You must NEVER assume. NEVER say "Yes, we have it" or "We sell those."\n` +
      `2) AVAILABILITY QUESTIONS: If a user asks "Do you have X?" or "Is Y available?", you MUST reply exactly like this: "I can check my system to see if we have [X] in stock! Would you like me to pull up the options for you?"\n` +
      `3) BRAND NARROWING: If the user is vague ("I need a phone" / "Show me laptops"), ask their preferred brand (and/or budget) before offering to check the system.\n` +
      `4) SHOWING PRODUCTS: Only use the 'search_catalog' tool AFTER the user says "Yes" to letting you check, OR if they command you to show them ("Show me laptops").\n` +
      `5) NEVER list product names, options, or prices in plain text. Always rely on 'search_catalog' to render the WhatsApp UI.\n` +
      `6) KEEP IT SHORT: WhatsApp messages must be brief (1 to 3 sentences maximum).\n` +
      (args.extraNotes ? `Store Notes: ${args.extraNotes}\n` : "") +
      (args.shopPhone ? `Shop phone: ${args.shopPhone}\n` : "");

    let messages: any[] = [{ role: "system", content: systemInstruction }, ...agentMessagesFromSession(args.session, args.memoryTurns)];
    const maxRounds = 1;

    for (let round = 0; round < maxRounds; round++) {
      const resp = await withLocalTimeout(openRouterChatVendor({ messages, tools, temperature: 0.3, max_tokens: 450 } as any), aiTimeoutMs, "AI timed out.");
      if (!resp.ok) {
        if (looksLikeToolsUnsupported(resp)) {
          const planned = await aiPlanCatalogSearchNoTools({ session: args.session, input: args.input, storeName: args.storeName, memoryTurns: args.memoryTurns });
          if (planned) {
            let hits = await smartSearch(planned.query, deps.vendorId, args.products, {
              brand: planned.brand ?? null,
              min: planned.min_price,
              max: planned.max_price,
              negativeKeywords: planned.negative_keywords,
            });
            if (hits.length) {
              hits = await aiRefineCatalogHits({
                session: args.session,
                input: args.input,
                query: planned.query,
                storeName: args.storeName,
                hits,
                memoryTurns: args.memoryTurns,
              });
            }
            if (hits.length) {
              args.session.lastProductTopic = planned.query;
              const intro = (planned.intro_message || `Here are some options for *${planned.query}*:`).slice(0, 300);
              await sendAndRemember(args.to, args.session, intro);
              setLastCatalog(args.session, hits.map((p) => p.id), args.slideCount, "Matching Products");
              await sendCatalogPage(args.to, args.session, args.products, 0);
              return;
            }
            await sendMenuAndRemember(args.to, args.session, `I couldn't find any exact matches for *${planned.query}*. Tap Menu to browse.`, args.storeName);
            return;
          }
        }
        await sendAiUnavailableMenu(args.to, args.session, args.storeName, args.shopPhone, args.slideCount);
        return;
      }

      const toolCalls: any[] = Array.isArray((resp as any).tool_calls) ? ((resp as any).tool_calls as any[]) : [];
      if (!toolCalls.length) {
        const content = (resp.content ?? "").trim();
        const lc = content.toLowerCase();
        const isPresentingResults = lc.includes("here are") || lc.includes("i found") || lc.includes("these are") || lc.includes("i have pulled up");
        const isConfirmingSearch = parseConfirmDecision(args.input) === "yes" || (args.input ?? "").toLowerCase().includes("customer confirmed: yes");

        if (isConfirmingSearch || isPresentingResults) {
          const planned = await aiPlanCatalogSearchNoTools({ session: args.session, input: args.input, storeName: args.storeName, memoryTurns: args.memoryTurns });
          if (planned && (planned.query || planned.brand)) {
            const queryToSearch = (planned.query ?? "").trim() || (planned.brand ?? "").trim();
            let hits = await smartSearch(queryToSearch, deps.vendorId, args.products, {
              brand: planned.brand ?? null,
              min: planned.min_price,
              max: planned.max_price,
              negativeKeywords: planned.negative_keywords,
            });
            if (hits.length) {
              hits = await aiRefineCatalogHits({
                session: args.session,
                input: args.input,
                query: queryToSearch,
                storeName: args.storeName,
                hits,
                memoryTurns: args.memoryTurns,
              });
            }
            if (hits.length) {
              args.session.lastProductTopic = (planned.query || planned.brand || "products").slice(0, 80);
              const intro = (planned.intro_message || `Here are the options I found:`).slice(0, 300);
              await sendAndRemember(args.to, args.session, intro);
              setLastCatalog(args.session, hits.map((p) => p.id), args.slideCount, "Matching Products");
              await sendCatalogPage(args.to, args.session, args.products, 0);
              return;
            }
            await sendMenuAndRemember(
              args.to,
              args.session,
              `I'm sorry, I just checked the system and we don't have exactly what you're looking for right now.`,
              args.storeName
            );
            return;
          }
        }

        if (content) {
          await sendAndRemember(args.to, args.session, content);
          return;
        }

        await sendAndRemember(args.to, args.session, "How can I help you today?");
        return;
      }

      const tc = toolCalls[0];
      const name = String(tc?.function?.name ?? tc?.name ?? "").trim();
      const rawArgs = tc?.function?.arguments ?? "";
      const parsed = safeJsonParse(rawArgs) ?? {};

      if (name !== "search_catalog") {
        const content = (resp.content ?? "").trim();
        if (content) await sendAndRemember(args.to, args.session, content);
        else await sendAndRemember(args.to, args.session, "How can I help you today?");
        return;
      }

      const query = typeof (parsed as any).query === "string" ? String((parsed as any).query).trim() : "";
      const brand = typeof (parsed as any).brand === "string" ? String((parsed as any).brand).trim() : "";
      const negativeKeywords = Array.isArray((parsed as any).negative_keywords)
        ? (parsed as any).negative_keywords
            .map((k: unknown) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
            .filter((k: string) => k)
            .slice(0, 20)
        : [];
      const min_price = typeof (parsed as any).min_price === "number" && Number.isFinite((parsed as any).min_price) ? (parsed as any).min_price : null;
      const max_price = typeof (parsed as any).max_price === "number" && Number.isFinite((parsed as any).max_price) ? (parsed as any).max_price : null;
      const intro = typeof (parsed as any).intro_message === "string" ? String((parsed as any).intro_message).trim() : "";

      const queryToSearch = query || brand;
      let hits = queryToSearch
        ? await smartSearch(queryToSearch, deps.vendorId, args.products, {
            brand: brand || null,
            min: min_price,
            max: max_price,
            negativeKeywords,
          })
        : [];

      if (hits.length) {
        hits = await aiRefineCatalogHits({
          session: args.session,
          input: args.input,
          query: queryToSearch,
          storeName: args.storeName,
          hits,
          memoryTurns: args.memoryTurns,
        });
      }
      if (hits.length) {
        if (queryToSearch) args.session.lastProductTopic = queryToSearch;
        const finalIntro = (intro || `Here are some options for *${queryToSearch}*:`).slice(0, 300);
        await sendAndRemember(args.to, args.session, finalIntro);
        setLastCatalog(args.session, hits.map((p) => p.id), args.slideCount, "Matching Products");
        await sendCatalogPage(args.to, args.session, args.products, 0);
        return;
      }

      await sendMenuAndRemember(
        args.to,
        args.session,
        query ? `I couldn't find any exact matches for *${query}*. Tap Menu to browse.` : "Tap Menu to browse.",
        args.storeName
      );
      return;
    }

    await sendAndRemember(args.to, args.session, "Please try again.");
  }

  function isGreeting(text: string) {
    const t = (text ?? "").toLowerCase().trim();
    if (!t) return false;
    return t === "hi" || t === "hello" || t === "hey" || t === "good morning" || t === "good afternoon" || t === "good evening";
  }

  function productUnitPrice(product: Product, variation: ProductVariation | null) {
    if (variation && typeof variation.price === "number" && Number.isFinite(variation.price)) return variation.price;
    return Number.isFinite(product.price) ? product.price : 0;
  }

  function cartTitle(product: Product, variation: ProductVariation | null) {
    return variation ? `${product.name} — ${variation.name}` : product.name;
  }

  function buildCartItem(product: Product, variation: ProductVariation | null, qty: number): CartItem {
    const unitPrice = productUnitPrice(product, variation);
    const image_url = (variation?.images?.[0] ?? "").trim() || (product.image_url ?? "").trim();
    const max = maxQtyForProduct(product);
    const safeQty = Number.isFinite(qty) ? Math.max(1, Math.min(max > 0 ? max : 1, Math.floor(qty))) : 1;
    return { product, variation, title: cartTitle(product, variation), unitPrice, qty: safeQty, image_url };
  }

  function maxQtyForProduct(product: Product) {
    const stockRaw = Number.isFinite(product.stock) ? Math.floor(product.stock) : 0;
    const stock = Math.max(0, stockRaw);
    if (product.track_inventory) return stock;
    return stock > 0 ? stock : 99;
  }

  async function ensureValidQtyOrPrompt(to: string, session: Session) {
    if (!session.cart) return true;
    const qty = Math.max(1, Number.isFinite(session.cart.qty) ? Math.floor(session.cart.qty) : 1);
    const max = maxQtyForProduct(session.cart.product);
    if (max <= 0) {
      session.state = "chat";
      scheduleSave();
      await sendWithMenu(to, session, "❌ This item is currently out of stock. Tap Menu to pick another item.");
      return false;
    }
    if (qty > max) {
      session.state = "awaiting_qty";
      scheduleSave();
      await sendWithCancel(to, session, `Please enter a valid quantity between 1 and ${max}.`);
      return false;
    }
    return true;
  }

  function productPriceLabel(product: Product) {
    const vs = Array.isArray(product.variations) ? product.variations : [];
    if (!vs.length) return `*${formatMoney(product.currency, product.price)}*`;
    const prices = vs
      .map((v) => (typeof v.price === "number" && Number.isFinite(v.price) ? v.price : null))
      .filter((x): x is number => typeof x === "number");
    if (!prices.length) return `*${formatMoney(product.currency, product.price)}*`;
    const min = Math.min(...prices);
    return `*From ${formatMoney(product.currency, min)}*`;
  }

  async function sendPaymentOptions(to: string, cart: CartItem, delivery?: { feeCents: number; methodName: string | null }) {
    const qty = Math.max(1, cart.qty || 1);
    const subtotal = Math.max(0, Number.isFinite(cart.unitPrice) ? cart.unitPrice : 0) * qty;
    const feeCents = typeof delivery?.feeCents === "number" && Number.isFinite(delivery.feeCents) ? Math.max(0, Math.round(delivery.feeCents)) : 0;
    const shipping = feeCents / 100;
    const total = subtotal + shipping;
    const text = (
      `💳 *Checkout Summary*\n\n` +
      `*Order:* ${cart.title.slice(0, 40)}\n` +
      `*Qty:* ${qty}\n` +
      `*Subtotal:* ${formatMoney(cart.product.currency, subtotal)}\n` +
      `${feeCents ? `*Delivery:* ${formatMoney(cart.product.currency, shipping)}${delivery?.methodName ? ` (${delivery.methodName})` : ""}\n` : ""}` +
      `*Total:* ${formatMoney(cart.product.currency, total)}\n\n` +
      `Please tap a payment method below:`
    ).slice(0, 1024);

    const media = await prepareImageMedia(cart.image_url || cart.product.image_url, cart.title, "Payment media prepare timed out.");

    const cfg = await fetchVendorBotConfig(deps.vendorId);
    const canPaystack = Boolean(cfg?.payments?.paystack?.configured);
    const canManual = Boolean(cfg?.manualPayment?.enabled);

    const allButtons: Array<{ name: string; buttonParamsJson: string }> = [];
    if (canPaystack) {
      allButtons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Paystack Link", id: "PAY_LINK" }) });
      allButtons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Direct MoMo", id: "PAY_DIRECT" }) });
    }
    if (canManual) {
      allButtons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Manual payment", id: "PAY_MANUAL" }) });
    } else {
      allButtons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Call to Order", id: "PAY_MANUAL" }) });
    }
    allButtons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Cancel Order", id: "CANCEL_CHECKOUT" }) });

    for (let i = 0; i < allButtons.length; i += 3) {
      const chunk = allButtons.slice(i, i + 3);
      const isFirst = i === 0;
      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: isFirst ? { title: "", hasMediaAttachment: true, ...media } : { title: "", hasMediaAttachment: false },
                body: { text: isFirst ? text : "Other options:" },
                footer: { text: "Secure Payment" },
                nativeFlowMessage: { buttons: chunk },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );
      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Payment options relay timed out.");
      if (i + 3 < allButtons.length) await new Promise((r) => setTimeout(r, 600));
    }
  }

  function normalizeLooseName(s: string) {
    return (s ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeStoreName(name: string, storeName: string) {
    const n = normalizeLooseName(name);
    const sn = normalizeLooseName(storeName);
    if (!n || !sn) return false;
    if (n === sn) return true;
    if (sn.length >= 4 && (n.includes(sn) || sn.includes(n))) return true;
    return false;
  }

  function resolveCustomerName(session: Session, storeName: string) {
    const saved = (session.customerName ?? "").trim();
    if (saved && !looksLikeStoreName(saved, storeName)) return saved.slice(0, 200);
    const wa = (session.customerPushName ?? "").trim();
    if (wa && !looksLikeStoreName(wa, storeName)) return wa.slice(0, 200);
    return "";
  }

  async function sendCheckoutReview(to: string, session: Session, storeName: string) {
    const cart = session.cart;
    if (!cart) {
      session.state = "chat";
      scheduleSave();
      await sendWithMenu(to, session, "Your cart is empty. Tap Menu to browse.", storeName);
      return;
    }

    const resolvedName = resolveCustomerName(session, storeName);
    if (!resolvedName) {
      session.state = "awaiting_name";
      scheduleSave();
      await promptName(to, session, storeName);
      return;
    }
    if (!(session.customerName ?? "").trim()) {
      session.customerName = resolvedName;
      scheduleSave();
      void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: session.customerPushName, name: resolvedName });
    }

    const qty = Math.max(1, Number.isFinite(cart.qty) ? Math.floor(cart.qty) : 1);
    const max = maxQtyForProduct(cart.product);
    if (max > 0 && qty > max) {
      session.state = "awaiting_qty";
      scheduleSave();
      await sendText(to, `Please enter a quantity between 1 and ${max}.`);
      return;
    }

    const email = (session.email ?? "").trim();
    if (!email || !isValidEmail(email)) {
      session.state = "awaiting_email";
      scheduleSave();
      await sendText(to, "Please provide your email address for the payment receipt:");
      return;
    }

    const method = (session.deliveryMethodName ?? "").trim();
    const isPickup = /\bpickup\b/i.test(method);
    const addr = (session.deliveryAddress ?? "").trim();
    if (!isPickup && !addr) {
      session.state = "awaiting_delivery_address";
      scheduleSave();
      await sendText(to, "Please type your delivery address (street + landmark):");
      return;
    }

    session.state = "reviewing_checkout";
    scheduleSave();

    const feeCents = typeof session.deliveryFeeCents === "number" && Number.isFinite(session.deliveryFeeCents) ? Math.max(0, Math.round(session.deliveryFeeCents)) : 0;
    const subtotal = Math.max(0, Number.isFinite(cart.unitPrice) ? cart.unitPrice : 0) * qty;
    const total = subtotal + feeCents / 100;
    const summary =
      `🧾 *Confirm your details*\n\n` +
      `Item: *${cart.title.slice(0, 50)}*\n` +
      `Qty: *${qty}*\n` +
      `Total: *${formatMoney(cart.product.currency, total)}*\n\n` +
      `Name: ${resolvedName}\n` +
      `Email: ${email}\n` +
      `Delivery: ${method || (isPickup ? "Pickup" : "N/A")}${!isPickup && addr ? `\nAddress: ${addr.slice(0, 120)}` : ""}`;

    const choices: Array<{ label: string; id: string }> = [
      { label: "Proceed", id: "CHECKOUT_PROCEED" },
      { label: "Change Name", id: "CHANGE_NAME" },
      { label: "Change Email", id: "CHANGE_EMAIL" },
    ];
    if (!isPickup) choices.push({ label: "Change Address", id: "CHANGE_ADDRESS" });
    await sendChoiceCard(to, summary, choices, storeName);
    await sendChoiceCard(to, "Need to stop?", [{ label: "Cancel", id: "CANCEL_CHECKOUT" }], "EllTek");
  }

  async function promptEmail(to: string, session: Session, storeName: string) {
    const savedEmail = (session.email ?? "").trim();
    if (savedEmail && isValidEmail(savedEmail)) {
      await sendChoiceCard(
        to,
        `Saved email:\n${savedEmail}\n\nUse this email for the payment receipt?`,
        [
          { label: "Use Email", id: "USE_EMAIL" },
          { label: "Change", id: "CHANGE_EMAIL" },
          { label: "Cancel", id: "CANCEL_CHECKOUT" },
        ],
        storeName
      );
      return;
    }
    await sendText(to, "Please provide your email address for the payment receipt:");
  }

  async function promptAddress(to: string, session: Session, storeName: string) {
    const savedAddr = (session.deliveryAddress ?? "").trim();
    if (savedAddr) {
      await sendChoiceCard(
        to,
        `Saved delivery address:\n${savedAddr.slice(0, 220)}\n\nUse this address?`,
        [
          { label: "Use Address", id: "USE_ADDRESS" },
          { label: "Change", id: "CHANGE_ADDRESS" },
          { label: "Cancel", id: "CANCEL_CHECKOUT" },
        ],
        storeName
      );
      return;
    }
    await sendText(to, "Please type your delivery address (street + landmark):");
  }

  async function promptName(to: string, session: Session, storeName: string) {
    const savedNameRaw = (session.customerName ?? "").trim();
    const savedName = savedNameRaw && !looksLikeStoreName(savedNameRaw, storeName) ? savedNameRaw : "";
    if (savedName) {
      await sendChoiceCard(
        to,
        `Saved name:\n${savedName}\n\nUse this name for your order?`,
        [
          { label: "Use Name", id: "USE_NAME" },
          { label: "Change", id: "CHANGE_NAME" },
          { label: "Cancel", id: "CANCEL_CHECKOUT" },
        ],
        storeName
      );
      return;
    }
    const waNameRaw = (session.customerPushName ?? "").trim();
    const waName = waNameRaw && !looksLikeStoreName(waNameRaw, storeName) ? waNameRaw : "";
    if (waName) {
      await sendChoiceCard(
        to,
        `WhatsApp name:\n${waName}\n\nUse this name for your order?`,
        [
          { label: "Use WhatsApp Name", id: "USE_WA_NAME" },
          { label: "Enter Name", id: "CHANGE_NAME" },
          { label: "Cancel", id: "CANCEL_CHECKOUT" },
        ],
        storeName
      );
      return;
    }
    await sendWithCancel(to, session, "Please type your full name:");
  }

  async function initiateMarketplaceCheckout(to: string, session: Session) {
    const store = await fetchStoreSlug(deps.vendorId);
    if (!store || !store.slug) throw new Error("Store not found.");
    if (!session.cart) throw new Error("Cart is empty.");
    const email = (session.email ?? "").trim();
    if (!email) throw new Error("Missing email.");
    const name = (session.customerName ?? "").trim();
    const body = {
      store_slug: store.slug,
      name: name || undefined,
      email,
      shipping: {
        method: typeof session.deliveryMethodId === "string" && session.deliveryMethodId.trim() ? session.deliveryMethodId.trim() : undefined,
        fee_cents:
          typeof session.deliveryFeeCents === "number" && Number.isFinite(session.deliveryFeeCents) ? Math.max(0, Math.round(session.deliveryFeeCents)) : 0,
        address: typeof session.deliveryAddress === "string" && session.deliveryAddress.trim() ? session.deliveryAddress.trim() : undefined,
      },
      items: [
        {
          product_id: session.cart.product.id,
          variation_id: session.cart.variation?.id ?? undefined,
          qty: Math.max(1, session.cart.qty || 1),
        },
      ],
    };
    const url = `${apiBase()}/marketplace/checkout/link`;
    const { ok, json } = await postJson(url, body, {}, 25_000);
    if (!ok) {
      const msg = typeof (json as any)?.message === "string" ? (json as any).message : "Checkout failed.";
      throw new Error(msg);
    }
    const authorizationUrl = (json as any)?.authorization_url ?? (json as any)?.data?.authorization_url ?? null;
    if (typeof authorizationUrl !== "string" || !authorizationUrl.trim()) {
      const msg = typeof (json as any)?.message === "string" ? (json as any).message : "Payment link unavailable.";
      throw new Error(msg);
    }
    const reference = typeof (json as any)?.reference === "string" ? String((json as any).reference).trim() : "";
    if (reference) session.lastReference = reference;
    session.state = "chat";
    const qty = Math.max(1, session.cart.qty || 1);
    const subtotal = Math.max(0, Number.isFinite(session.cart.unitPrice) ? session.cart.unitPrice : 0) * qty;
    const feeCents = typeof session.deliveryFeeCents === "number" && Number.isFinite(session.deliveryFeeCents) ? Math.max(0, Math.round(session.deliveryFeeCents)) : 0;
    const deliveryFee = feeCents / 100;
    const total = subtotal + deliveryFee;
    await sendText(
      to,
      `🔗 *Payment Link Generated*\n\nOrder: ${session.cart.title}\nQty: ${qty}\nSubtotal: ${formatMoney(session.cart.product.currency, subtotal)}\n${feeCents ? `Delivery: ${formatMoney(session.cart.product.currency, deliveryFee)}\n` : ""}Total: ${formatMoney(session.cart.product.currency, total)}\nRef: ${reference || "N/A"}\n\nPay here: ${authorizationUrl}\n\nAfter payment, reply: *PAID ${reference || ""}*`
    );
  }

  function placeholderUrl(label: string) {
    const safe = (label ?? "").trim().slice(0, 60) || "Item";
    return `https://placehold.co/600x400/103629/ffffff/png?text=${encodeURIComponent(safe.replace(/ /g, "+"))}`;
  }

  async function prepareImageMedia(url: string, label: string, timeoutMessage: string) {
    const primary = absolutizeMediaUrl(url) || placeholderUrl(label);
    try {
      return await deps.withTimeout(
        Promise.resolve(deps.prepareWAMessageMedia({ image: { url: primary } }, { upload: (deps.sock as any).waUploadToServer })),
        25_000,
        timeoutMessage
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Media prepare failed.";
      if (!/\b404\b/.test(msg) && !/status code 404/i.test(msg)) deps.onError(msg);
      const fallback = placeholderUrl(label);
      return await deps.withTimeout(
        Promise.resolve(deps.prepareWAMessageMedia({ image: { url: fallback } }, { upload: (deps.sock as any).waUploadToServer })),
        25_000,
        timeoutMessage
      );
    }
  }

  async function sendProductCards(to: string, products: Product[], slideCount: number) {
    const limit = Number.isFinite(slideCount) ? Math.max(1, Math.min(10, Math.floor(slideCount))) : 10;
    const byId = new Map<number, Product>();
    for (const p of Array.isArray(products) ? products : []) {
      if (p && typeof p.id === "number" && !byId.has(p.id)) byId.set(p.id, p);
    }
    const list = Array.from(byId.values()).slice(0, limit);
    if (!list.length) return;

    for (const p of list) {
      const hasVars = Array.isArray(p.variations) && p.variations.length > 0;
      const media = await prepareImageMedia(p.image_url, p.name, "Product media prepare timed out.");
      const name = (p.name ?? "").trim().slice(0, 50) || "Item";

      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: { title: "", hasMediaAttachment: true, ...media },
                body: { text: `*${name}*\n💰 ${productPriceLabel(p)}` },
                footer: { text: "EllTek" },
                nativeFlowMessage: {
                  buttons: [
                    { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "View Details", id: `VIEW_PRODUCT ${p.id}` }) },
                    {
                      name: "quick_reply",
                      buttonParamsJson: JSON.stringify({
                        display_text: hasVars ? "Options" : "Buy Now",
                        id: `BUY ${p.id}`,
                      }),
                    },
                  ],
                },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );

      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Product relay timed out.");
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  function setLastCatalog(session: Session, ids: number[], per: number, title: string) {
    const cleanIds = Array.from(
      new Set(
        (Array.isArray(ids) ? ids : [])
          .map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.floor(x) : NaN))
          .filter((x) => Number.isFinite(x))
      )
    );
    const safePer = Number.isFinite(per) ? Math.max(1, Math.min(10, Math.floor(per))) : 5;
    session.lastCatalog = {
      at: nowMs(),
      title: (title ?? "").trim().slice(0, 60) || "Catalog",
      ids: cleanIds,
      per: safePer,
      page: 0,
    };
    scheduleSave();
  }

  function getCatalogPageCount(c: NonNullable<Session["lastCatalog"]>) {
    const total = Array.isArray(c.ids) ? c.ids.length : 0;
    const per = Number.isFinite(c.per) ? Math.max(1, Math.floor(c.per)) : 5;
    return Math.max(1, Math.ceil(total / per));
  }

  async function sendCatalogNav(to: string, page: number, pages: number) {
    const p = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
    const total = Number.isFinite(pages) ? Math.max(1, Math.floor(pages)) : 1;
    const buttons: any[] = [];
    if (p > 0) buttons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Prev", id: "CAT_PREV" }) });
    if (p + 1 < total) buttons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Next", id: "CAT_NEXT" }) });
    buttons.push({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Menu", id: "SHOW_CATALOG" }) });

    const msg = deps.generateWAMessageFromContent(
      to,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage: {
              header: { title: "", hasMediaAttachment: false },
              body: { text: `Navigation (Page ${p + 1}/${total})` },
              footer: { text: "EllTek" },
              nativeFlowMessage: { buttons },
            },
          },
        },
      } as any,
      { userJid: (deps.sock as any).user?.id }
    );
    await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Navigation relay timed out.");
  }

  async function sendChoiceCard(to: string, body: string, choices: Array<{ label: string; id: string }>, footerText?: string, media?: any) {
    const buttons = (Array.isArray(choices) ? choices : [])
      .filter((c) => c && c.id && c.label)
      .slice(0, 3)
      .map((c) => ({ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: c.label.trim().slice(0, 20), id: c.id }) }));
    if (!buttons.length) return;

    const msg = deps.generateWAMessageFromContent(
      to,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage: {
              header: media ? { title: "", hasMediaAttachment: true, ...media } : { title: "", hasMediaAttachment: false },
              body: { text: (body ?? "").trim().slice(0, 1024) || "Select an option" },
              footer: { text: (footerText ?? "EllTek").trim().slice(0, 60) || "EllTek" },
              nativeFlowMessage: { buttons },
            },
          },
        },
      } as any,
      { userJid: (deps.sock as any).user?.id }
    );
    await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Choice relay timed out.");
  }

  async function sendOptionsButtons(
    to: string,
    title: string,
    options: Array<{ label: string; description?: string; id: string }>,
    footerText?: string
  ) {
    const list = Array.isArray(options) ? options.filter((o) => o && o.id && o.label) : [];
    if (!list.length) return;

    const chunkSize = 3;
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize);
      const bodyLines = chunk.map((o) => {
        const label = (o.label ?? "").trim().slice(0, 60) || "Option";
        const desc = (o.description ?? "").trim().slice(0, 120);
        return desc ? `• ${label}\n  ${desc}` : `• ${label}`;
      });
      const body = (i === 0 ? `${(title ?? "").trim().slice(0, 90)}\n\n` : "") + bodyLines.join("\n\n");
      const buttons = chunk.map((o) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: (o.label ?? "").trim().slice(0, 20) || "Select", id: o.id }),
      }));

      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: { title: "", hasMediaAttachment: false },
                body: { text: body.slice(0, 1024) },
                footer: { text: (footerText ?? "EllTek").trim().slice(0, 60) || "EllTek" },
                nativeFlowMessage: { buttons },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );
      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Options relay timed out.");
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  async function sendCatalogPage(to: string, session: Session, products: Product[], page: number) {
    const c = session.lastCatalog;
    if (!c || typeof c !== "object") {
      await sendWithMenu(to, session, "Tap Menu to browse products.");
      return;
    }
    if (nowMs() - (typeof c.at === "number" ? c.at : 0) > 30 * 60_000) {
      session.lastCatalog = undefined;
      scheduleSave();
      await sendWithMenu(to, session, "Catalog expired. Tap Menu to browse again.");
      return;
    }
    const pages = getCatalogPageCount(c);
    const idx = Number.isFinite(page) ? Math.max(0, Math.min(pages - 1, Math.floor(page))) : 0;
    c.page = idx;
    scheduleSave();

    const byId = new Map<number, Product>();
    for (const p of Array.isArray(products) ? products : []) {
      if (p && typeof p.id === "number") byId.set(p.id, p);
    }
    const start = idx * c.per;
    const chunkIds = c.ids.slice(start, start + c.per);
    const chunk: Product[] = [];
    for (const id of chunkIds) {
      const p = byId.get(id);
      if (p) chunk.push(p);
    }
    if (!chunk.length) {
      await sendWithMenu(to, session, "No products found for this page. Tap Menu to browse again.");
      return;
    }

    await sendText(to, `🛍️ *${c.title}* (Page ${idx + 1}/${pages})\nScroll down to view products:`);
    await sendProductCards(to, chunk, c.per);
    await sendCatalogNav(to, idx, pages);
  }

  async function sendActionCarousel(
    to: string,
    title: string,
    cardsIn: Array<{ title: string; body: string; buttonText: string; buttonId: string }>,
    slideCount: number
  ) {
    const limit = Number.isFinite(slideCount) ? Math.max(1, Math.min(10, Math.floor(slideCount))) : 10;
    const list = cardsIn
      .slice(0, limit)
      .map((c) => ({
        title: (c.title ?? "").trim(),
        body: (c.body ?? "").trim(),
        buttonText: (c.buttonText ?? "").trim(),
        buttonId: (c.buttonId ?? "").trim(),
      }))
      .filter((c) => c.title && c.buttonId);
    if (!list.length) return;

    let text = `📋 *${(title ?? "").trim().slice(0, 80) || "Menu"}*\n\n`;
    for (const c of list) {
      const t = c.title.slice(0, 30);
      const b = c.body.replace(/\n/g, " ").slice(0, 60);
      text += `• *${t}*: ${b}\n`;
    }
    text = `${text.trim()}\n\nTap an option below:`.slice(0, 1024);

    const allButtons = list.map((c) => ({
      name: "quick_reply",
      buttonParamsJson: JSON.stringify({ display_text: (c.buttonText || c.title).slice(0, 20) || "Select", id: c.buttonId }),
    }));

    for (let i = 0; i < allButtons.length; i += 3) {
      const chunk = allButtons.slice(i, i + 3);
      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: { title: "", hasMediaAttachment: false },
                body: { text: i === 0 ? text : "More options:" },
                footer: { text: "EllTek" },
                nativeFlowMessage: { buttons: chunk },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );
      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Action menu relay timed out.");
      if (i + 3 < allButtons.length) await new Promise((r) => setTimeout(r, 600));
    }
  }

  async function sendAiUnavailableMenu(to: string, session: Session, storeName: string, shopPhone: string, slideCount: number) {
    session.aiFallbackAt = nowMs();
    scheduleSave();
    const cards = [
      {
        title: "Browse Products",
        body: `Browse ${storeName}'s products by category.`,
        buttonText: "Browse Products",
        buttonId: "AI_FALLBACK_BROWSE",
      },
      {
        title: "Contact Support",
        body: shopPhone ? `Contact support on ${shopPhone}.` : "Contact support for help placing your order.",
        buttonText: "Contact Support",
        buttonId: "AI_FALLBACK_SUPPORT",
      },
    ];
    await sendActionCarousel(to, "I’m unable to use AI right now. What would you like to do?", cards, 10);
  }

  async function sendDeliveryPicker(
    to: string,
    session: Session,
    storeName: string,
    delivery: { currency: string; methods: Array<{ id: string; name: string; feeCents: number; eta: string; areas: string[]; instructions: string }> } | null,
    slideCount: number
  ) {
    const methods = Array.isArray(delivery?.methods) ? delivery!.methods : [];
    const list = methods.filter((m) => m && m.id && m.name).slice(0, Math.max(1, Math.min(10, slideCount)));
    if (!list.length) {
      session.deliveryMethodId = undefined;
      session.deliveryMethodName = undefined;
      session.deliveryFeeCents = undefined;
      const email = (session.email ?? "").trim();
      if (email && isValidEmail(email)) {
        scheduleSave();
        await sendCheckoutReview(to, session, storeName);
      } else {
        session.state = "awaiting_email";
        scheduleSave();
        await promptEmail(to, session, storeName);
      }
      return;
    }
    session.state = "awaiting_delivery_method";
    scheduleSave();
    let text = `🚚 *Delivery Options*\n\n`;
    for (const m of list) {
      const fee = Math.max(0, Number.isFinite(m.feeCents) ? Math.round(m.feeCents) : 0) / 100;
      const eta = (m.eta ?? "").trim();
      const priceStr = fee > 0 ? formatMoney(delivery?.currency || "GHS", fee) : "Free";
      text += `• *${(m.name ?? "").trim().slice(0, 30)}*: ${priceStr}${eta ? ` (ETA: ${eta.slice(0, 24)})` : ""}\n`;
    }
    text = `${text.trim()}\n\nPlease tap a method below:`.slice(0, 1024);

    const allButtons = [
      ...list.map((m) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: (m.name ?? "").trim().slice(0, 20) || "Select", id: `DELIVERY ${m.id}` }),
      })),
      { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "🛑 Cancel", id: "CANCEL_CHECKOUT" }) },
    ];

    for (let i = 0; i < allButtons.length; i += 3) {
      const chunk = allButtons.slice(i, i + 3);
      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: { title: "", hasMediaAttachment: false },
                body: { text: i === 0 ? text : "More delivery options:" },
                footer: { text: "EllTek" },
                nativeFlowMessage: { buttons: chunk },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );
      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Delivery picker relay timed out.");
      if (i + 3 < allButtons.length) await new Promise((r) => setTimeout(r, 600));
    }
  }

  function getVendorCategories(products: Product[]) {
    const counts = new Map<string, number>();
    for (const p of Array.isArray(products) ? products : []) {
      const c = (typeof p?.category === "string" ? p.category.trim() : "").trim();
      if (!c) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([name, count]) => ({ name, count }));
  }

  function getVendorBrands(products: Product[], category: string | null) {
    const counts = new Map<string, number>();
    const catKey = (category ?? "").trim().toLowerCase();
    for (const p of Array.isArray(products) ? products : []) {
      const c = (typeof p?.category === "string" ? p.category.trim() : "").trim();
      if (catKey && c.trim().toLowerCase() !== catKey) continue;
      const b = (typeof p?.brand === "string" ? p.brand.trim() : "").trim();
      if (!b) continue;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([name, count]) => ({ name, count }));
  }

  async function sendButtonsOnlyChunks(
    to: string,
    firstText: string,
    nextText: string,
    options: Array<{ label: string; id: string }>,
    footerText?: string
  ) {
    const list = Array.isArray(options) ? options.filter((o) => o && o.id && o.label) : [];
    if (!list.length) return;
    const chunkSize = 3;
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize);
      const buttons = chunk.map((o) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({ display_text: (o.label ?? "").trim().slice(0, 20) || "Select", id: o.id }),
      }));
      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: { title: "", hasMediaAttachment: false },
                body: { text: (i === 0 ? firstText : nextText).trim().slice(0, 1024) },
                footer: { text: (footerText ?? "EllTek").trim().slice(0, 60) || "EllTek" },
                nativeFlowMessage: { buttons },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );
      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Buttons relay timed out.");
      if (i + chunkSize < list.length) await new Promise((r) => setTimeout(r, 600));
    }
  }

  async function sendMenuCategories(to: string, session: Session, products: Product[], storeName: string) {
    const cats = getVendorCategories(products);
    const list = ["__ALL__", ...cats.map((c) => c.name)];
    session.menu = { at: nowMs(), step: "categories", categories: list, category: null, brands: [], brand: null };
    scheduleSave();
    const options = list.map((name, idx) => ({ label: name === "__ALL__" ? "All Products" : name, id: `MENU_CAT ${idx}` }));
    await sendButtonsOnlyChunks(to, "Pick a category:", "More categories:", options, storeName);
  }

  async function sendMenuCategoryActions(to: string, session: Session, products: Product[], storeName: string, category: string | null) {
    const brands = getVendorBrands(products, category);
    session.menu = {
      at: nowMs(),
      step: "actions",
      categories: session.menu?.categories ?? [],
      category,
      brands: brands.map((b) => b.name),
      brand: null,
    };
    scheduleSave();
    const choices: Array<{ label: string; id: string }> = [{ label: "Products", id: "MENU_CAT_PRODUCTS" }];
    if (brands.length) choices.push({ label: "Brands", id: "MENU_CAT_BRANDS" });
    choices.push({ label: "Back", id: "SHOW_CATALOG" });
    const title = category ? `Category: *${category}*` : "All Products";
    await sendChoiceCard(to, `${title}\n\nWhat would you like to browse?`, choices, storeName);
  }

  async function sendMenuBrands(to: string, session: Session, storeName: string) {
    const brands = Array.isArray(session.menu?.brands) ? session.menu!.brands : [];
    if (!brands.length) {
      await sendMenuCategoryActions(to, session, await fetchProductsForVendorCached(deps.vendorId), storeName, session.menu?.category ?? null);
      return;
    }
    session.menu = {
      at: nowMs(),
      step: "brands",
      categories: session.menu?.categories ?? [],
      category: session.menu?.category ?? null,
      brands,
      brand: session.menu?.brand ?? null,
    };
    scheduleSave();
    const options = brands.map((name, idx) => ({ label: name, id: `MENU_BRAND ${idx}` }));
    await sendButtonsOnlyChunks(to, "Pick a brand:", "More brands:", options, storeName);
    await sendChoiceCard(to, "Navigation", [{ label: "Back", id: "MENU_BACK_CAT" }, { label: "Menu", id: "SHOW_CATALOG" }], storeName);
  }

  async function showMenuProducts(to: string, session: Session, products: Product[], storeName: string, cfg: { catalogCount: number; itemsPerPage: number; allowRandom: boolean; allowLatest: boolean }) {
    const cat = (session.menu?.category ?? null) ? String(session.menu?.category ?? "").trim() : null;
    const brand = (session.menu?.brand ?? null) ? String(session.menu?.brand ?? "").trim() : null;
    const catKey = (cat ?? "").toLowerCase();
    const brandKey = (brand ?? "").toLowerCase();
    const filtered = products.filter((p) => {
      if (catKey) {
        const c = (p.category ?? "").trim().toLowerCase();
        if (c !== catKey) return false;
      }
      if (brandKey) {
        const b = (p.brand ?? "").trim().toLowerCase();
        if (b !== brandKey) return false;
      }
      return true;
    });
    if (!filtered.length) {
      await sendWithMenu(to, session, "No products found for that selection. Tap Menu to browse again.", storeName);
      return;
    }
    const titleParts = [];
    if (cat) titleParts.push(cat);
    if (brand) titleParts.push(brand);
    const title = titleParts.length ? titleParts.join(" · ").slice(0, 60) : "Catalog";
    await sendMenuCatalog(to, session, filtered, cfg, title);
  }

  async function sendAiFallbackCategories(to: string, session: Session, products: Product[], catalogCount: number, slideCount: number) {
    session.aiFallbackAt = nowMs();
    scheduleSave();
    if (!products.length) {
      await sendText(to, "No products are available right now. Please try again shortly.");
      return;
    }
    const cats = getVendorCategories(products);
    if (!cats.length) {
      await sendMenuCatalog(to, session, products, { catalogCount, itemsPerPage: slideCount, allowRandom: false, allowLatest: true });
      return;
    }
    const total = Math.max(1, Math.min(50, Math.floor(catalogCount)));
    const per = Math.max(1, Math.min(10, Math.floor(slideCount)));
    const list = [{ name: "__ALL__", count: products.length }, ...cats].slice(0, total);
    const pages = Math.max(1, Math.min(6, Math.ceil(list.length / per)));
    for (let i = 0; i < pages; i++) {
      const chunk = list.slice(i * per, i * per + per);
      if (!chunk.length) break;
      await sendActionCarousel(
        to,
        `Categories ${i + 1}/${pages}`,
        chunk.map((c) => ({
          title: c.name === "__ALL__" ? "All Products" : c.name,
          body: `${c.count} item(s)`,
          buttonText: "Browse",
          buttonId: `AI_FALLBACK_CAT ${c.name}`,
        })),
        per
      );
    }
  }

  async function sendVariationPicker(to: string, product: Product, page: number) {
    void page;
    const vs = Array.isArray(product.variations) ? product.variations : [];
    const list = vs.slice(0, 10);
    if (!list.length) {
      await sendText(to, "No options are available for this product.");
      return;
    }

    const safeDesc = ((product.description ?? "") as string).trim().slice(0, 700);
    const text = (
      `*${(product.name ?? "").trim().slice(0, 60)}*\n` +
      `💰 ${productPriceLabel(product)}\n\n` +
      `${safeDesc}\n\n` +
      `*Please tap your choice below:*`
    ).slice(0, 1024);

    const media = await prepareImageMedia(product.image_url, product.name, "Product media prepare timed out.");
    const allButtons = [
      ...list.map((v) => ({
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: String((v as any).name ?? "").trim().slice(0, 20) || "Select",
          id: `SELECT_VARIATION ${product.id} ${(v as any).id}`,
        }),
      })),
      { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "🔙 Back", id: "SHOW_CATALOG" }) },
    ];

    for (let i = 0; i < allButtons.length; i += 3) {
      const chunk = allButtons.slice(i, i + 3);
      const isFirst = i === 0;
      const msg = deps.generateWAMessageFromContent(
        to,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
              interactiveMessage: {
                header: isFirst ? { title: "", hasMediaAttachment: true, ...media } : { title: "", hasMediaAttachment: false },
                body: { text: isFirst ? text : "More options:" },
                footer: { text: "EllTek" },
                nativeFlowMessage: { buttons: chunk },
              },
            },
          },
        } as any,
        { userJid: (deps.sock as any).user?.id }
      );
      await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Variation picker relay timed out.");
      if (i + 3 < allButtons.length) await new Promise((r) => setTimeout(r, 600));
    }
  }

  async function sendVariationDetails(to: string, product: Product, variation: ProductVariation) {
    const img = (variation.images?.[0] ?? "").trim() || product.image_url;
    const media = await prepareImageMedia(img, `${product.name} ${variation.name}`, "Variation media prepare timed out.");

    const unit = productUnitPrice(product, variation);
    const safeDesc = ((product.description ?? "") as string).slice(0, 800);
    const msg = deps.generateWAMessageFromContent(
      to,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage: {
              header: { title: "", hasMediaAttachment: true, ...media },
              body: {
                text: `*${product.name.trim().slice(0, 60)}*\n*Variation:* ${variation.name}\n💰 *Price:* ${formatMoney(product.currency, unit)}\n\n${safeDesc}`.slice(0, 1024),
              },
              footer: { text: "EllTek" },
              nativeFlowMessage: {
                buttons: [
                  { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Buy Now", id: `BUY_VAR ${product.id} ${variation.id}` }) },
                  { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Back", id: `VIEW_PRODUCT ${product.id}` }) },
                ],
              },
            },
          },
        },
      } as any,
      { userJid: (deps.sock as any).user?.id }
    );
    await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Variation details relay timed out.");
  }

  async function sendProductDetails(to: string, product: Product) {
    const hasVars = Array.isArray(product.variations) && product.variations.length > 0;
    if (hasVars) {
      await sendVariationPicker(to, product, 0);
      return;
    }

    const used = (product.image_url ?? "").trim();
    const remainingImages = (Array.isArray(product.images) ? product.images : [])
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x) => x && x !== used);
    const remainingVideos = (Array.isArray(product.videos) ? product.videos : [])
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x) => x && x !== used);

    const queue: { kind: "image" | "video"; url: string }[] = [];
    for (const u of remainingImages) queue.push({ kind: "image", url: u });
    for (const u of remainingVideos) queue.push({ kind: "video", url: u });

    const uniq = new Set<string>();
    const capped = queue
      .filter((m) => (uniq.has(`${m.kind}:${m.url}`) ? false : (uniq.add(`${m.kind}:${m.url}`), true)))
      .slice(0, 4);

    if (capped.length > 1) {
      const album = capped.map((m) => (m.kind === "video" ? ({ video: { url: m.url } } as any) : ({ image: { url: m.url } } as any)));
      try {
        await deps.withTimeout(deps.sock.sendMessage(to, { album } as any, { delayMs: 400 } as any), 60_000, "Album send timed out.");
      } catch (e: unknown) {
        deps.onError(e instanceof Error ? e.message : "Album send failed.");
        for (const m of capped) {
          try {
            if (m.kind === "video") {
              await deps.withTimeout(deps.sock.sendMessage(to, { video: { url: m.url } } as any), 30_000, "Video send timed out.");
            } else {
              await deps.withTimeout(deps.sock.sendMessage(to, { image: { url: m.url } } as any), 30_000, "Image send timed out.");
            }
            await new Promise((r) => setTimeout(r, 600));
          } catch (e2: unknown) {
            deps.onError(e2 instanceof Error ? e2.message : "Media send failed.");
          }
        }
      }
    } else if (capped.length === 1) {
      const m = capped[0]!;
      try {
        if (m.kind === "video") {
          await deps.withTimeout(deps.sock.sendMessage(to, { video: { url: m.url } } as any), 30_000, "Video send timed out.");
        } else {
          await deps.withTimeout(deps.sock.sendMessage(to, { image: { url: m.url } } as any), 30_000, "Image send timed out.");
        }
        await new Promise((r) => setTimeout(r, 400));
      } catch (e: unknown) {
        deps.onError(e instanceof Error ? e.message : "Media send failed.");
      }
    }

    const media = await prepareImageMedia(product.image_url, product.name, "Product media prepare timed out.");
    const safeDesc = ((product.description ?? "") as string).slice(0, 800);
    const msg = deps.generateWAMessageFromContent(
      to,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage: {
              header: { title: "", hasMediaAttachment: true, ...media },
              body: {
                text: `*${product.name.trim().slice(0, 60)}*\n\n💰 *Price:* ${formatMoney(product.currency, product.price)}\n\n${safeDesc}`.slice(0, 1024),
              },
              footer: { text: "EllTek" },
              nativeFlowMessage: {
                buttons: [
                  { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Buy Now", id: `BUY ${product.id}` }) },
                  { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Catalog", id: "SHOW_CATALOG" }) },
                ],
              },
            },
          },
        },
      } as any,
      { userJid: (deps.sock as any).user?.id }
    );
    await deps.withTimeout(deps.sock.relayMessage(to, (msg as any).message, { messageId: (msg as any).key?.id }), 25_000, "Details relay timed out.");
  }

  async function sendStatusForwardProduct(to: string, product: Product) {
    const title = (product.name ?? "").trim();
    const descRaw = (product.description ?? "").trim();
    const desc = descRaw.length > 260 ? `${descRaw.slice(0, 260)}…` : descRaw;
    const cat = (product.category ?? "").trim();
    const link = (product.link ?? "").trim();
    const parts: string[] = [];
    if (title) parts.push(`*${title}*`);
    parts.push(`Price: ${formatMoney(product.currency, product.price)}`);
    if (cat) parts.push(`Category: ${cat}`);
    if (desc) parts.push(desc);
    if (link) parts.push(`More details: ${link}`);
    parts.push("Forward this image to your Status");
    const caption = parts.join("\n\n").trim();

    const url = (product.image_url ?? "").trim();
    if (!url) {
      await sendText(to, caption);
      return;
    }
    await deps.withTimeout(deps.sock.sendMessage(to, { image: { url }, caption } as any), 30_000, "Status forward send timed out.");
  }

  function applyTemplate(text: string, vars: Record<string, string>) {
    let out = (text ?? "").toString();
    for (const [k, v] of Object.entries(vars)) {
      const re = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi");
      out = out.replace(re, v);
    }
    return out;
  }

  function shuffleInPlace<T>(arr: T[]) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
    return arr;
  }

  function detectSortIntent(text: string, cfg: { allowRandom: boolean; allowPriceSort: boolean; allowLatest: boolean }) {
    const t = (text ?? "").toLowerCase();
    if (cfg.allowRandom && (t.includes("random") || t.includes("surprise"))) return "random";
    if (
      cfg.allowPriceSort &&
      (t.includes("low to high") || t.includes("lowest price"))
    )
      return "price_asc";
    if (
      cfg.allowPriceSort &&
      (t.includes("high to low") || t.includes("expensive") || t.includes("highest price") || t.includes("premium"))
    )
      return "price_desc";
    if (cfg.allowLatest && (t.includes("latest") || t.includes("newest") || t.includes("recent"))) return "latest";
    return null as "random" | "price_asc" | "price_desc" | "latest" | null;
  }

  function detectCategoryIntent(text: string, products: Product[]) {
    const t = (text ?? "").toLowerCase();
    if (!t) return null;
    const cats = Array.from(
      new Set(
        (Array.isArray(products) ? products : [])
          .map((p) => (typeof p.category === "string" ? p.category.trim() : ""))
          .filter((c) => c)
      )
    );
    if (!cats.length) return null;
    for (const c of cats) {
      const lc = c.toLowerCase();
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
    const variants = new Set<string>();
    variants.add(lc);
    if (lc.endsWith("s") && lc.length > 3) variants.add(lc.slice(0, -1));
    if (!lc.endsWith("s")) variants.add(`${lc}s`);
    for (const v of variants) {
      const re = new RegExp(`\\b${esc(v)}\\b`, "i");
      if (re.test(t)) return c;
    }
    }
    return null;
  }

  function applySort(products: Product[], mode: "latest" | "price_asc" | "price_desc" | "random") {
    const list = Array.isArray(products) ? products.slice() : [];
    if (mode === "random") return shuffleInPlace(list);
    if (mode === "price_asc") return list.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    if (mode === "price_desc") return list.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    return list.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  }

  async function sendMenuCatalog(
    to: string,
    session: Session,
    products: Product[],
    cfg: { catalogCount: number; itemsPerPage: number; allowRandom: boolean; allowLatest: boolean },
    title?: string
  ) {
    const total = Math.max(1, Math.min(50, Math.floor(cfg.catalogCount)));
    const per = Math.max(1, Math.min(10, Math.floor(cfg.itemsPerPage)));
    const arranged = cfg.allowRandom ? shuffleInPlace(products.slice()) : cfg.allowLatest ? applySort(products, "latest") : products.slice();
    const picked = arranged.slice(0, total);
    setLastCatalog(
      session,
      picked.map((p) => p.id),
      per,
      typeof title === "string" && title.trim() ? title.trim() : "Catalog"
    );
    await sendCatalogPage(to, session, products, 0);
  }

  async function handleDm(to: string, rawText: string, pushName?: string) {
    let text = (rawText ?? "").trim();
    if (!text) return;
    await ensureSessionsLoaded();
    if (!userSessions[to]) userSessions[to] = { state: "chat", cart: null, greetedAt: 0, lastNudgeAt: 0, lastNudgeSig: "" };
    const session = userSessions[to];
    const pn = typeof pushName === "string" ? pushName.trim() : "";
    if (pn) session.customerPushName = pn.slice(0, 200);
    pushHistory(session, "in", text);
    const upperTextRaw = text.toUpperCase().trim();

    if (upperTextRaw.startsWith("HANDOFF_BOT_ON:") || upperTextRaw.startsWith("HANDOFF_BOT_OFF:") || upperTextRaw.startsWith("HANDOFF_VIEW_CHAT:")) {
      const parts = upperTextRaw.split(":");
      const token = parts.length >= 2 ? parts.slice(1).join(":").trim().slice(0, 32) : "";
      if (!token) {
        await sendText(to, "Invalid handoff control.");
        return;
      }
      const mapped = handoffControls.get(token);
      if (!mapped || !mapped.peer) {
        await sendText(to, "This handoff control has expired. Ask the bot to handoff again.");
        return;
      }
      const customerPeer = mapped.peer;
      if (!userSessions[customerPeer]) userSessions[customerPeer] = { state: "chat", cart: null, greetedAt: 0, lastNudgeAt: 0, lastNudgeSig: "" };
      const customerSession = userSessions[customerPeer]!;

      if (upperTextRaw.startsWith("HANDOFF_VIEW_CHAT:")) {
        const dm = dmUrlForPeer(customerPeer);
        if (dm) {
          await sendText(to, dm);
          return;
        }
        await sendText(to, `Customer: ${customerPeer}\nThis customer uses a hidden WhatsApp ID, so a direct wa.me link may not be available.`);
        return;
      }

      if (upperTextRaw.startsWith("HANDOFF_BOT_ON:")) {
        customerSession.botPaused = false;
        scheduleSave();
        await sendText(to, "Bot enabled for this customer.");
        return;
      }

      customerSession.botPaused = true;
      scheduleSave();
      await sendText(to, "Bot disabled for this customer.");
      return;
    }

    const dy = session.pendingDidYouMean;
    if (dy && session.state === "chat" && !session.pendingConfirm && nowMs() - dy.at < 3 * 60_000) {
      const decision = parseConfirmDecision(text);
      if (decision === "yes") {
        session.pendingDidYouMean = undefined;
        session.pendingShopText = undefined;
        text = dy.suggestion;
      } else if (decision === "no") {
        session.pendingDidYouMean = undefined;
        session.pendingShopText = undefined;
        await sendText(to, "Okay — please type the product name again (or tell me the type and your budget).");
        return;
      }
    } else if (dy) {
      session.pendingDidYouMean = undefined;
    }

    const lastOut = Array.isArray(session.history) ? [...session.history].reverse().find((h) => h && h.dir === "out" && (h.text ?? "").trim()) : null;
    const lastOutText = (lastOut?.text ?? "").toString().trim();
    const decisionNow = session.state === "chat" ? parseConfirmDecision(text) : null;
    if (session.state === "chat" && decisionNow === "yes" && looksLikeCheckPermissionPrompt(lastOutText)) {
      const hist = Array.isArray(session.history) ? session.history : [];
      let prevIn = "";
      for (let i = hist.length - 2; i >= 0; i--) {
        const h = hist[i];
        if (h && h.dir === "in" && (h.text ?? "").toString().trim()) {
          prevIn = (h.text ?? "").toString().trim();
          break;
        }
      }
      if (prevIn) {
        text = `${prevIn}\n\nCustomer confirmed: YES. Please check the system and show options now.`;
      }
    }

    let upperText = text.toUpperCase().trim();
    const menuAgeOk =
      typeof session.menu?.at === "number" && Number.isFinite(session.menu.at) && nowMs() - (session.menu.at as number) < 30 * 60_000;
    if (menuAgeOk) {
      const t = text.trim().toLowerCase();
      if (session.menu?.step === "categories" && !upperText.startsWith("MENU_CAT") && Array.isArray(session.menu?.categories) && session.menu!.categories.length) {
        const idx = session.menu!.categories.findIndex((c) => c !== "__ALL__" && String(c).trim().toLowerCase() === t);
        if (idx >= 0) {
          text = `MENU_CAT ${idx}`;
          upperText = text.toUpperCase().trim();
        }
      }
      if (session.menu?.step === "brands" && !upperText.startsWith("MENU_BRAND") && Array.isArray(session.menu?.brands) && session.menu!.brands.length) {
        const idx = session.menu!.brands.findIndex((b) => String(b).trim().toLowerCase() === t);
        if (idx >= 0) {
          text = `MENU_BRAND ${idx}`;
          upperText = text.toUpperCase().trim();
        }
      }
      if (session.menu?.step === "actions" && !upperText.startsWith("MENU_CAT_")) {
        if (t === "products") {
          text = "MENU_CAT_PRODUCTS";
          upperText = text.toUpperCase().trim();
        } else if (t === "brands") {
          text = "MENU_CAT_BRANDS";
          upperText = text.toUpperCase().trim();
        }
      }
    }

    const vendorCfg = await fetchVendorBotConfig(deps.vendorId);
    if (isExcludedPeer(to, (vendorCfg as any)?.whatsappExcludedPeers)) return;
    const brain = vendorCfg?.whatsappBotBrain;
    const catalogCfg = vendorCfg?.whatsappCatalogSettings;
    const storeName = (brain?.storeName ?? vendorCfg?.vendor?.name ?? "Our Store").trim() || "Our Store";
    const shopPhone = (brain?.shopPhone ?? "").trim();
    const slideCount =
      typeof (catalogCfg as any)?.itemsPerPage === "number"
        ? (catalogCfg as any).itemsPerPage
        : typeof (catalogCfg as any)?.carouselSlideCount === "number"
          ? (catalogCfg as any).carouselSlideCount
          : 10;
    const catalogCount = typeof catalogCfg?.catalogCount === "number" ? catalogCfg.catalogCount : 20;
    const allowPriceRange = typeof catalogCfg?.allowPriceRange === "boolean" ? catalogCfg.allowPriceRange : true;
    const allowCategories = typeof catalogCfg?.allowCategories === "boolean" ? catalogCfg.allowCategories : true;
    const allowRandom = typeof catalogCfg?.allowRandom === "boolean" ? catalogCfg.allowRandom : true;
    const allowPriceSort = typeof catalogCfg?.allowPriceSort === "boolean" ? catalogCfg.allowPriceSort : true;
    const allowLatest = typeof catalogCfg?.allowLatest === "boolean" ? catalogCfg.allowLatest : true;

    if (session.botPaused) {
      if (upperText === "RESUME_BOT") {
        session.botPaused = false;
        scheduleSave();
        await sendWithMenu(to, session, "Okay — I’m back. Tap Menu to browse.", storeName);
        return;
      }
      if (upperText === "SHOW_CATALOG" || upperText === "MENU") {
        session.botPaused = false;
        scheduleSave();
        text = "SHOW_CATALOG";
        upperText = "SHOW_CATALOG";
      } else {
        return;
      }
    }
    const assistantStyle =
      brain?.assistantStyle === "straightforward" || brain?.assistantStyle === "interactive" || brain?.assistantStyle === "balanced"
        ? brain.assistantStyle
        : "balanced";
    const memoryTurns = typeof brain?.memoryTurns === "number" ? brain.memoryTurns : Number(brain?.memoryTurns ?? 6);

    const now = nowMs();
    const lastProfileAt = typeof session.profileFetchedAt === "number" && Number.isFinite(session.profileFetchedAt) ? session.profileFetchedAt : 0;
    if (!lastProfileAt || now - lastProfileAt > 12 * 60 * 60_000) {
      session.profileFetchedAt = now;
      const prof = await fetchCustomerProfile(deps.vendorId, to);
      if (prof) {
        if ((!session.customerName || !session.customerName.trim()) && prof.name && !looksLikeStoreName(prof.name, storeName)) {
          session.customerName = prof.name.slice(0, 200);
        }
        if ((!session.email || !isValidEmail(session.email)) && prof.email && isValidEmail(prof.email)) {
          session.email = prof.email;
        }
        if ((!session.deliveryAddress || !session.deliveryAddress.trim()) && prof.delivery_address) {
          session.deliveryAddress = prof.delivery_address.slice(0, 255);
        }
      }
      scheduleSave();
    }

    if (upperText.startsWith("EMAIL ")) {
      const email = text.slice(6).trim();
      if (!email || !isValidEmail(email)) {
        await sendText(to, "Please provide a valid email like: EMAIL you@example.com");
        return;
      }
      session.email = email;
      scheduleSave();
      void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, email });
      await sendText(to, "✅ Email saved.");
      return;
    }

    if (upperText.startsWith("ADDRESS ")) {
      const addr = text.slice(8).trim();
      if (!addr) {
        await sendText(to, "Please provide your address like: ADDRESS Street + landmark");
        return;
      }
      session.deliveryAddress = addr.slice(0, 255);
      scheduleSave();
      void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, delivery_address: session.deliveryAddress });
      await sendText(to, "✅ Delivery address saved.");
      return;
    }

    if (upperText.startsWith("NAME ")) {
      const name = text.slice(5).trim();
      if (!name) {
        await sendText(to, "Please provide your name like: NAME John Doe");
        return;
      }
      session.customerName = name.slice(0, 200);
      scheduleSave();
      void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, name: name.slice(0, 200) });
      await sendText(to, "✅ Name saved.");
      return;
    }

    const tplVars = {
      store_name: storeName,
      storeName,
      shop_phone: shopPhone,
      shopPhone,
    };

    if (upperText === "CANCEL" || upperText === "CANCEL_CHECKOUT") {
      session.state = "chat";
      session.cart = null;
      session.deliveryMethodId = undefined;
      session.deliveryMethodName = undefined;
      session.deliveryFeeCents = undefined;
      await sendText(to, `🛑 Action cancelled. How else can ${storeName} help you today?`);
      return;
    }

    if (upperText.startsWith("PAID")) {
      const refFromText = text.replace(/^paid\s*/i, "").trim();
      const ref = refFromText || (session.lastReference ?? "").trim();
      const email = (session.email ?? "").trim();
      if (!ref) {
        await sendText(to, "Please reply with your reference like: *PAID PSK_...*");
        return;
      }
      if (!email) {
        session.state = "awaiting_email";
        await sendText(to, "Please provide your email address used for payment receipt:");
        return;
      }
      try {
        const url = `${apiBase()}/marketplace/orders/by-reference/${encodeURIComponent(ref)}/verify-payment`;
        const { ok, json } = await postJson(url, { email }, {}, 20_000);
        if (!ok) {
          const msg = typeof (json as any)?.message === "string" ? (json as any).message : "Payment verification failed.";
          await sendText(to, `❌ ${msg}`);
          return;
        }
        const status = typeof (json as any)?.order?.status === "string" ? String((json as any).order.status) : "updated";
        await sendText(to, `✅ Payment confirmed.\nStatus: ${status}\nRef: ${ref}`);
      } catch (e: unknown) {
        deps.onError(e instanceof Error ? e.message : "Payment verify failed.");
        await sendText(to, "❌ Payment verification failed. Please try again shortly.");
      }
      return;
    }

    if (session.state === "chat") {
      if (isGreeting(text)) {
        const last = typeof session.greetedAt === "number" ? session.greetedAt : 0;
        if (!last || nowMs() - last > 2 * 60 * 60_000) {
          session.greetedAt = nowMs();
          const msg =
            typeof brain?.greeting === "string" && brain.greeting.trim()
              ? applyTemplate(brain.greeting.trim(), tplVars)
              : `Hello 👋 Welcome to ${storeName}.\n\nTap Menu to browse our catalog, or tell me what you’re looking for.`;
          await sendMenuAndRemember(to, session, msg, storeName);
          scheduleSave();
          return;
        }
        const sig = "greet_nudge";
        const lastNudge = typeof session.lastNudgeAt === "number" && Number.isFinite(session.lastNudgeAt) ? session.lastNudgeAt : 0;
        if (!lastNudge || nowMs() - lastNudge > 2 * 60_000 || session.lastNudgeSig !== sig) {
          session.lastNudgeAt = nowMs();
          session.lastNudgeSig = sig;
          const nudge = `Hi 👋 What are you looking for?\n\n\nYou can ask me directly or tap Menu to browse directly.`;
          await sendMenuAndRemember(to, session, nudge, storeName);
          scheduleSave();
          return;
        }
        return;
      }
    }

    if (session.state === "awaiting_qty") {
      const raw = Number(text.trim());
      const qty = Number.isFinite(raw) ? Math.floor(raw) : NaN;
      if (!session.cart) {
        session.state = "chat";
        await sendWithMenu(to, session, "Your cart is empty. Tap Menu to browse.", storeName);
        return;
      }
      const max = maxQtyForProduct(session.cart.product);
      if (!Number.isFinite(qty) || qty < 1 || qty > max) {
        if (max <= 0) await sendWithMenu(to, session, "❌ This item is currently out of stock. Tap Menu to pick another item.", storeName);
        else await sendWithCancel(to, session, `Please enter a valid quantity between 1 and ${max}.`);
        return;
      }
      session.cart.qty = qty;
      session.deliveryMethodId = undefined;
      session.deliveryMethodName = undefined;
      session.deliveryFeeCents = undefined;
      await sendDeliveryPicker(to, session, storeName, vendorCfg?.deliveryOptions ?? null, slideCount);
      return;
    }

    if (session.state === "awaiting_name") {
      const savedName = (session.customerName ?? "").trim();
      if (upperText === "USE_NAME") {
        if (!savedName || looksLikeStoreName(savedName, storeName)) {
          await promptName(to, session, storeName);
          return;
        }
        scheduleSave();
        await sendCheckoutReview(to, session, storeName);
        return;
      }
      if (upperText === "USE_WA_NAME") {
        const waName = (session.customerPushName ?? "").trim();
        if (!waName || looksLikeStoreName(waName, storeName)) {
          await promptName(to, session, storeName);
          return;
        }
        session.customerName = waName.slice(0, 200);
        scheduleSave();
        void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, name: session.customerName });
        await sendCheckoutReview(to, session, storeName);
        return;
      }
      if (upperText === "CHANGE_NAME") {
        await sendWithCancel(to, session, "Please type your full name:");
        return;
      }
      const name = text.trim();
      if (!name) {
        await sendWithCancel(to, session, "Please type your full name:");
        return;
      }
      session.customerName = name.slice(0, 200);
      scheduleSave();
      void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, name: session.customerName });
      await sendCheckoutReview(to, session, storeName);
      return;
    }

    if (session.state === "awaiting_delivery_method") {
      const prefix = "DELIVERY ";
      if (!upperText.startsWith(prefix)) {
        await sendWithCancel(to, session, "Please select a delivery option from the menu.");
        return;
      }
      if (!(await ensureValidQtyOrPrompt(to, session))) return;
      const methodId = (text.slice(prefix.length) ?? "").trim();
      const list = vendorCfg?.deliveryOptions?.methods ?? [];
      const match = list.find((m) => String(m.id).trim() === methodId) ?? null;
      if (!match) {
        await sendText(to, "That delivery option is no longer available. Please pick another one.");
        await sendDeliveryPicker(to, session, storeName, vendorCfg?.deliveryOptions ?? null, slideCount);
        return;
      }
      session.deliveryMethodId = String(match.id);
      session.deliveryMethodName = String(match.name);
      session.deliveryFeeCents = typeof match.feeCents === "number" && Number.isFinite(match.feeCents) ? Math.max(0, Math.round(match.feeCents)) : 0;
      void upsertCustomerProfile(deps.vendorId, {
        peer: to,
        push_name: pushName,
        delivery_method_id: session.deliveryMethodId,
        delivery_method_name: session.deliveryMethodName,
      });
      const isPickup = /\bpickup\b/i.test(String(match.name));
      if (isPickup) {
        const email = (session.email ?? "").trim();
        if (email && isValidEmail(email)) {
          scheduleSave();
          await sendCheckoutReview(to, session, storeName);
        } else {
          session.state = "awaiting_email";
          scheduleSave();
          await promptEmail(to, session, storeName);
        }
        return;
      }
      session.state = "awaiting_delivery_address";
      scheduleSave();
      await promptAddress(to, session, storeName);
      return;
    }

    if (session.state === "awaiting_delivery_address") {
      const savedAddr = (session.deliveryAddress ?? "").trim();
      if (upperText === "CHANGE_ADDRESS") {
        await sendWithCancel(to, session, "Please type your delivery address (street + landmark):");
        return;
      }
      if (upperText === "USE_ADDRESS") {
        if (!savedAddr) {
          await sendWithCancel(to, session, "Please type your delivery address (street + landmark):");
          return;
        }
      } else {
        const addr = text.trim();
        if (!addr) {
          await sendWithCancel(to, session, "Please type your delivery address (street + landmark):");
          return;
        }
        session.deliveryAddress = addr.slice(0, 255);
        scheduleSave();
        void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, delivery_address: session.deliveryAddress });
      }
      if (!(await ensureValidQtyOrPrompt(to, session))) return;
      const email = (session.email ?? "").trim();
      if (email && isValidEmail(email)) {
        scheduleSave();
        await sendCheckoutReview(to, session, storeName);
      } else {
        session.state = "awaiting_email";
        scheduleSave();
        await promptEmail(to, session, storeName);
      }
      return;
    }

    if (session.state === "awaiting_email") {
      if (upperText === "CHANGE_EMAIL") {
        await sendWithCancel(to, session, "Please provide your email address for the payment receipt:");
        return;
      }
      if (upperText === "USE_EMAIL") {
        const savedEmail = (session.email ?? "").trim();
        if (!savedEmail || !isValidEmail(savedEmail)) {
          await sendWithCancel(to, session, "Please provide your email address for the payment receipt:");
          return;
        }
      } else {
        const email = text.trim();
        if (!email || !isValidEmail(email)) {
          await sendWithCancel(to, session, "❌ Invalid email. Please try again.");
          return;
        }
        session.email = email;
        scheduleSave();
        void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: pushName, email });
      }
      if (!(await ensureValidQtyOrPrompt(to, session))) return;
      await sendCheckoutReview(to, session, storeName);
      return;
    }

    if (session.state === "reviewing_checkout") {
      if (upperText === "CHANGE_NAME") {
        session.state = "awaiting_name";
        scheduleSave();
        await promptName(to, session, storeName);
        return;
      }
      if (upperText === "CHANGE_EMAIL") {
        session.state = "awaiting_email";
        scheduleSave();
        await promptEmail(to, session, storeName);
        return;
      }
      if (upperText === "CHANGE_ADDRESS") {
        session.state = "awaiting_delivery_address";
        scheduleSave();
        await promptAddress(to, session, storeName);
        return;
      }
      if (upperText === "CHECKOUT_PROCEED") {
        if (!session.cart) {
          session.state = "chat";
          scheduleSave();
          await sendWithMenu(to, session, "Your cart is empty. Tap Menu to browse.", storeName);
          return;
        }
        if (!(await ensureValidQtyOrPrompt(to, session))) return;
        const resolvedName = resolveCustomerName(session, storeName);
        if (!resolvedName) {
          session.state = "awaiting_name";
          scheduleSave();
          await promptName(to, session, storeName);
          return;
        }
        if (!(session.customerName ?? "").trim()) {
          session.customerName = resolvedName;
          scheduleSave();
          void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: session.customerPushName, name: resolvedName });
        }
        const email = (session.email ?? "").trim();
        if (!email || !isValidEmail(email)) {
          session.state = "awaiting_email";
          scheduleSave();
          await promptEmail(to, session, storeName);
          return;
        }
        const method = (session.deliveryMethodName ?? "").trim();
        const isPickup = /\bpickup\b/i.test(method);
        const addr = (session.deliveryAddress ?? "").trim();
        if (!isPickup && !addr) {
          session.state = "awaiting_delivery_address";
          scheduleSave();
          await promptAddress(to, session, storeName);
          return;
        }
        session.state = "selecting_payment_method";
        scheduleSave();
        await sendPaymentOptions(to, session.cart, {
          feeCents: typeof session.deliveryFeeCents === "number" && Number.isFinite(session.deliveryFeeCents) ? session.deliveryFeeCents : 0,
          methodName: typeof session.deliveryMethodName === "string" && session.deliveryMethodName.trim() ? session.deliveryMethodName.trim() : null,
        });
        return;
      }
      await sendWithCancel(to, session, "Please use the buttons above.");
      return;
    }

    if (upperText === "PAY_LINK") {
      if (!vendorCfg?.payments?.paystack?.configured) {
        await sendWithMenu(to, session, "Paystack payment is not available for this store right now. Please select Manual payment.", storeName);
        return;
      }
      if (
        await maybeTriggerHandoff(to, session, vendorCfg, storeName, "before_payment", {
          title: session.cart?.title ?? "",
          product_id: session.cart?.product?.id ?? null,
          qty: session.cart?.qty ?? null,
        })
      )
        return;
      if (!(await ensureValidQtyOrPrompt(to, session))) return;
      const resolvedName = resolveCustomerName(session, storeName);
      if (!resolvedName) {
        session.state = "awaiting_name";
        scheduleSave();
        await promptName(to, session, storeName);
        return;
      }
      if (!(session.customerName ?? "").trim()) {
        session.customerName = resolvedName;
        scheduleSave();
        void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: session.customerPushName, name: resolvedName });
      }
      const email = (session.email ?? "").trim();
      if (!email || !isValidEmail(email)) {
        session.state = "awaiting_email";
        scheduleSave();
        await promptEmail(to, session, storeName);
        return;
      }
      try {
        await initiateMarketplaceCheckout(to, session);
      } catch (e: unknown) {
        await sendText(to, "❌ Checkout failed. Please try again.");
        deps.onError(e instanceof Error ? e.message : "Pay link failed.");
      }
      return;
    }

    if (upperText === "PAY_DIRECT") {
      if (
        await maybeTriggerHandoff(to, session, vendorCfg, storeName, "before_payment", {
          title: session.cart?.title ?? "",
          product_id: session.cart?.product?.id ?? null,
          qty: session.cart?.qty ?? null,
        })
      )
        return;
      if (!(await ensureValidQtyOrPrompt(to, session))) return;
      const resolvedName = resolveCustomerName(session, storeName);
      if (!resolvedName) {
        session.state = "awaiting_name";
        scheduleSave();
        await promptName(to, session, storeName);
        return;
      }
      if (!(session.customerName ?? "").trim()) {
        session.customerName = resolvedName;
        scheduleSave();
        void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: session.customerPushName, name: resolvedName });
      }
      const email = (session.email ?? "").trim();
      if (!email || !isValidEmail(email)) {
        session.state = "awaiting_email";
        scheduleSave();
        await promptEmail(to, session, storeName);
        return;
      }
      session.state = "awaiting_momo_number";
      await sendText(to, "📲 Please enter your MoMo number (e.g., 054XXXXXXX):");
      return;
    }

    if (session.state === "awaiting_momo_number") {
      session.momoNumber = text.trim();
      session.state = "chat";
      await sendText(
        to,
        `🔐 *SECURITY NOTE:* Your PIN is never saved or seen by ${storeName} or any 3rd party.\n\nPlease authorize the prompt on your phone and delete the OTP message immediately after.`
      );
      try {
        if (!(await ensureValidQtyOrPrompt(to, session))) return;
        const store = await fetchStoreSlug(deps.vendorId);
        if (!store || !store.slug) throw new Error("Store not found.");
        if (!session.cart) throw new Error("Cart is empty.");
        const name = (session.customerName ?? "").trim();
        const email = (session.email ?? "").trim();
        if (!email) throw new Error("Missing email.");
        const momo = (session.momoNumber ?? "").trim();
        const body = {
          store_slug: store.slug,
          name: name || undefined,
          email,
          momo,
          provider: "mtn",
          shipping: {
            method: typeof session.deliveryMethodId === "string" && session.deliveryMethodId.trim() ? session.deliveryMethodId.trim() : undefined,
            fee_cents:
              typeof session.deliveryFeeCents === "number" && Number.isFinite(session.deliveryFeeCents) ? Math.max(0, Math.round(session.deliveryFeeCents)) : 0,
            address: typeof session.deliveryAddress === "string" && session.deliveryAddress.trim() ? session.deliveryAddress.trim() : undefined,
          },
          items: [
            {
              product_id: session.cart.product.id,
              variation_id: session.cart.variation?.id ?? undefined,
              qty: Math.max(1, session.cart.qty || 1),
            },
          ],
        };
        const url = `${apiBase()}/marketplace/checkout/momo-charge`;
        const { ok, json } = await postJson(url, body, {}, 25_000);
        if (!ok) {
          const msg = typeof (json as any)?.message === "string" ? (json as any).message : "MoMo charge failed.";
          throw new Error(msg);
        }
        const reference = typeof (json as any)?.reference === "string" ? String((json as any).reference).trim() : "";
        if (reference) session.lastReference = reference;
        const display = typeof (json as any)?.display_text === "string" ? String((json as any).display_text).trim() : "";
        await sendText(
          to,
          `✅ Payment request sent to your phone.\nRef: ${reference || "N/A"}${display ? `\n\n${display}` : ""}\n\nAfter authorization, reply: *PAID ${reference || ""}*`
        );
      } catch (e: unknown) {
        deps.onError(e instanceof Error ? e.message : "MoMo charge failed.");
        const canPaystack = Boolean(vendorCfg?.payments?.paystack?.configured);
        await sendWithMenu(
          to,
          session,
          canPaystack
            ? "❌ Direct MoMo charge failed. Please use the Paystack Link option instead (or tap Menu to browse)."
            : "❌ Direct MoMo charge failed. Please use Manual payment instead (or tap Menu to browse).",
          storeName
        );
      }
      return;
    }

    if (upperText === "PAY_MANUAL") {
      if (
        await maybeTriggerHandoff(to, session, vendorCfg, storeName, "before_payment", {
          title: session.cart?.title ?? "",
          product_id: session.cart?.product?.id ?? null,
          qty: session.cart?.qty ?? null,
        })
      )
        return;
      if (!(await ensureValidQtyOrPrompt(to, session))) return;
      const resolvedName = resolveCustomerName(session, storeName);
      if (!resolvedName) {
        session.state = "awaiting_name";
        scheduleSave();
        await promptName(to, session, storeName);
        return;
      }
      if (!(session.customerName ?? "").trim()) {
        session.customerName = resolvedName;
        scheduleSave();
        void upsertCustomerProfile(deps.vendorId, { peer: to, push_name: session.customerPushName, name: resolvedName });
      }
      const email = (session.email ?? "").trim();
      if (!email || !isValidEmail(email)) {
        session.state = "awaiting_email";
        scheduleSave();
        await promptEmail(to, session, storeName);
        return;
      }
      session.state = "chat";
      const cfg = await fetchVendorBotConfig(deps.vendorId);
      const mp = cfg?.manualPayment;
      const qty = Math.max(1, session.cart?.qty || 1);
      const subtotal = session.cart ? Math.max(0, Number.isFinite(session.cart.unitPrice) ? session.cart.unitPrice : 0) * qty : 0;
      const feeCents = typeof session.deliveryFeeCents === "number" && Number.isFinite(session.deliveryFeeCents) ? Math.max(0, Math.round(session.deliveryFeeCents)) : 0;
      const deliveryFee = feeCents / 100;
      const total = subtotal + deliveryFee;
      const method = typeof session.deliveryMethodName === "string" && session.deliveryMethodName.trim() ? session.deliveryMethodName.trim() : "";
      if (mp?.enabled && (mp.instructions ?? "").trim()) {
        const title = (mp.title ?? "Manual payment").trim() || "Manual payment";
        await sendText(
          to,
          `📌 *${title}*\n\n${mp.instructions.trim()}\n\nItem: *${session.cart?.title ?? "your item"}*\nQty: ${qty}\nTotal: ${session.cart ? formatMoney(session.cart.product.currency, total) : "N/A"}`
        );
        return;
      }
      const shopPhone = (process.env.SHOP_PHONE_NUMBER ?? "233000000000").trim() || "233000000000";
      await sendText(
        to,
        `📞 Please call our shop at *${shopPhone}* to complete your order for *${session.cart?.title ?? "your item"}*.\nQty: ${qty}\nSubtotal: ${session.cart ? formatMoney(session.cart.product.currency, subtotal) : "N/A"}\n${feeCents ? `Delivery: ${session.cart ? formatMoney(session.cart.product.currency, deliveryFee) : ""}${method ? ` (${method})` : ""}\n` : ""}Total: ${session.cart ? formatMoney(session.cart.product.currency, total) : "N/A"}`
      );
      return;
    }

    const products = await fetchProductsForVendorCached(deps.vendorId);
    const aiFallbackActive =
      typeof session.aiFallbackAt === "number" && Number.isFinite(session.aiFallbackAt) && nowMs() - session.aiFallbackAt < 30 * 60_000;

    if (upperText === "CAT_NEXT" || upperText === "NEXT") {
      session.pendingConfirm = undefined;
      const p = typeof session.lastCatalog?.page === "number" ? session.lastCatalog.page : 0;
      await sendCatalogPage(to, session, products, p + 1);
      return;
    }

    if (upperText === "CAT_PREV" || upperText === "PREV" || upperText === "PREVIOUS") {
      session.pendingConfirm = undefined;
      const p = typeof session.lastCatalog?.page === "number" ? session.lastCatalog.page : 0;
      await sendCatalogPage(to, session, products, p - 1);
      return;
    }

    if (upperText.startsWith("CAT_PAGE ")) {
      session.pendingConfirm = undefined;
      const raw = upperText.replace(/^CAT_PAGE\s+/i, "").trim();
      const n = Number(raw);
      await sendCatalogPage(to, session, products, Number.isFinite(n) ? Math.max(0, Math.floor(n) - 1) : 0);
      return;
    }

    if (aiFallbackActive && upperText === "AI_FALLBACK_BROWSE") {
      session.pendingConfirm = undefined;
      await sendAiFallbackCategories(to, session, products, catalogCount, slideCount);
      return;
    }

    if (aiFallbackActive && upperText === "AI_FALLBACK_SUPPORT") {
      session.pendingConfirm = undefined;
      if (shopPhone) {
        const digits = shopPhone.replace(/\D/g, "");
        await sendText(to, `📞 Contact support: *${shopPhone}*${digits ? `\nhttps://wa.me/${digits}` : ""}`);
      } else {
        await sendText(to, "📞 Please contact support for help placing your order.");
      }
      return;
    }

    if (aiFallbackActive && upperText.startsWith("AI_FALLBACK_CAT ")) {
      const prefix = "AI_FALLBACK_CAT ";
      const catRaw = (text.slice(prefix.length) ?? "").trim();
      session.pendingConfirm = undefined;
      if (!products.length) {
        await sendText(to, "No products are available right now. Please try again shortly.");
        return;
      }
      const chosen = catRaw || "__ALL__";
      const filtered =
        chosen === "__ALL__"
          ? products
          : products.filter((p) => (typeof p.category === "string" ? p.category.trim().toLowerCase() : "") === chosen.trim().toLowerCase());
      if (!filtered.length) {
        await sendText(to, "No products found in that category. Please pick another category.");
        await sendAiFallbackCategories(to, session, products, catalogCount, slideCount);
        return;
      }
      await sendMenuCatalog(to, session, filtered, { catalogCount, itemsPerPage: slideCount, allowRandom: false, allowLatest: true });
      return;
    }

    if (upperText === "SHOW_CATALOG" || upperText === "MENU") {
      session.pendingConfirm = undefined;
      if (!products.length) {
        await sendText(to, "No products are available right now. Please try again shortly.");
        return;
      }
      await sendMenuCategories(to, session, products, storeName);
      return;
    }

    if (upperText.startsWith("MENU_CAT ")) {
      const idx = Number(text.slice(9).trim());
      const cats = Array.isArray(session.menu?.categories) ? session.menu!.categories : [];
      if (!Number.isFinite(idx) || idx < 0 || idx >= cats.length) {
        await sendMenuCategories(to, session, products, storeName);
        return;
      }
      const chosen = cats[idx] === "__ALL__" ? null : cats[idx];
      await sendMenuCategoryActions(to, session, products, storeName, chosen);
      return;
    }

    if (upperText === "MENU_CAT_PRODUCTS") {
      await showMenuProducts(to, session, products, storeName, { catalogCount, itemsPerPage: slideCount, allowRandom, allowLatest });
      return;
    }

    if (upperText === "MENU_CAT_BRANDS") {
      await sendMenuBrands(to, session, storeName);
      return;
    }

    if (upperText === "MENU_BACK_CAT") {
      await sendMenuCategoryActions(to, session, products, storeName, session.menu?.category ?? null);
      return;
    }

    if (upperText.startsWith("MENU_BRAND ")) {
      const idx = Number(text.slice(11).trim());
      const brands = Array.isArray(session.menu?.brands) ? session.menu!.brands : [];
      if (!Number.isFinite(idx) || idx < 0 || idx >= brands.length) {
        await sendMenuBrands(to, session, storeName);
        return;
      }
      session.menu = {
        at: nowMs(),
        step: "brands",
        categories: session.menu?.categories ?? [],
        category: session.menu?.category ?? null,
        brands,
        brand: brands[idx],
      };
      scheduleSave();
      await showMenuProducts(to, session, products, storeName, { catalogCount, itemsPerPage: slideCount, allowRandom, allowLatest });
      return;
    }

    if (upperText.startsWith("VAR_PAGE ")) {
      const parts = upperText.split(/\s+/g).filter(Boolean);
      const pid = Number(parts[1] ?? "");
      const page = Number(parts[2] ?? "0");
      const product = products.find((p) => p.id === pid);
      session.pendingConfirm = undefined;
      if (product) await sendVariationPicker(to, product, page);
      else await sendWithMenu(to, session, "That product was not found. Tap Menu to browse available items.", storeName);
      return;
    }

    if (upperText.startsWith("SELECT_VARIATION ")) {
      const parts = upperText.split(/\s+/g).filter(Boolean);
      const pid = Number(parts[1] ?? "");
      const vid = Number(parts[2] ?? "");
      const product = products.find((p) => p.id === pid);
      const variation = product?.variations?.find((v) => v.id === vid) ?? null;
      session.pendingConfirm = undefined;
      if (product && variation) {
        if (
          await maybeTriggerHandoff(to, session, vendorCfg, storeName, "select_variation", {
            title: `${product.name} — ${variation.name}`,
            product_id: product.id,
            variation_id: variation.id,
          })
        )
          return;
        await sendVariationDetails(to, product, variation);
      }
      else await sendWithMenu(to, session, "That variation was not found. Tap Menu to browse available items.", storeName);
      return;
    }

    if (upperText.startsWith("BUY_VAR ")) {
      const parts = upperText.split(/\s+/g).filter(Boolean);
      const pid = Number(parts[1] ?? "");
      const vid = Number(parts[2] ?? "");
      const product = products.find((p) => p.id === pid);
      const variation = product?.variations?.find((v) => v.id === vid) ?? null;
      if (product && variation) {
        if (
          await maybeTriggerHandoff(to, session, vendorCfg, storeName, "select_product", {
            title: `${product.name} — ${variation.name}`,
            product_id: product.id,
            variation_id: variation.id,
          })
        )
          return;
        const max = maxQtyForProduct(product);
        if (max <= 0) {
          await sendWithMenu(to, session, "❌ This item is currently out of stock. Tap Menu to pick another item.", storeName);
          return;
        }
        const cart = buildCartItem(product, variation, 1);
        session.cart = cart;
        session.state = "awaiting_qty";
        session.pendingConfirm = undefined;
        await sendText(to, `🛒 *${cart.title}*\nUnit: ${formatMoney(cart.product.currency, cart.unitPrice)}\n\nPlease enter quantity (1–${max}):`);
      } else {
        await sendWithMenu(to, session, "That variation was not found. Tap Menu to browse available items.", storeName);
      }
      return;
    }

    if (upperText.startsWith("VIEW_PRODUCT ") || (upperText.includes("VIEW") && /\d/.test(upperText))) {
      const productId = upperText.replace(/\D/g, "");
      const product = products.find((p) => String(p.id) === productId);
      session.pendingConfirm = undefined;
      if (product) {
        if (
          await maybeTriggerHandoff(to, session, vendorCfg, storeName, "view_product", {
            title: product.name,
            product_id: product.id,
          })
        )
          return;
        await sendProductDetails(to, product);
      }
      else await sendWithMenu(to, session, "That product was not found. Tap Menu to browse available items.", storeName);
      return;
    }

    if (upperText.startsWith("STATUS_PRODUCT ")) {
      const productId = upperText.replace(/\D/g, "");
      const product = products.find((p) => String(p.id) === productId);
      session.pendingConfirm = undefined;
      if (product) await sendStatusForwardProduct(to, product);
      else await sendWithMenu(to, session, "That product was not found. Tap Menu to browse available items.", storeName);
      return;
    }

    if (upperText.startsWith("BUY ") || (upperText.includes("BUY") && /\d/.test(upperText))) {
      const productId = upperText.replace(/\D/g, "");
      const product = products.find((p) => String(p.id) === productId);
      if (product) {
        if (
          await maybeTriggerHandoff(to, session, vendorCfg, storeName, "select_product", {
            title: product.name,
            product_id: product.id,
          })
        )
          return;
        const max = maxQtyForProduct(product);
        if (max <= 0) {
          await sendWithMenu(to, session, "❌ This item is currently out of stock. Tap Menu to pick another item.", storeName);
          return;
        }
        const hasVars = Array.isArray(product.variations) && product.variations.length > 0;
        if (hasVars) {
          await sendVariationPicker(to, product, 0);
          return;
        }
        const cart = buildCartItem(product, null, 1);
        session.cart = cart;
        session.state = "awaiting_qty";
        session.pendingConfirm = undefined;
        await sendText(to, `🛒 *${cart.title}*\nUnit: ${formatMoney(cart.product.currency, cart.unitPrice)}\n\nPlease enter quantity (1–${max}):`);
      } else {
        await sendWithMenu(to, session, "That product was not found. Tap Menu to browse available items.", storeName);
      }
      return;
    }

    session.pendingConfirm = undefined;
    session.pendingShopText = undefined;
    const storeFactsParts: string[] = [];
    const wa = dmUrlForPeer(shopPhone);
    if (shopPhone) storeFactsParts.push(`Shop phone: ${shopPhone}${wa ? ` (${wa})` : ""}`);
    const d = vendorCfg?.deliveryOptions ?? null;
    if (d) {
      const notes = typeof d.notes === "string" ? d.notes.trim() : "";
      if (notes) storeFactsParts.push(`Delivery notes: ${notes.slice(0, 500)}`);
      const methods = Array.isArray(d.methods) ? d.methods : [];
      if (methods.length) {
        const cur = typeof d.currency === "string" && d.currency.trim() ? d.currency.trim() : "GHS";
        const lines = methods.slice(0, 6).map((m) => {
          const fee = typeof m.feeCents === "number" && Number.isFinite(m.feeCents) ? Math.max(0, Math.round(m.feeCents)) : 0;
          const eta = typeof m.eta === "string" ? m.eta.trim() : "";
          const areas = Array.isArray(m.areas) ? m.areas.filter((a) => typeof a === "string" && a.trim()).slice(0, 6).join(", ") : "";
          return `${m.name}${fee ? ` (${formatMoney(cur, fee / 100)})` : ""}${eta ? ` • ETA: ${eta}` : ""}${areas ? ` • Areas: ${areas}` : ""}`;
        });
        storeFactsParts.push(`Delivery methods:\n- ${lines.join("\n- ")}`);
      }
    }
    const mp = vendorCfg?.manualPayment ?? null;
    if (mp?.enabled) {
      const t = typeof mp.title === "string" ? mp.title.trim() : "Manual payment";
      const instr = typeof mp.instructions === "string" ? mp.instructions.trim() : "";
      storeFactsParts.push(`Manual payment: ${t}${instr ? ` — ${instr.slice(0, 500)}` : ""}`);
    }
    const storeFacts = storeFactsParts.join("\n").trim();
    await runAgenticTurn({
      to,
      session,
      input: text,
      products,
      storeName,
      shopPhone,
      storeFacts,
      slideCount,
      memoryTurns,
      assistantStyle,
      extraNotes: (brain?.extraNotes ?? "").trim(),
    });
    return;
  }

  return { handleDm };
}
