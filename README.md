# WhatsApp Cross-Border Payments Bot

## 🔄 Major update: wallet-based model with manual KYC approval

This bot now works differently from earlier versions:

1. **New users register first** — individual or business, KYC/KYB details, and document uploads (sent as WhatsApp photos/PDFs).
2. **You review manually by email** — every registration sends you an email (via Resend) with the documents attached and **Approve / Reject** buttons. No dashboard needed, no email-reply-parsing — just click a button.
3. **Approved users get an internal wallet** (one balance per currency: BWP, ZAR, ZMW) instead of paying per-transaction.
4. **Top-up Balance** funds the wallet via bank transfer or mobile money (same Yellow Card receive flow as before).
5. **Pay Invoice** / **Send money** debit the wallet and push funds out to a supplier or recipient's bank/mobile money account via Yellow Card's send API.
6. **PDF remittance receipts** are generated on the fly and sent back as a WhatsApp document once a payment completes.

Run `db/schema.sql` again in Supabase's SQL editor even if you ran the old version — it's safe to re-run (uses `if not exists` throughout) and adds the new tables/columns.

### New environment variables needed
- `RESEND_API_KEY` — from https://resend.com/api-keys (free tier is enough)
- `RESEND_FROM_EMAIL` — while testing, `PayLink <onboarding@resend.dev>` works with no domain setup
- `ADMIN_EMAIL` — your own email, where KYC review emails get sent

### A known limitation worth knowing about
Debit/credit card top-up isn't available through Yellow Card's direct API — only bank transfer and mobile money have a `channelType` in their API. Card payments exist only through Yellow Card's separate hosted checkout widget (a link you'd open in a browser, not a raw API call). Top-up currently supports bank + mobile money only; card support would need a second, different integration if you want it.

---


MVP: WhatsApp bot (Twilio) + Node.js (Vercel serverless) + Supabase Postgres +
Yellow Card (stablecoin-to-fiat settlement).

Covers both:
- **B2B**: create an invoice, share a code, get paid, get notified.
- **B2C**: pay an invoice, or send money directly to someone's WhatsApp number.

## ⚠️ Important: country coverage

I checked Yellow Card's current coverage page. Of your 5 target countries, only
**3 are currently supported**:

| Country      | Currency | Receive (get paid) | Send (payout) |
|--------------|----------|---------------------|----------------|
| Botswana     | BWP      | Bank + Mobile Money (MyZaka) | Bank + Mobile Money (MyZaka) |
| South Africa | ZAR      | Bank only | Bank only |
| Zambia       | ZMW      | Mobile Money only (Airtel/MTN/TNM) | Mobile Money only |
| **Namibia**  | NAD      | ❌ not yet supported | ❌ not yet supported |
| **Zimbabwe** | ZWL      | ❌ not yet supported | ❌ not yet supported |

This bot is built for Botswana, South Africa, and Zambia. Namibia and Zimbabwe
are deliberately left out of `CURRENCY_TO_COUNTRY` in `lib/conversation.js` and
`COUNTRY_CONFIG` in `lib/yellowcard.js` — add them there the day Yellow Card's
[coverage page](https://docs.yellowcard.engineering/docs/africa) lists them.
You may want to ask Yellow Card directly about their roadmap for those two
markets, or look at a secondary provider for them in the meantime.

## How it fits together

```
Customer's WhatsApp
      │
      ▼
Twilio WhatsApp API  ──►  /api/whatsapp.js   (Vercel function)
                                │
                                ▼
                        lib/conversation.js  (menu / state machine)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              Supabase DB            Yellow Card API
        (users, invoices,           (quotes, collections,
         transactions, sessions)      payouts)
                                            │
                                            ▼
                              /api/yellowcard-webhook.js
                              (payment confirmed/failed)
                                            │
                                            ▼
                              Twilio sends WhatsApp update
                                    back to both parties
```

## 1. Set up Supabase

1. Create a project at https://app.supabase.com
2. Open **SQL Editor** → paste the contents of `db/schema.sql` → run it.
3. Go to **Settings → API** and copy:
   - `Project URL` → this is `SUPABASE_URL`
   - `service_role` secret key → this is `SUPABASE_SERVICE_ROLE_KEY`
   (Not the `anon` key — this app needs full server-side access.)

## 2. Set up Twilio WhatsApp

1. Create a Twilio account: https://console.twilio.com
2. For testing: enable the **WhatsApp Sandbox** (Messaging → Try it out →
   Send a WhatsApp message). For production, apply for a WhatsApp Sender.
3. From the Twilio Console home page, copy:
   - `Account SID` → `TWILIO_ACCOUNT_SID`
   - `Auth Token` → `TWILIO_AUTH_TOKEN`
4. Note your WhatsApp-enabled number, e.g. `whatsapp:+14155238886` → `TWILIO_WHATSAPP_NUMBER`
5. Once deployed (step 4 below), come back and set the sandbox/sender's
   **"When a message comes in"** webhook to:
   `https://<your-vercel-app>.vercel.app/api/whatsapp`

## 3. Set up Yellow Card

1. Get sandbox API access at https://docs.yellowcard.engineering
2. From the dashboard, get your **API key** and **secret key**
   → `YELLOWCARD_API_KEY`, `YELLOWCARD_SECRET_KEY`
3. Auth is already implemented correctly in `lib/yellowcard.js` — Yellow Card
   uses an `Authorization: YcHmacV1 {apiKey}:{signature}` header plus
   `X-YC-Timestamp`, where the signature is an HMAC-SHA256 (in base64) over
   `timestamp + path + METHOD (+ base64(sha256(body)) for POST/PUT)`.
   Confirmed directly against their docs — nothing to change here.
4. In the Yellow Card dashboard, create a webhook pointing to:
   `https://<your-vercel-app>.vercel.app/api/yellowcard-webhook`
   Subscribe to `RECEIVE.COMPLETE`, `RECEIVE.FAILED`, `SEND.COMPLETE`,
   `SEND.FAILED` (or leave it unfiltered to get all events).
5. Keep `YELLOWCARD_BASE_URL=https://sandbox.api.yellowcard.io` while testing.
   Switch to the production URL Yellow Card gives you when you go live —
   production also requires you to share your server's static IP for
   whitelisting (Vercel functions don't have a fixed outbound IP by default,
   so you'll likely need a paid add-on like Vercel's "Secure Compute" or a
   NAT gateway — worth asking Yellow Card and Vercel about this specifically
   before going live).

### Sandbox test values
- Mobile money account number `1111111111` simulates a **successful** payment.
- Mobile money account number `0000000000` simulates a **failed** payment.
- Sandbox receive requests expire after 10 minutes if not accepted — this
  bot uses `forceAccept: true` so they process immediately, no separate
  accept step needed.

## 4. Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com/new and import that repo.
3. Before the first deploy, go to **Settings → Environment Variables** and
   add every variable listed in `.env.example` with your real values.
4. Deploy. Vercel will give you a URL like `https://your-app.vercel.app`.
5. Set `PUBLIC_APP_URL` env var to that exact URL, then redeploy (needed for
   Twilio signature verification).
6. Go back and paste the two webhook URLs (step 2.5 and step 3.4 above)
   using your real Vercel URL.

## 5. Set up a cron trigger for `/api/poll-topups`

The bot already settles pending top-ups/sends two ways without any extra setup:
- **The Yellow Card webhook** (`/api/yellowcard-webhook`) — fires the moment YC's
  status changes. This is the primary path.
- **A fire-and-forget check** at the start of every WhatsApp message a user sends
  (`settlePending` in `lib/conversation.js`) — catches anything the webhook missed,
  but only for that specific user, and only when they message the bot again.

Neither of those covers the case where a payment finishes and the *webhook delivery
fails* (network blip, YC retry exhausted, etc.) and the user never sends another
message. For that, add a third safety net: an external cron service that hits
`/api/poll-topups` every few minutes for **all** users with pending transactions.

1. Create a free account at something like https://cron-job.org (Vercel Hobby plan
   cron jobs are limited to once/day, which is too infrequent for payment status —
   an external service gives you per-minute scheduling for free).
2. Set it to call, every 2–5 minutes:
   `https://<your-vercel-app>.vercel.app/api/poll-topups?secret=<your CRON_SECRET>`
   (or send `X-Cron-Secret: <your CRON_SECRET>` as a header instead of the query param)
3. Make sure `CRON_SECRET` is set in Vercel's environment variables (see `.env.example`)
   — without it, the endpoint is unauthenticated and callable by anyone who finds the URL.

## 6. Test it

Message your Twilio WhatsApp sandbox number "hi" — you should get the menu.
Try creating an invoice (option 1), then from a second phone number, reply
"2" and pay it with that invoice code.

## What's intentionally simple in this MVP (next steps for later)

- **KYC collection has basic format validation** (DOB format, email format,
  minimum ID number length) but no document verification beyond a manual
  human review of the uploaded photos/PDFs — that's by design (see the
  manual-review-by-email flow above), not a gap.
- **Network selection uses a name-matching heuristic, not a user-facing
  choice**: when paying via mobile money, the bot prefers a network whose
  name matches a known provider (MyZaka, Orange, Mascom, BTC) and falls back
  to the first active network Yellow Card returns. This works for the
  currently-supported countries (each has at most a couple of networks per
  channel) but if Yellow Card adds more competing providers per country later,
  you'll want to list options and let the user pick explicitly — see
  `yc.getNetworks()` in `lib/yellowcard.js`.
- **Idempotency and retries are handled** at the wallet-ledger level (every
  top-up/send is credited or refunded exactly once, guarded by a status
  check before each wallet update) across all three settlement paths — the
  webhook, the cron poller, and the fire-and-forget per-message check. Yellow
  Card API calls themselves aren't retried on transient network failures
  beyond the built-in request timeout — a dropped request currently surfaces
  as a failure to the user rather than being retried automatically.
- **No admin dashboard** — all data lives in Supabase; use the Supabase
  table editor to view/manage invoices and transactions for now.
- **Static IP for production webhooks/whitelisting**: see the note in the
  Yellow Card setup section above — this needs solving before going live
  on Vercel.
- **No rate limiting** on `/api/whatsapp` or `/api/poll-topups` beyond Twilio
  signature verification and the `CRON_SECRET` check — fine at low volume,
  worth adding (e.g. Vercel's Edge Config or a simple per-phone cooldown) if
  the bot is ever exposed to abuse/spam traffic.
