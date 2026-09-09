// Single-password gate, built on node:crypto so it adds no dependencies.
//
// Deliberately simple, but not naive: the password is never stored or compared
// in plaintext, the session cookie is HMAC-signed and expiring rather than a
// "loggedIn=true" flag anyone could forge, and login attempts are rate limited
// so a public URL cannot be brute forced.
import crypto from 'node:crypto';

const COOKIE = 'ml_session';
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

export function authEnabled() {
  return Boolean(process.env.APP_PASSWORD);
}

// Signing key derived from the password, so changing the password
// automatically invalidates every existing session.
function secret() {
  return crypto.createHash('sha256').update(`market-lens:${process.env.APP_PASSWORD}`).digest();
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function makeToken() {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  return `${expires}.${sign(String(expires))}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.indexOf('.');
  if (idx < 1) return false;
  const expires = token.slice(0, idx);
  const provided = token.slice(idx + 1);
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;

  const expected = sign(expires);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Hash both sides to a fixed length before comparing, so timingSafeEqual never
// throws on a length mismatch and the comparison leaks nothing.
function passwordMatches(candidate) {
  const h = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return crypto.timingSafeEqual(h(candidate), h(process.env.APP_PASSWORD));
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Behind a tunnel or a host's proxy the socket is plain HTTP even though the
// browser is on HTTPS, so trust the forwarded header for the Secure flag.
function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

const attempts = new Map();

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + ATTEMPT_WINDOW_MS });
  } else {
    rec.count++;
  }
}

export function installAuth(app, { loginPage }) {
  if (!authEnabled()) return;

  // Required so req.ip and the Secure flag are correct behind a proxy/tunnel.
  app.set('trust proxy', 1);

  app.get('/login', (req, res) => {
    if (verifyToken(parseCookies(req.headers.cookie)[COOKIE])) return res.redirect('/');
    res.type('html').send(loginPage());
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    }
    if (!passwordMatches(req.body?.password)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    attempts.delete(ip);
    res.cookie(COOKIE, makeToken(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(req),
      maxAge: SESSION_DAYS * 86_400_000,
      path: '/',
    });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Everything registered after this point requires a valid session.
  app.use((req, res, next) => {
    if (verifyToken(parseCookies(req.headers.cookie)[COOKIE])) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    res.redirect('/login');
  });
}

export function loginPageHtml(error = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Market Lens</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0b0e14; color:#e4e8f0; font:14px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif; }
  .box { width:min(360px,90vw); background:#121722; border:1px solid #232b3a; border-radius:10px; padding:26px; }
  .brand { display:flex; align-items:center; gap:11px; margin-bottom:20px; }
  .mark { width:30px; height:30px; border-radius:8px;
    background:conic-gradient(from 210deg,#5aa9ff,#2fbf83,#e0a458,#5aa9ff); }
  h1 { margin:0; font-size:17px; font-weight:600; }
  p.sub { margin:2px 0 0; font-size:12px; color:#8792a8; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.7px; color:#8792a8; margin-bottom:6px; }
  input { width:100%; background:#171d2a; border:1px solid #232b3a; color:#e4e8f0;
    padding:10px 12px; border-radius:8px; font-size:14px; font-family:inherit; outline:none; }
  input:focus { border-color:#5aa9ff; }
  button { width:100%; margin-top:14px; background:#5aa9ff; border:1px solid #5aa9ff; color:#04101f;
    padding:10px; border-radius:8px; font-size:14px; font-weight:600; font-family:inherit; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  .err { margin-top:12px; font-size:12.5px; color:#f0655d; min-height:17px; }
</style></head>
<body>
  <form class="box" id="f">
    <div class="brand"><span class="mark"></span>
      <div><h1>Market Lens</h1><p class="sub">Enter the password to continue</p></div></div>
    <label for="p">Password</label>
    <input id="p" type="password" autocomplete="current-password" autofocus />
    <button id="b" type="submit">Unlock</button>
    <div class="err" id="e">${error}</div>
  </form>
<script>
  const f=document.getElementById('f'),p=document.getElementById('p'),b=document.getElementById('b'),e=document.getElementById('e');
  // Submit explicitly on Enter rather than relying on implicit form
  // submission, which does not fire consistently across browsers here.
  p.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); f.requestSubmit ? f.requestSubmit() : b.click(); }
  });
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    b.disabled=true; e.textContent='';
    try{
      const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})});
      const d=await r.json();
      if(!r.ok) throw new Error(d.error||'Login failed');
      location.href='/';
    }catch(err){ e.textContent=err.message; p.value=''; p.focus(); }
    finally{ b.disabled=false; }
  });
</script>
</body></html>`;
}
