// server.js
import express from "express";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import fetch from "node-fetch"; // Node 16’da gerekli olabilir
import https from "https";
import { testConfig, realConfig } from "./config.js";


const test = true;
const app = express();
app.use(express.json());
app.use(cookieParser());

const config = test ? testConfig : realConfig;
const PORT = 5570;

// Sadece TEST ortamında TLS doğrulamasını kapat (prod'da ASLA!)
const agent = new https.Agent({ rejectUnauthorized: false });

// ------------------------------------------------------------------
// 1) OAuth state store (eşzamanlı akışlar için izolasyon)
// ------------------------------------------------------------------
const STATE_TTL_MS = 5 * 60 * 1000; // 5 dk
const stateStore = new Map(); // key: state, value: { token, dosyaNo, createdAt, expiresAt }

function randomState() {
  return crypto.randomBytes(16).toString("hex");
}
function putState(state, data, ttlMs = STATE_TTL_MS) {
  const now = Date.now();
  stateStore.set(state, { ...data, createdAt: now, expiresAt: now + ttlMs });
}
function getState(state) {
  const item = stateStore.get(state);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    stateStore.delete(state);
    return null;
  }
  return item;
}
function deleteState(state) {
  stateStore.delete(state);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore.entries()) {
    if (v.expiresAt <= now) stateStore.delete(k);
  }
}, 30 * 1000);

// ------------------------------------------------------------------
// 2) API Listesi -> GraphQL endpoint + client_domain (dinamik, cache’li)
// ------------------------------------------------------------------

const CONFIG_GRAPHQL_ENDPOINT =
  process.env.CONFIG_GRAPHQL_ENDPOINT || "https://common-api.ronesis.com/graphql";

const GET_API_LIST = `
  query Query($accessKey: String!, $mobilApp: Boolean, $formatStatus: Boolean) {
    common_GetApiList(access_key: $accessKey, mobil_app: $mobilApp, format_status: $formatStatus)
  }
`;

const ACCESS_KEY = process.env.RNS_ACCESS_KEY || "Ronesans09!!**";

// Cache
const API_LIST_TTL_MS = 2 * 60 * 1000; // 2 dk
let apiListCache = {
  updatedAt: 0,
  // dosyaNo -> { graphqlEndpoint: string, projectUrl: string | null }
  map: new Map(),
};
let inFlightApiListPromise = null;


const DEFAULT_REDIRECT_URL = process.env.DEFAULT_REDIRECT_URL || "/";
const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

function isAllowedRedirect(urlStr) {
  if (ALLOWED_REDIRECT_HOSTS.length === 0) return true; // liste tanımlı değil -> izin ver
  try {
    const u = new URL(urlStr);
    return ALLOWED_REDIRECT_HOSTS.includes(u.hostname);
  } catch {
    // Göreli path ise host yok; göreli path'lara izin veriyoruz.
    return true;
  }
}

function buildRedirectUrl(rawTarget, extraParams = {}) {
  try {
    const u = new URL(rawTarget);
    for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    const qs = new URLSearchParams(extraParams).toString();
    if (!qs) return rawTarget;
    return rawTarget.includes("?") ? `${rawTarget}&${qs}` : `${rawTarget}?${qs}`;
  }
}

// Gelen JSON’ı şemana uyarlayarak Map’e dönüştür
function mapApiListToMap(list) {
  const m = new Map();
  for (const item of list || []) {
    const dosyaNo =
      item?.dosyaNo ?? item?.dosya_no ?? item?.fileNo ?? item?.file_no ?? null;

    const graphqlEndpoint =
      item?.graphql_url ??
      item?.graphqlUrl ??
      item?.api_url_gql ??
      item?.url ??
      item?.endpoint ??
      (item?.graphql && item?.graphql.endpoint) ??
      null;

    const projectUrl =
      item?.client_domain ??
      item?.projectUrl ??
      item?.frontend_url ??
      item?.panel_url ??
      item?.portal_url ??
      null;

    if (dosyaNo && graphqlEndpoint) {
      m.set(String(dosyaNo), {
        graphqlEndpoint: String(graphqlEndpoint),
        projectUrl: projectUrl ? String(projectUrl) : null,
      });
    }
  }
  return m;
}

async function fetchApiList() {
  const resp = await fetch(CONFIG_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: GET_API_LIST,
      variables: {
        accessKey: ACCESS_KEY,
      },
    }),
    agent, // test ortamı için
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `common_GetApiList HTTP ${resp.status} - ${JSON.stringify(json?.errors || json)}`
    );
  }

  let list = json?.data?.common_GetApiList;

  if (!Array.isArray(list)) {
    try {
      const parsed = JSON.parse(list);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      throw new Error(`common_GetApiList beklenen tipte değil: ${typeof list}`);
    }
  }

  // if (test) {
  list.push({
    dosya_no: 7081,
    api_url: "https://fead0a94519f.ngrok-free.app",
    api_url_gql: "https://fead0a94519f.ngrok-free.app/graphql",
    client_domain: "https://demo.ronesis.com",
    topic: null,
  });
  // }

  return mapApiListToMap(list);
}

async function refreshApiList(force = false) {
  const now = Date.now();
  if (!force && now - apiListCache.updatedAt < API_LIST_TTL_MS && apiListCache.map.size > 0) {
    return apiListCache.map;
  }
  if (inFlightApiListPromise) {
    // Aynı anda birden fazla fetch'i önle
    return inFlightApiListPromise;
  }
  inFlightApiListPromise = (async () => {
    try {
      const map = await fetchApiList();
      apiListCache = { updatedAt: Date.now(), map };
      return map;
    } finally {
      inFlightApiListPromise = null;
    }
  })();
  return inFlightApiListPromise;
}

async function resolveApiInfo(dosyaNo) {
  if (!dosyaNo) {
    return {
      graphqlEndpoint: "https://demo-api.ronesis.com/graphql",
      projectUrl: null,
    };
  }
  const now = Date.now();
  if (now - apiListCache.updatedAt > API_LIST_TTL_MS || apiListCache.map.size === 0) {
    try {
      await refreshApiList();
    } catch (e) {
      console.error("API listesi yenileme başarısız, eski cache kullanılacak:", e.message);
    }
  }
  return (
    apiListCache.map.get(String(dosyaNo)) ?? {
      graphqlEndpoint: "https://demo-api.ronesis.com/graphql",
      projectUrl: null,
    }
  );
}

// (Opsiyonel) düzenli arka plan tazeleme
setInterval(() => {
  refreshApiList().catch((e) =>
    console.error("API listesi arka plan güncelleme hatası:", e.message)
  );
}, API_LIST_TTL_MS);

// ------------------------------------------------------------------
// 3) OAuth Akışı
// ------------------------------------------------------------------

// ---- 3.1) Login başlat ----
app.get("/kep/login", async (req, res) => {
  try {
    const { token, dosyaNo } = req.query;
    if (!token || !dosyaNo) {
      return res.status(400).json({ message: "token ve dosyaNo zorunludur" });
    }

    const state = randomState();
    putState(state, { token, dosyaNo });

    res.cookie("oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: STATE_TTL_MS,
    });

    const authUrl = new URL(config.EDM_AUTH_ENDPOINT);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.EDM_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", config.OAUTH_REDIRECT_URL);
    authUrl.searchParams.set("state", state);

    return res.redirect(authUrl.href);
  } catch (err) {
    console.error("OAuth yönlendirme hatası:", err);
    return res.status(500).send("OAuth sayfası alınamadı.");
  }
});

// ---- 3.2) OAuth callback ----
app.get("/panel/edm-kep", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ message: "code ve state zorunludur" });
    }

    const cookieState = req.cookies?.oauth_state;
    if (!cookieState || cookieState !== state) {
      return res.status(400).json({ message: "Geçersiz veya uyumsuz state" });
    }

    const ctx = getState(state);
    if (!ctx) {
      return res.status(400).json({ message: "State bulunamadı ya da süresi doldu" });
    }

    const { token, dosyaNo } = ctx;
    const { graphqlEndpoint, projectUrl } = await resolveApiInfo(dosyaNo);

    const query = `
      query Rns_Edm_Mail_Kep_Giris($code: String!) {
        rns_Edm_Mail_Kep_Giris(code: $code) {
          message
        }
      }
    `;
    const variables = { code };
    console.log("graphqlEndpoint", graphqlEndpoint)
    const response = await fetch(graphqlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "permission-bypass-key": "Ronesans09!!",
      },
      body: JSON.stringify({ query, variables }),
      agent, // test ortamı için
    });

    const data = await response.json();

    // State ve cookie'yi her durumda temizle
    deleteState(state);
    res.clearCookie("oauth_state");

    if (response.ok) {
      // Başarılıysa client_domain'e yönlendir
      const fallback = DEFAULT_REDIRECT_URL;
      const preferred = projectUrl && isAllowedRedirect(projectUrl) ? projectUrl : fallback;

      // İsteğe bağlı: sonuca dair bir işaret koy
      const target = buildRedirectUrl(preferred + '/panel/edm-mail-management', { kep_login: "success" });

      return res.redirect(302, target);
    }

    // Başarısızsa JSON hata döndür
    return res.status(400).json(data);
  } catch (err) {
    console.error("Callback hata:", err);
    return res.status(500).json({ message: "Callback işlenemedi" });
  }
});

// ------------------------------------------------------------------
// 4) Yardımcı endpoint'ler
// ------------------------------------------------------------------

// Debug: cache görünüm
app.get("/_api-list", (req, res) => {
  res.json({
    updatedAt: new Date(apiListCache.updatedAt).toISOString(),
    size: apiListCache.map.size,
    entries: Array.from(apiListCache.map.entries()).map(([k, v]) => ({
      dosyaNo: k,
      graphqlEndpoint: v.graphqlEndpoint,
      projectUrl: v.projectUrl,
    })),
  });
});

// Basit healthcheck
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// ------------------------------------------------------------------
// 5) Sunucu başlat
// ------------------------------------------------------------------
app.listen(PORT, async () => {
  try {
    await refreshApiList(true); // başlangıçta bir kere çek
    console.log("✅ API listesi başlangıçta yüklendi");
  } catch (e) {
    console.warn("⚠️ API listesi başlangıç yüklenemedi:", e.message);
  }
  console.log(`🚀 Server http://localhost:${5570} üzerinde çalışıyor`);
});