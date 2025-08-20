import express from "express";

const app = express();
const PORT = 3000;
const ALLOWED_ORIGINS = "https://panel.sizin-domain.com,https://admin.baska-domain.com"
const EDM_AUTH_ENDPOINT = "https://edm-kep.com.tr/Portal/oauth/authorize"
const EDM_CLIENT_ID = "4d13f7a339c148b29a848e9128a0610d"
const clientSecret = "j5byyohwbza3lr0xdutn6hru95kcjpkz6ye2cy2pgzowao3681"
const serverUri = "https://test.edm-kep.com.tr/Portal"
const OAUTH_REDIRECT_URL = "http://localhost:4200/panel/edm-kep/hesaplar/test"


// CONFIG={
//   serverUri: "https://test.edm-kep.com.tr/Portal",
//   clientId: "4d13f7a339c148b29a848e9128a0610d",
//   clientSecret: "j5byyohwbza3lr0xdutn6hru95kcjpkz6ye2cy2pgzowao3681",
//   redirectUri: `${env.PROJECT_BASE_URL}/panel/edm-kep/hesaplar/test`,

app.use(express.json());

// Basit GET
app.get("/", (req, res) => {
  res.json({ message: "API çalışıyor 🚀" });
});

app.get('/kep/login', (req, res) => {
  try {
    const { returnTo } = req.query;
    console.log("returnTo", returnTo)
    if (!returnTo) return res.status(400).send('returnTo zorunlu');

    const r = new URL(returnTo);
    if (!ALLOWED_ORIGINS.includes(r.origin)) {
      return res.status(400).send('Origin izinli değil');
    }
    const state = randomState();
    putState(state, { returnTo: r.origin });

    const authUrl = new URL(EDM_AUTH_ENDPOINT);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', EDM_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URL);
    authUrl.searchParams.set('state', state);

    // Not: PKCE gerekiyorsa burada code_challenge ekleyin.
    // Basit senaryo: sadece state ile ilerliyoruz.

    return res.redirect(authUrl.toString());
  } catch (e) {
    console.error(e);
    return res.status(500).send('Login başlatılamadı');
  }
});

// Server start
app.listen(PORT, () => {
  console.log(`🚀 Server http://localhost:${PORT} üzerinde çalışıyor`);
});
