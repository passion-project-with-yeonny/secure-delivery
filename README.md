# Secure Digital Delivery — one-click Cloudflare setup

This turns a successful Stripe payment into a **private, self-expiring download link**.
Your files live in a **private Cloudflare R2 bucket** and are only ever served behind a
token the worker signed — so a link can't be guessed, and a shared link dies on its own.

It pairs with the paid variant of the Framer template (the Thank-you page calls this worker).

> **No command line required.** Everything below is done in the browser.

---

## One-time setup — for the template seller

The Deploy button works only after **you** (the seller) put this folder in a **public
GitHub repo** once. Buyers then click the button and get their **own** private copy in
**their own** Cloudflare account — you never hold their keys, files, or traffic, and you
never pay for their downloads. The repo is safe to be public: it contains **no secrets**
(those are entered at deploy time).

```bash
# from this cloudflare-deploy/ folder, one time:
git init && git add . && git commit -m "Cloudflare delivery worker"
gh repo create spl-delivery --public --source=. --push   # or create the repo in the GitHub UI and push
```

Then point the button URL below at your new repo, and ship that button in your buyer guide.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/passion-project-with-yeonny/spl-delivery)

> This points at `passion-project-with-yeonny/spl-delivery`. If you fork it under a
> different account, update the `?url=` to your own repo.

Clicking the button (you, or a buyer) will:
1. Ask to authorize a **Cloudflare account** — and connect **GitHub** (it clones the repo into the clicker's account)
2. **Auto-create the private R2 bucket** (`product-files`)
3. Show a form to fill in the settings and secrets (listed below)
4. Deploy the worker and return a URL like `https://secure-delivery.NAME.workers.dev`

### What the form will ask you for

**Settings (vars):**
| Field | What to enter |
|---|---|
| `ALLOWED_ORIGIN` | **Required.** Your live site origin, no trailing slash — e.g. `https://your-site.framer.website` |
| `TOKEN_TTL_MINUTES` | How long a link stays valid (default `1440` = 24h) |
| `FREE_PRODUCT_KEY` | **Free template, no code edit.** Your freebie's file name in R2 (e.g. `free-checklist.pdf`). Set this and `/free-download` serves it — you never touch `worker.js`. |
| `FREE_PRODUCT_FILENAME` / `FREE_PRODUCT_NAME` | Optional — what the browser saves it as + a friendly display name |
| `SENDER_NAME` / `SENDER_EMAIL` | Only used if you enable email delivery |

**Secrets:**
| Field | Where to get it |
|---|---|
| `TOKEN_SIGNING_SECRET` | Any long random string. Generate one at [generate-random.org/api-key](https://generate-random.org/api-key-generator) or run `openssl rand -hex 32` |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | You get this in **step 3** below (`whsec_…`) |
| `BREVO_API_KEY` | *Optional* — only if you want delivery emails |
| `BREVO_FULFILLMENT_TEMPLATE_ID` | *Optional* — only if using a Brevo template |

---

## After deploying — 4 steps to go live

### 1. Tell the worker what you're selling
Open `worker.js` and edit the `PRODUCTS` map near the top. Each entry maps a product id to its file:
```js
const PRODUCTS = {
  product: { type: 'file', key: 'my-file.zip', filename: 'My-Product.zip', name: 'My Product' },
};
```
- `key` = the file's name in your R2 bucket (step 2)
- `filename` = what the buyer's browser saves it as
- For a video product, use `{ type: 'video', embed: '<unlisted embed url>', name: '…' }`

### 2. Upload your file to R2
Cloudflare dashboard → **R2** → open the `product-files` bucket → **Upload**.
Drag your file in. Make sure its name matches the `key` you set above.
> Free R2 holds **10 GB** with **no download fees** — plenty for PDFs, templates and ebooks.

### 3. Connect the Stripe webhook
Stripe Dashboard → **Developers → Webhooks → Add endpoint**
- **Endpoint URL:** `https://<your-worker-url>/stripe-webhook`
- **Event:** `payment_intent.succeeded`
- Copy the **Signing secret** (`whsec_…`) it gives you → paste it into your worker's
  `STRIPE_WEBHOOK_SECRET` (Cloudflare dashboard → your Worker → Settings → Variables → edit secret).

### 4. Point the template at your worker
In your Framer template's paid-checkout config, paste your Worker URL
(`https://secure-delivery.YOURNAME.workers.dev`). Done.

---

## Test it
1. Make a test purchase with Stripe test card `4242 4242 4242 4242`.
2. On the Thank-you page a **Download** button appears with a token link.
3. Click it → the file downloads. Wait past `TOKEN_TTL_MINUTES` → the same link stops working. ✅

---

## Free template — instant download (no payment)

The same worker also powers the **free** template, where there's no Stripe step: a
visitor enters an email and the file downloads immediately.

> ⚠️ **The download is not gated behind the visitor's inbox** — a fake email still
> gets the file. Use this when reach matters more than list quality. If you need a
> verified mailing list, deliver by email through Brevo/your ESP instead.

**Setup (no code edit):**
1. Upload your freebie to the R2 bucket.
2. Set **`FREE_PRODUCT_KEY`** to that file's name (in the Deploy form, or `wrangler.toml`).
   That's it — `/free-download` now serves it under the id `free`. (Advanced: you can
   instead add a `free: true` entry to the `PRODUCTS` map in `worker.js`; only `free:true`
   products are claimable this way, so paid products stay locked.)
3. In Framer, set the email form's **Delivery → Cloudflare direct** and **Worker URL** to
   `https://<your-worker-url>/free-download` (see the buyer guide). **Product ID** can stay
   at its default — it's ignored when `FREE_PRODUCT_KEY` is set (only the advanced
   PRODUCTS-map path uses it).

**Optional — keep the emails you capture:**
- **Export later:** create a KV namespace, bind it as `LEADS` in `wrangler.toml`
  (commented example included). Each submission is stored as `<timestamp>__<email>`.
- **Add to Brevo:** set `BREVO_API_KEY` (and optionally `BREVO_LIST_ID`). The worker
  adds the contact via the API — **no email is sent**, so this never counts against
  Brevo's daily send limit. This is the trick that builds a list for free while
  Cloudflare serves the file for free.

**How it works:** `POST /free-download { email, product }` → records the lead
(best-effort) → returns a signed, self-expiring link to `/download` (same private-R2
streaming the paid flow uses). The file stays private; the link can't be guessed.

---

## Security notes
- **No secrets live in this repo.** You enter them at deploy time; they're stored encrypted in your own Cloudflare account. This repo can safely be public.
- Each deployment is **yours alone** — your keys, your bucket, isolated from anyone else who deploys this template.
- Payments are **re-verified with Stripe** server-side, so a buyer can't forge access.
- Links are **HMAC-signed and expire**; files sit in a **private** bucket, never publicly listed.
- Staying within Cloudflare's free allowances (Workers ~100k requests/day, R2 10 GB) is up to you; upgrade if you outgrow them.

## Files in this repo
- `worker.js` — the delivery worker (routes, token signing, Stripe verification, R2 streaming, optional email)
- `wrangler.toml` — bucket binding + settings (placeholder values only)
- `.dev.vars.example` — declares the secrets the deploy form asks for
- `package.json` — deploy-form field descriptions
