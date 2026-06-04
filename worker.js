// ════════════════════════════════════════════════════════════════════════════
//  SECURE DELIVERY WORKER  —  Cloudflare Worker
//
//  Turns a successful Stripe payment into a short-lived, signed download link.
//  Nothing here is linked publicly: the file lives in a PRIVATE R2 bucket and
//  is only ever served behind a token that (a) we cryptographically signed and
//  (b) expires. A buyer can't guess a link, and a shared link dies on its own.
//
//  Routes
//    POST /issue          { paymentIntentId, email, product }  → { url, expiresAt, kind }
//                         Re-checks the payment with Stripe, then mints a token.
//    POST /free-download  { email, product }  → { url, expiresAt, kind }
//                         FREE template: records the email (no inbox gating) and
//                         mints a token. Only products flagged `free:true` qualify.
//    GET  /download?token=…   verifies the token → streams the file from R2.
//    GET  /watch?token=…      verifies the token → gated video player page.
//    POST /stripe-webhook     Stripe calls this on payment_intent.succeeded →
//                             mints a link and emails it (backup delivery).
//    POST /resend         { paymentIntentId, email, product }  → re-emails a fresh link.
//
//  Secrets (set with `wrangler secret put NAME`):
//    TOKEN_SIGNING_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//    BREVO_API_KEY (optional), BREVO_FULFILLMENT_TEMPLATE_ID (optional)
//  Vars (wrangler.toml): ALLOWED_ORIGIN, TOKEN_TTL_MINUTES, SENDER_NAME, SENDER_EMAIL
//  Bindings: ASSETS (R2 bucket)
// ════════════════════════════════════════════════════════════════════════════

// ── YOUR PRODUCTS ────────────────────────────────────────────────────────────
// Map each product id (matches PRODUCT_META.id in app.jsx) to what it delivers.
//   type 'file'  → served from R2. `key` is the object key in your bucket,
//                  `filename` is what the buyer's browser saves it as.
//   type 'video' → a gated player. `embed` is an unlisted / domain-restricted
//                  embed URL (Cloudflare Stream, Vimeo private, YouTube unlisted).
//                  The raw video file is never exposed — only this page, behind
//                  a valid token. (To go further, swap `embed` for a Cloudflare
//                  Stream *signed* URL minted per request — see README.)
//   free: true   → ALSO claimable via POST /free-download with no payment (the
//                  FREE template). Add it to your freebie only. Leave it OFF on
//                  paid products so they can never be downloaded for free.
//
// FREE TEMPLATE — NO CODE EDIT: instead of adding a free entry here, just set the
// FREE_PRODUCT_KEY / FREE_PRODUCT_FILENAME / FREE_PRODUCT_NAME vars (in the Deploy
// form, or wrangler.toml). When FREE_PRODUCT_KEY is set, /free-download serves it
// under the reserved id "free" — so a non-technical buyer never touches this file.
const PRODUCTS = {
  product:    { type: 'file',  key: 'wellness-yoga-journey.zip', filename: 'Wellness-Yoga-Journey.zip', name: 'Wellness Yoga Journey' },
  extraText:  { type: 'file',  key: 'wellness-yoga-journey.zip', filename: 'Wellness-Yoga-Journey.zip', name: 'Wellness Yoga Journey' },
  newsletter: { type: 'file',  key: 'advanced-yoga-ebook.pdf',   filename: 'Advanced-Yoga-Newsletter.pdf', name: 'Advanced Yoga Newsletter' },
  content:    { type: 'video', embed: 'https://customer-xxxx.cloudflarestream.com/VIDEO_UID/iframe', name: '10 Hours Breathwork with Yoga' },
  // ── FREE template (advanced) — or just use the FREE_PRODUCT_* vars, no edit ──
  // freebie:    { type: 'file',  key: 'free-checklist.pdf', filename: 'Free-Checklist.pdf', name: 'Free Checklist', free: true },
};

// Reserved product id for the env-var-configured freebie (the no-code FREE path).
const FREE_ID = 'free';

// Build the FREE template's single freebie from env vars, if configured. The buyer
// sets these in the Deploy form and never edits PRODUCTS above.
function getFreeProduct(env) {
  if (!env.FREE_PRODUCT_KEY) return null;
  return {
    type: 'file',
    key: env.FREE_PRODUCT_KEY,
    filename: env.FREE_PRODUCT_FILENAME || env.FREE_PRODUCT_KEY,
    name: env.FREE_PRODUCT_NAME || 'Free download',
    free: true,
  };
}

// Resolve a product id → its config: the env-var freebie for FREE_ID, else the
// PRODUCTS map. Shared by /download and /watch so both paths use one lookup.
function resolveProduct(id, env) {
  if (id === FREE_ID) return getFreeProduct(env);
  return PRODUCTS[id] || null;
}

// ── HTTP entry ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));

    try {
      if (request.method === 'POST' && pathname === '/issue')          return cors(env, await handleIssue(request, env));
      if (request.method === 'POST' && pathname === '/free-download')   return cors(env, await handleFreeDownload(request, env));
      if (request.method === 'GET'  && pathname === '/download')       return await handleDownload(url, env);
      if (request.method === 'GET'  && pathname === '/watch')          return await handleWatch(url, env);
      if (request.method === 'POST' && pathname === '/stripe-webhook') return await handleWebhook(request, env);
      if (request.method === 'POST' && pathname === '/resend')         return cors(env, await handleResend(request, env));
      if (pathname === '/' || pathname === '/health')                  return cors(env, json({ ok: true, service: 'delivery' }));
    } catch (err) {
      return cors(env, json({ error: 'server_error', detail: String(err && err.message || err) }, 500));
    }
    return cors(env, json({ error: 'not_found' }, 404));
  },
};

// ── /issue ── verify payment, mint a token, return the link ──────────────────
async function handleIssue(request, env) {
  const body = await request.json().catch(() => ({}));
  const { paymentIntentId, email, product } = body || {};

  const prod = PRODUCTS[product];
  if (!prod) return json({ error: 'unknown_product' }, 400);

  // Re-check the payment with Stripe — a buyer cannot forge a "succeeded"
  // PaymentIntent, so this is what authorizes the download.
  const ok = await verifyPayment(paymentIntentId, env);
  if (!ok) return json({ error: 'payment_not_verified' }, 402);

  const ttlMin = parseInt(env.TOKEN_TTL_MINUTES || '1440', 10);
  const exp = Math.floor(Date.now() / 1000) + ttlMin * 60;
  const token = await signToken({ p: product, pi: paymentIntentId || '', exp }, env);

  const origin = new URL(request.url).origin;
  const path = prod.type === 'video' ? '/watch' : '/download';
  return json({
    url: `${origin}${path}?token=${token}`,
    expiresAt: exp * 1000,
    kind: prod.type === 'video' ? 'watch' : 'download',
  });
}

// ── /free-download ── FREE template: capture email, mint a link (no payment) ──
// The visitor enters an email and gets the file immediately. The download is NOT
// gated behind their inbox — a fake email still downloads. That trade-off is the
// point: no email-send limits, free to ~100k/day. Only products flagged
// `free:true` are served here, so this route can never leak a paid product.
async function handleFreeDownload(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String((body && body.email) || '').trim();
  const product = body && body.product;

  // Require a syntactically valid email so the field can't be left blank. We do
  // NOT (and cannot) verify it's a real inbox — see the note above.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email' }, 400);

  // Prefer the no-code env-var freebie; fall back to a PRODUCTS entry flagged free.
  const envFree = getFreeProduct(env);
  const id = envFree ? FREE_ID : product;
  const prod = envFree || PRODUCTS[product];
  if (!prod || prod.free !== true) return json({ error: 'unknown_product' }, 400);

  // Record the lead — best-effort, never blocks the download.
  await captureLead({ email, product: id }, env);

  const ttlMin = parseInt(env.TOKEN_TTL_MINUTES || '1440', 10);
  const exp = Math.floor(Date.now() / 1000) + ttlMin * 60;
  const token = await signToken({ p: id, free: 1, exp }, env);
  const origin = new URL(request.url).origin;
  const path = prod.type === 'video' ? '/watch' : '/download';
  return json({
    url: `${origin}${path}?token=${token}`,
    expiresAt: exp * 1000,
    kind: prod.type === 'video' ? 'watch' : 'download',
  });
}

// ── Best-effort lead capture — optional KV log + optional ESP contact ────────
// Both are optional and independent. If neither is configured the email is simply
// not stored (the download still works). Adding a Brevo CONTACT does not send an
// email, so it never touches Brevo's daily send limit.
async function captureLead({ email, product }, env) {
  // 1) Store in a KV namespace if one is bound as `LEADS` (export from dashboard).
  try {
    if (env.LEADS && typeof env.LEADS.put === 'function') {
      const ts = new Date().toISOString();
      await env.LEADS.put(`${ts}__${email}`, JSON.stringify({ email, product, ts }));
    }
  } catch (e) {/* ignore — capture must never break delivery */}

  // 2) Add the contact to Brevo (no email sent → safe against send limits). Set
  //    BREVO_API_KEY, and optionally BREVO_LIST_ID to drop them onto a list.
  try {
    if (env.BREVO_API_KEY) {
      const payload = { email, updateEnabled: true };
      if (env.BREVO_LIST_ID) payload.listIds = [parseInt(env.BREVO_LIST_ID, 10)];
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  } catch (e) {/* ignore */}
}

// ── /download ── verify token, stream the file from R2 ───────────────────────
async function handleDownload(url, env) {
  const token = url.searchParams.get('token') || '';
  const claims = await verifyToken(token, env);
  if (!claims) return htmlMessage('This link is invalid or has expired.', 'Ask for a fresh link from your Thank-you page or email.', 403);

  const prod = resolveProduct(claims.p, env);
  if (!prod || prod.type !== 'file') return htmlMessage('Product not found.', '', 404);

  const obj = await env.ASSETS.get(prod.key);
  if (!obj) return htmlMessage('File is being prepared.', 'Please contact the seller — the file is not in storage yet.', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${prod.filename || prod.key}"`);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(obj.body, { headers });
}

// ── /watch ── verify token, return a gated player page ───────────────────────
async function handleWatch(url, env) {
  const token = url.searchParams.get('token') || '';
  const claims = await verifyToken(token, env);
  if (!claims) return htmlMessage('This link is invalid or has expired.', 'Ask for a fresh link from your Thank-you page or email.', 403);

  const prod = resolveProduct(claims.p, env);
  if (!prod || prod.type !== 'video') return htmlMessage('Video not found.', '', 404);

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(prod.name)}</title>
<style>html,body{margin:0;height:100%;background:#0b0b0b;font-family:Inter,system-ui,sans-serif}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box}
h1{color:#fff;font-size:18px;font-weight:600;margin:0;letter-spacing:-.02em}
.frame{width:min(100%,1100px);aspect-ratio:16/9;border-radius:16px;overflow:hidden;background:#000;box-shadow:0 30px 80px -30px rgba(0,0,0,.7)}
iframe{width:100%;height:100%;border:0}
small{color:#8b8b8b;font-size:13px}</style></head>
<body><div class="wrap"><h1>${esc(prod.name)}</h1>
<div class="frame"><iframe src="${esc(prod.embed)}" allow="accelerometer;gyroscope;autoplay;encrypted-media;picture-in-picture" allowfullscreen></iframe></div>
<small>Your private access link — please don't share it.</small></div></body></html>`;
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' } });
}

// ── /stripe-webhook ── mint + email on payment_intent.succeeded ──────────────
async function handleWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get('Stripe-Signature') || '';
  const valid = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'bad_signature' }, 400);

  const event = JSON.parse(payload);
  if (event.type !== 'payment_intent.succeeded') return json({ received: true });

  const pi = event.data.object;
  const email = pi.receipt_email || (pi.charges && pi.charges.data[0] && pi.charges.data[0].billing_details.email);
  // The product id should be set as PaymentIntent metadata at create time
  // (add `metadata[product]` in api/create-payment-intent.js). Falls back to a
  // single-product store if you only sell one thing.
  const product = (pi.metadata && pi.metadata.product) || Object.keys(PRODUCTS)[0];
  await emailLink({ product, email, paymentIntentId: pi.id }, env, request);
  return json({ received: true });
}

// ── /resend ── mint a fresh link and email it again ──────────────────────────
async function handleResend(request, env) {
  const { paymentIntentId, email, product } = (await request.json().catch(() => ({}))) || {};
  if (!PRODUCTS[product]) return json({ error: 'unknown_product' }, 400);
  const ok = await verifyPayment(paymentIntentId, env);
  if (!ok) return json({ error: 'payment_not_verified' }, 402);
  await emailLink({ product, email, paymentIntentId }, env, request);
  return json({ sent: true });
}

// ── Shared: build a link + send it via Brevo ─────────────────────────────────
async function emailLink({ product, email, paymentIntentId }, env, request) {
  const prod = PRODUCTS[product];
  if (!prod || !email) return;
  const ttlMin = parseInt(env.TOKEN_TTL_MINUTES || '1440', 10);
  const exp = Math.floor(Date.now() / 1000) + ttlMin * 60;
  const token = await signToken({ p: product, pi: paymentIntentId || '', exp }, env);
  const origin = new URL(request.url).origin;
  const link = `${origin}${prod.type === 'video' ? '/watch' : '/download'}?token=${token}`;

  if (!env.BREVO_API_KEY) return; // email is optional — link still works on the Thank-you page
  const verb = prod.type === 'video' ? 'Watch' : 'Download';
  const payload = {
    sender: { name: env.SENDER_NAME || 'Store', email: env.SENDER_EMAIL || 'no-reply@example.com' },
    to: [{ email }],
    subject: `Your ${prod.name} is ready`,
    htmlContent: `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#101010">Thank you!</h2>
      <p style="color:#444;line-height:1.6">Your <strong>${esc(prod.name)}</strong> is ready.</p>
      <p><a href="${link}" style="display:inline-block;background:#101010;color:#fff;text-decoration:none;padding:14px 28px;border-radius:40px;font-weight:600">${verb} now</a></p>
      <p style="color:#999;font-size:13px">This link is private to you and expires in ${Math.round(ttlMin / 60)} hours. Need a new one? Just reply.</p>
    </div>`,
  };
  // If you built a Brevo TEMPLATE for this, use it instead of htmlContent:
  if (env.BREVO_FULFILLMENT_TEMPLATE_ID) {
    payload.templateId = parseInt(env.BREVO_FULFILLMENT_TEMPLATE_ID, 10);
    payload.params = { product_name: prod.name, download_link: link, verb };
    delete payload.htmlContent;
  }
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// ── Stripe: confirm a PaymentIntent really succeeded ─────────────────────────
async function verifyPayment(paymentIntentId, env) {
  if (!paymentIntentId || !env.STRIPE_SECRET_KEY) return false;
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return false;
  const r = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!r.ok) return false;
  const pi = await r.json();
  return pi && pi.status === 'succeeded';
}

// ── Token: stateless, HMAC-SHA256 signed  (payload.signature) ────────────────
async function signToken(claims, env) {
  const body = b64urlEncode(JSON.stringify(claims));
  const sig = await hmac(body, env.TOKEN_SIGNING_SECRET);
  return `${body}.${sig}`;
}

async function verifyToken(token, env) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const expected = await hmac(body, env.TOKEN_SIGNING_SECRET);
  if (!timingSafeEqual(sig, expected)) return null;
  let claims;
  try { claims = JSON.parse(b64urlDecode(body)); } catch { return null; }
  if (!claims || !claims.exp || Math.floor(Date.now() / 1000) > claims.exp) return null;
  return claims;
}

// ── Stripe webhook signature (t=…,v1=…) ──────────────────────────────────────
async function verifyStripeSignature(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  const expected = await hmac(`${parts.t}.${payload}`, secret);
  // Tolerate Stripe's 5-minute replay window.
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  return timingSafeEqual(parts.v1, expected);
}

// ── Crypto + encoding helpers ────────────────────────────────────────────────
async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(str)));
}

// ── Response helpers ─────────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'content-type');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}
function htmlMessage(title, sub, status = 200) {
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font-family:Inter,system-ui,sans-serif;max-width:440px;margin:18vh auto;text-align:center;color:#101010;padding:24px">
  <div style="font-size:22px;font-weight:600;letter-spacing:-.02em">${esc(title)}</div>
  ${sub ? `<div style="margin-top:10px;color:#777;font-size:15px;line-height:1.5">${esc(sub)}</div>` : ''}
</div>`;
  return new Response(page, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
