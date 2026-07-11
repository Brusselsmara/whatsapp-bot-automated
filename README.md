# PayLink — WhatsApp Cross-Border Payments Bot

PayLink is a WhatsApp bot that lets individuals and businesses register, verify their identity, fund an internal wallet, and send money or pay invoices to bank accounts and mobile money wallets across **Botswana (BWP)**, **South Africa (ZAR)**, and **Zambia (ZMW)**.

Each user has exactly **one wallet**, in their **home currency** — auto-detected from the country code of the WhatsApp number they registered with (e.g. `+267…` → BWP). Top-ups always fund that one wallet. Sending money to a recipient in a *different* currency (a cross-border send) is fully supported — the bot bridges the conversion internally (via USD) and shows the sender the exchange rate, fee, and total cost before they confirm; the recipient never sees or needs a foreign-currency wallet.

Built with **Twilio WhatsApp** + **Node.js on Vercel** + **Supabase Postgres** + **Yellow Card** (fiat settlement).

---

## What the bot does

| Capability | Individuals | Businesses |
|------------|:-----------:|:----------:|
| Register (KYC/KYB) with document upload | ✅ | ✅ |
| Manual admin approval via email | ✅ | ✅ |
| One home-currency wallet (auto-detected from phone number) | ✅ | ✅ |
| Top-up via **bank transfer** | BW, ZA | BW, ZA |
| Top-up via **mobile money** | BW, ZM | BW, ZM |
| Send money domestically (bank or momo, same currency) | ✅ | ✅ |
| Send money cross-border (momo, auto-detected recipient currency) | ✅ | ✅ |
| Pay supplier invoice | — | ✅ |
| Create invoice (share code with customer) | — | ✅ |
| Check balance | ✅ | ✅ |
| Transaction history (last 5) | ✅ | ✅ |
| Status lookup (reference / invoice code) | — | ✅ |
| PDF remittance receipt on completed sends | ✅ | ✅ |

---

## Architecture

```
Customer WhatsApp
      │
      ▼
Twilio WhatsApp API  ──►  /api/whatsapp.js
                                │
                                ▼
                        lib/conversation.js   (state machine / menus)
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
         Supabase DB      Yellow Card API    Resend (KYC email)
    users · wallets ·     receive (top-up)         │
    sessions · txns ·     send (payout)            ▼
    invoices · kyc         webhooks          /api/admin-kyc-*
              │                 │
              │                 ▼
              │     /api/yellowcard-webhook.js
              │                 │
              └────────► Twilio WhatsApp reply + PDF receipt
```

### API endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/whatsapp` | Incoming Twilio messages (text + media) |
| `POST /api/yellowcard-webhook` | Yellow Card payment status events |
| `GET /api/poll-topups` | Cron poller for all pending transactions |
| `GET /api/receipt?id=` | PDF remittance receipt (completed sends only) |
| `GET /api/admin-kyc-decision` | Approve or reject registration (email link) |
| `GET/POST /api/admin-kyc-request-info` | Request more KYC documents (email link) |

---

## Security

### Yellow Card webhook signature (required)

Every `POST /api/yellowcard-webhook` request is verified before processing:

1. Read the raw request body (no JSON re-serialization)
2. Compute `HMAC-SHA256(rawBody, YELLOWCARD_SECRET_KEY)` → base64
3. Compare to `X-YC-Signature` or `Yellowcard-Signature`
4. **Mismatch → `401 Unauthorized`** — request is dropped, no side effects

### Atomic settlement (no double-credit)

Top-up credits and send refunds use Postgres RPC functions (`claim_topup_credit`, `claim_send_refund`, etc.) with **`SELECT … FOR UPDATE`** row locks. Only one of webhook / cron / per-message poller can win — losers skip wallet mutation.

Run the RPC block at the bottom of `db/schema.sql` in Supabase after deploying.

### Production outbound IP (Vercel)

Vercel serverless functions use **dynamic outbound IPs**. If Yellow Card enforces IP whitelisting in production, outbound API calls may be blocked.

| Approach | Notes |
|----------|-------|
| **Fixie / QuotaGuard** | Static IP proxy for outbound YC API calls |
| **Vercel Secure Compute** | Vercel add-on for static egress IP |
| **Render / Railway** | Migrate backend to static-egress host |
| **YC inbound webhooks** | YC sends production webhooks from a static IP — whitelist that |

---

## Two balances (important)

The bot uses **two separate balances**. They are not the same thing.

| Balance | Where | What it is |
|---------|-------|------------|
| **User wallet** | Supabase `wallets` table | What the customer sees in WhatsApp. Debited on send; credited on top-up. |
| **YC Treasury** | Yellow Card dashboard | Stablecoin balance (USD) that Yellow Card uses to settle fiat payouts. |

- **Top-up (menu)** → calls Yellow Card **receive** API → credits the **user wallet** when payment completes.
- **Send / Pay invoice** → debits the **user wallet** → calls Yellow Card **send** API → YC pays out from **Treasury**.

You must fund the YC Treasury separately (stablecoin deposit in the Treasury Portal). See [YC Balance Top up docs](https://docs.yellowcard.engineering/docs/settlement-api.md).

---

## Country & channel coverage

Yellow Card currently supports these corridors for this bot:

| Country | Currency | Top-up bank | Top-up momo | Send bank | Send momo |
|---------|----------|:-----------:|:-----------:|:---------:|:---------:|
| Botswana | BWP | ✅ | ✅ (MyZaka, etc.) | ✅ | ✅ |
| South Africa | ZAR | ✅ | ❌ | ✅ | ❌ |
| Zambia | ZMW | ❌ | ✅ | ❌ | ✅ |

**Not supported yet:** Namibia (NAD), Zimbabwe (ZWL) — excluded until Yellow Card lists them on their [Africa coverage page](https://docs.yellowcard.engineering/docs/africa).

**Transaction limits:** minimum **10**, maximum **100,000** (local currency units) per transaction.

**Card top-up:** not available via Yellow Card’s direct API. Only bank and mobile money are supported.

---

## Menus

### Welcome (unregistered / rejected users)

```
Welcome to PayLink 👋
1️⃣ Register
2️⃣ Help
```

### Individual menu (after KYC approval)

```
1️⃣ Send money to bank or mobile wallet
2️⃣ Top-up Balance
3️⃣ Check Balance
4️⃣ Transaction History
```

### Business menu (after KYC approval)

```
1️⃣ Pay Invoice (pay a supplier)
2️⃣ Send money to bank or mobile wallet
3️⃣ Top-up Balance
4️⃣ Check Balance
5️⃣ Check invoice / transaction status
6️⃣ Transaction History
7️⃣ Create Invoice
```

Reply **hi**, **hello**, **menu**, or **start** anytime to return to the main menu.

---

## Workflow 1 — Customer registration (Individual & Business)

Both account types follow the same steps after choosing account type. Businesses collect one extra field (business name) and require more documents.

```mermaid
flowchart TD
    A[User messages bot] --> B{KYC status?}
    B -->|unregistered / rejected| C[Welcome: 1 Register]
    B -->|pending_review| D[Wait message — under review]
    B -->|approved| E[Main menu]

    C --> F[Individual or Business?]
    F -->|business| G[Business name]
    G --> H[Owner / rep full name]
    F -->|individual| H
    H --> I[Date of birth dd/mm/yyyy]
    I --> J[Address]
    J --> K[ID type + number]
    K --> L[Email]
    L --> M[Document checklist shown]
    M --> N[User sends photos/PDFs via WhatsApp]
    N --> O{Reply done?}
    O -->|more docs| N
    O -->|done| P[Save to DB · email admin]
    P --> Q[User: under review 1 business day]
```

### Individual — documents required

1. Government-issued photo ID (National ID, Passport, or Driver's Licence)
2. Proof of address (utility bill or bank statement, within 3 months)
3. Selfie holding the ID document

### Business — documents required (KYB)

1. Certificate of Incorporation / Business Registration
2. Company tax registration certificate
3. Proof of business address (within 3 months)
4. Government-issued photo ID of authorised representative
5. Proof of address of authorised representative (within 3 months)
6. Selfie of representative holding their ID
7. Latest audited financial statements or management accounts (if available)

### What happens after submission

1. User record saved with `kyc_status = pending_review`
2. Documents stored in `kyc_submissions` (Twilio media URLs)
3. Admin receives email (Resend) with attachments and three actions:
   - **Approve** → `kyc_status = approved`, home-currency wallet created at 0, WhatsApp welcome message
   - **Reject** → `kyc_status = rejected`, user notified
   - **Request More Info** → admin adds optional note, user gets WhatsApp checklist to resubmit

Until approved, only the welcome screen and help text are available — no payments.

---

## Workflow 2 — Top-up balance (fund user wallet)

Top-up uses Yellow Card’s **receive** API. There's no currency choice — the bot already knows the user's home currency (derived from their WhatsApp number), so it goes straight to channel/amount. When YC confirms payment, the user's **one wallet** is credited.

### Top-up — Botswana (BWP) — bank or momo

```mermaid
flowchart TD
    A[Menu: Top-up Balance] --> B[Currency = user's home currency, e.g. BWP]
    B --> C{Channel}
    C -->|1 Bank| D[Enter amount]
    C -->|2 Mobile money| D
    D --> E{Channel?}
    E -->|Bank| F[Confirm screen]
    F --> G[YC receive · bank details returned]
    G --> H[User transfers to YC bank account]
    H --> I[YC confirms · wallet credited]
    E -->|Momo| J[Enter momo number paying from]
    J --> K[YC receive · USSD prompt on phone]
    K --> L[User approves USSD]
    L --> I
```

### Top-up — South Africa (ZAR) — bank only

1. Home currency is ZAR → bank is the only channel, so no channel-choice step
2. Enter amount → **confirm**
3. Bot returns Yellow Card bank details + payment reference (`receive.reference`, e.g. `BSM6435281`)
4. User makes bank transfer with that reference
5. Wallet credited when YC marks receive complete

### Top-up — Zambia (ZMW) — mobile money only

1. Home currency is ZMW → momo is the only channel
2. Enter amount
3. Enter mobile money number (normalised to `+260…`)
4. USSD prompt sent to that number — user must approve
5. Wallet credited on completion

### Top-up settlement paths

Settlement uses **atomic Postgres RPCs** (`lib/settlement.js`) so webhook + cron cannot double-credit:

1. **Yellow Card webhook** (`RECEIVE.COMPLETE`) — primary
2. **Per-message poll** — `settlePending()` at the start of every incoming message
3. **Cron poller** — `GET /api/poll-topups?secret=…` every 2–5 minutes
4. **Immediate poll** — right after `submitReceive` returns

Only the first successful `claim_topup_credit` call credits the wallet.

---

## Workflow 3 — Send money (Individual & Business)

Send money always debits the sender's **one home-currency wallet**. What happens next depends on whether the recipient is in the **same** currency (domestic) or a **different** one (cross-border):

```mermaid
flowchart TD
    A[Menu: Send money] --> B[Recipient name]
    B --> C{Channel}
    C -->|1 Bank| D[Bank account number]
    C -->|2 Momo| E[Mobile money number]
    D --> F[Currency BWP / ZAR / ZMW — manual pick]
    E --> G{Detect country from number}
    G -->|unrecognised / unsupported| E
    G -->|detected| H2[Resolve & confirm recipient identity]
    F --> H2
    H2 -->|not found| E
    H2 -->|confirmed| H[Amount]
    H --> I{Same currency as sender's wallet?}
    I -->|yes, domestic| J[YC send fee × markup]
    I -->|no, cross-border| K[Bridge via USD · FX margin · flat fee]
    J --> L{Sufficient balance incl. fee?}
    K --> L
    L -->|no| M[Prompt to top up]
    L -->|yes| N[Show total fee / rate quote]
    N --> O[User confirms]
    O --> P[Debit wallet]
    P --> Q{Cross-border?}
    Q -->|yes| R[Lock real FX quote right before send]
    Q -->|no| S[submitSend, no quote needed]
    R --> S
    S --> T[YC submitSend + full KYC]
    T --> U[acceptSend fallback if needed]
    U --> V[Transaction pending in DB]
    V --> W{YC completes?}
    W -->|yes| X[PDF receipt via WhatsApp]
    W -->|failed| Y[Wallet refunded]
```

### Step-by-step (send money)

| Step | User input | Bot action |
|------|------------|------------|
| 1 | Recipient name | Saves to session |
| 2 | `1` bank or `2` momo | Sets `channelType` |
| 3a | Momo number | **Country/currency auto-detected** from the number's dial code (e.g. `+260…` → ZMW). Rejected with a clear message if unrecognised or unsupported for momo. |
| 3b | Bank account number | Currency still asked manually (bank numbers carry no dial code) |
| 4 | — | **Recipient identity resolved** (bank via Yellow Card; manual confirm for momo — see below). Bot shows the name and asks `1` Yes / `2` No before continuing. |
| 5 | Amount | Computed in the **sender's wallet currency** |
| 6 | — | Domestic → YC fee + flat markup. Cross-border → bridged FX estimate + flat fee. Balance checked incl. fees. |
| 7 | `confirm` | Debits wallet; cross-border sends lock a fresh live quote right before `submitSend` |
| 8 | — | User told payout is processing; receipt follows |

### Recipient identity verification — never blindly execute a payout

Before any amount is even asked, the bot resolves and confirms who the money is actually going to:

- **Bank transfers** — calls Yellow Card's `POST /business/details/bank` (Resolve Bank Account) with the account number + a network for that country. If it returns an `accountName`, the bot shows it (*"We found this account: **Jane Doe**"*) and requires `1` (yes) / `2` (no, re-enter the number) before continuing. A `ResolveAccountError`/"not found" response prompts the user to double-check the number and re-enter it — the flow never falls through to a payout.
- **Mobile money** — Yellow Card has no equivalent name-resolution endpoint for momo (bank-only, and only guaranteed for select countries). The bot instead falls back to an explicit manual confirmation of the name the sender already typed in at step 1 (*"We can't independently verify mobile money account names for this corridor yet... you're sending to **\<name>** at \<number>"*), with the same `1`/`2` gate.
- If the resolution call itself is unavailable/errors for a given corridor (not a "not found" response — just an unsupported/unreachable lookup), the bot fails **soft** into the same manual-confirmation prompt rather than blocking sends outright.
- This same gate applies to **both** plain sends (this workflow) and manual-entry invoice payments (Workflow 4B) — anywhere a payout is about to be submitted to a third-party recipient.

### Domestic sends (same currency in and out)

No FX conversion — the recipient receives exactly the amount entered. The fee is Yellow Card's own send fee (`getFeeConfig`) plus a **tiered markup** — the same formula for both bank and mobile money — shown to the user as a **single combined total** (the YC/markup split is never shown):

| Amount | Markup (added on top of YC's own fee) | Env var |
|--------|----------------------------------------|---------|
| ≤ `DOMESTIC_FEE_FLAT_THRESHOLD` (500) | Flat `DOMESTIC_FEE_FLAT_AMOUNT` (5) | — |
| > threshold | Flat amount **+** `DOMESTIC_FEE_PCT_ABOVE_THRESHOLD` (1%) × (amount − threshold) | — |

The flat amount and threshold are literal numbers in whatever currency the send itself is in (BWP, ZAR, or ZMW) — they are **not** FX-converted per currency.

```
markup     = amount <= threshold
               ? flatAmount
               : flatAmount + pctAboveThreshold × (amount − threshold)
totalDebit = amount + ycFee + markup
```

Example (defaults): a 1,000 BWP domestic send → markup = `5 + 1% × (1000 − 500)` = **10 BWP**, on top of YC's own send fee.

### Cross-border sends (different currency in and out)

The recipient's currency is auto-detected from their momo number (bank cross-border isn't currently exposed — currency is manually picked and validated against the channel, same as before). The sender is never shown or asked about a foreign-currency wallet — the conversion is bridged internally through each currency's USD rate:

```
bridgedRate  = (destCurrency per USD) / (sourceCurrency per USD)
displayRate  = bridgedRate × (1 − marginPct)
recipient gets ≈ amountEntered × displayRate
```

| Component | Calculation | Env var |
|-----------|-------------|---------|
| **Cross-border fee** | YC's send fee, looked up (and paid) in the **sender's home currency**, marked up by a flat **7%** | `CROSSBORDER_FEE_MARKUP_PCT` |
| **FX margin** | 2% shaved off the bridged rate (in PayLink's favour) | `CROSSBORDER_FX_MARGIN_PCT` |
| **VIP FX margin** | 1% instead of 2%, for **business** accounts sending **BWP → South Africa (ZAR)** of at least **500,000 BWP** | `CROSSBORDER_VIP_FX_MARGIN_PCT` / `CROSSBORDER_VIP_MIN_AMOUNT_BWP` |

`totalDebit = amountEntered + (ycFee × (1 + 0.07))`

The rate/recipient-amount shown before confirm is an **unlocked estimate** (Yellow Card's `/business/rates`, no `quoteId`). The real, locked `getConversionQuote` (with a `quoteId` for `submitSend`) is only fetched **immediately before** debiting the wallet and submitting — this keeps the lock window as short as possible and avoids exposing a "quote expired, reply 1 to refresh" flow to the user for this workflow (Workflow 4 / invoice payments still use that live-quote-lock system, unchanged).

### Yellow Card payload (sends)

For BWP / ZAR / ZMW, **full sender KYC** is always sent (Tier 0 reduced KYC does not apply):

- `name`, `country`, `phone`, `address`, `dob`, `email`, `idNumber`, `idType` — `country`/`phone` always reflect the **sender's own home country**, even on cross-border sends where `destination.country` differs
- `customerUID` (user’s phone digits)
- `quoteId` — cross-border sends only, locked via `/business/quotes` right before submit; domestic sends omit it (no rate to lock)
- `reason`: `other` (send) or `bills` (invoice payment)
- `destination.country`, `networkId` (auto-selected from active YC networks)
- `forceAccept: true` + `acceptSend` fallback if still `created`/`pending`

### Send settlement & receipt

When Yellow Card marks the send **complete**:

1. Transaction status → `completed`
2. PDF receipt generated at `/api/receipt?id=<txn_uuid>`
3. WhatsApp message + PDF attachment sent to payer
4. `receipt_sent` flag set (prevents duplicates)

If send **fails** → wallet amount refunded, user notified.

---

## Workflow 4 — Pay invoice (Business only)

Invoice payments include **POBO fees** plus a **live FX quote** before the user confirms. The supplier always receives the invoice face value **in the invoice's own currency**; the payer's single home-currency wallet is debited the **total** (face value + POBO + PayLink markup), bridged into the wallet's currency if it differs from the invoice's.

### Fee formula (`lib/fees.js`)

| Component | Calculation |
|-----------|-------------|
| **Supplier receives** | Invoice face value, in the invoice's own currency |
| **Yellow Card POBO fee** | `$25 USD` (converted at YC sell rate) **+ 0.25%** of face value |
| **PayLink markup** | `INVOICE_PROFIT_MARKUP_PCT` % of face value (default **1%**) |
| **Invoice-currency total** | Face value + POBO fee + markup |

Configure via `.env`: `POBO_FLAT_FEE_USD`, `POBO_FEE_PCT`, `INVOICE_PROFIT_MARKUP_PCT`.

### Cross-currency invoices — bridged to the payer's home wallet

If the invoice's currency differs from the payer's `home_currency` (e.g. a BWP-wallet business paying a ZAR invoice), the invoice-currency total above is converted back to the wallet's currency using the **exact same bridging math as Workflow 3's cross-border sends** (`buildInvoiceWalletBridge`, sharing `getBridgedRate`/`getCrossBorderMargin` with `buildCrossBorderEstimate`) — just solved in the opposite direction, since here the *destination* amount (the invoice total) is fixed and the *wallet* debit is what needs to be calculated:

```
bridgedRate  = (invoiceCurrency per USD) / (walletCurrency per USD)
displayRate  = bridgedRate × (1 − marginPct)     ← same CROSSBORDER_FX_MARGIN_PCT / VIP margin as Workflow 3
walletDebit  = invoiceCurrencyTotal / displayRate
```

The wallet is debited `walletDebit` (in `home_currency`); the supplier still receives the invoice's face value in the invoice's own currency via `submitSend`. The quote shown to the user calls out the bridging rate explicitly and labels the total debit with the wallet's currency, not the invoice's. This applies to **both** ways of paying a supplier below.

Two ways to pay a supplier:

### A) Pay by invoice code

```mermaid
flowchart TD
    A[Menu: Pay Invoice] --> B[Enter invoice code e.g. INV-ABC123]
    B --> C[Load invoice amount + currency]
    C --> D{Channel for country}
    D -->|BW both| E[1 Bank or 2 Momo]
    D -->|ZA bank only| F[Bank account number]
    D -->|ZM momo only| G[Momo number]
    E --> H[Supplier account number]
    F --> H
    G --> H
    H --> H2[Resolve & confirm supplier identity]
    H2 -->|not found| H
    H2 -->|confirmed| I[POBO fee quote + live FX quote]
    I --> J[Reply confirm]
    J --> K[Debit total · YC send face value + quoteId]
    K --> L[Invoice marked paid on completion]
```

### B) Manual entry (skip invoice code)

1. Pay Invoice → reply **skip**
2. Enter supplier name → channel → account (momo auto-detects the supplier's country/currency, same as Workflow 3)
3. **Supplier identity resolved & confirmed** (same gate as Workflow 3 — see [Recipient identity verification](#recipient-identity-verification--never-blindly-execute-a-payout))
4. Amount → reference
5. Same POBO + live-FX-quote payout flow as before (`type = invoice_payment`, with the wallet-bridging above applied when the invoice's currency differs from `home_currency`) — **not** the new domestic/cross-border fee *model* from Workflow 3, just the same bridging math where relevant

---

## Workflow 5 — Create invoice (Business only)

| Step | Input |
|------|-------|
| 1 | Currency (`BWP`, `ZAR`, `ZMW`) |
| 2 | Amount |
| 3 | Description |

Bot returns an invoice code (e.g. `INV-A1B2C3`) to share with the customer. The customer (or another business) pays via **Pay Invoice** using that code.

Invoices stay `pending` until a linked `invoice_payment` transaction completes.

---

## Workflow 6 — Check balance, history & status

### Check balance (both account types)

- Polls pending transactions first (`settlePending`)
- Returns all currency balances, e.g. `BWP: 5000.00`

### Transaction history (both)

- Last **5** transactions with type, amount, status, recipient

### Status lookup (business only)

Accepts:

- Yellow Card reference (UUID from payout/top-up)
- Internal payment reference
- Invoice code (`INV-…`)

Polls Yellow Card before displaying status. Pending sends may complete and trigger receipt delivery during lookup.

---

## Sandbox testing

Use Yellow Card sandbox: `YELLOWCARD_BASE_URL=https://sandbox.api.yellowcard.io`

Fund the **YC Treasury** in the sandbox dashboard (stablecoin top-up address). Sandbox accounts often ship with pre-funded balance.

### Test account numbers

Per [YC Sandbox Testing](https://docs.yellowcard.engineering/docs/sandbox-testing-api.md):

| Type | Success | Failure |
|------|---------|---------|
| Bank account | `1111111111` | `0000000000` |
| Mobile money | `+{countryCode}1111111111` | `+{countryCode}0000000000` |

**Botswana momo success:** `+2671111111111`  
**South Africa bank success:** `1111111111`  
**Zambia momo success:** `+2601111111111`

Real phone numbers in sandbox may stay **pending** indefinitely.

---

## Setup

### 1. Supabase

1. Create a project at https://app.supabase.com
2. Run `db/schema.sql` in the SQL Editor (safe to re-run)
3. Copy **Project URL** → `SUPABASE_URL`
4. Copy **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`

### 2. Twilio WhatsApp

1. Create account at https://console.twilio.com
2. Enable WhatsApp Sandbox (testing) or apply for a production sender
3. Set **When a message comes in** webhook to:
   `https://<your-app>.vercel.app/api/whatsapp` (HTTP POST)
4. Copy Account SID, Auth Token, WhatsApp number → env vars

### 3. Yellow Card

1. Get sandbox credentials from https://docs.yellowcard.engineering
2. Set `YELLOWCARD_API_KEY`, `YELLOWCARD_SECRET_KEY`, `YELLOWCARD_BASE_URL`
3. Register webhook: `https://<your-app>.vercel.app/api/yellowcard-webhook`
   - Subscribe to: `RECEIVE.COMPLETE`, `RECEIVE.FAILED`, `SEND.COMPLETE`, `SEND.FAILED`
4. Fund Treasury balance in the YC dashboard before testing sends

### 4. Resend (KYC emails)

- `RESEND_API_KEY` from https://resend.com/api-keys
- `RESEND_FROM_EMAIL` — `PayLink <onboarding@resend.dev>` works for testing
- `ADMIN_EMAIL` — where review emails are sent

### 5. Deploy to Vercel

1. Push to GitHub and import in Vercel
2. Add all variables from `.env.example`
3. Set `PUBLIC_APP_URL` to your Vercel URL (no trailing slash) and redeploy
4. Configure Twilio and YC webhooks with the live URL

### 6. Cron poller (recommended)

Hit every 2–5 minutes:

```
https://<your-app>.vercel.app/api/poll-topups?secret=<CRON_SECRET>
```

Free options: [cron-job.org](https://cron-job.org). Vercel Hobby cron is limited to once/day.

---

## Environment variables

See `.env.example` for the full list:

| Variable | Purpose |
|----------|---------|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_NUMBER` | WhatsApp messaging |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Database |
| `YELLOWCARD_API_KEY` / `YELLOWCARD_SECRET_KEY` / `YELLOWCARD_BASE_URL` | Payments API + webhook HMAC |
| `POBO_FLAT_FEE_USD` / `POBO_FEE_PCT` / `INVOICE_PROFIT_MARKUP_PCT` | Invoice payment fee quote (Workflow 4, unchanged) |
| `FX_RATE_MULTIPLIER_BASE` / `QUOTE_LOCK_MINUTES` | Invoice payment live-quote margin/lock display (Workflow 4 only) |
| `DOMESTIC_FEE_FLAT_AMOUNT` / `DOMESTIC_FEE_FLAT_THRESHOLD` / `DOMESTIC_FEE_PCT_ABOVE_THRESHOLD` | Domestic send fee markup, tiered (default `5` / `500` / `0.01`) — same for bank and momo |
| `CROSSBORDER_FEE_MARKUP_PCT` | Cross-border flat fee markup on YC's fee (default `0.07`) |
| `CROSSBORDER_FX_MARGIN_PCT` / `CROSSBORDER_VIP_FX_MARGIN_PCT` | Cross-border FX margin, standard vs VIP corridor (default `0.02` / `0.01`) — also used to bridge cross-currency invoice payments (Workflow 4) back to the payer's wallet |
| `CROSSBORDER_VIP_MIN_AMOUNT_BWP` | Minimum BWP amount for the VIP FX margin (default `500000`) |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `ADMIN_EMAIL` | KYC review emails |
| `PUBLIC_APP_URL` | Deployment root URL only (e.g. `https://your-app.vercel.app`) — used for KYC email links, receipts, webhooks. **Not** the `/api/whatsapp` path |
| `CRON_SECRET` | Protects `/api/poll-topups` |

---

## Data model (Supabase)

| Table | Purpose |
|-------|---------|
| `users` | One row per WhatsApp phone; KYC fields; `account_type`; `kyc_status`; `home_currency` / `home_country` (auto-detected from phone, backfilled lazily); `fx_margin_pct` (invoice payments only) |
| `kyc_submissions` | Document URLs, approval token, admin decisions |
| `sessions` | Conversation state machine (`state` + `context` JSON) |
| `wallets` | Balance per user per currency — in practice always exactly one row (the user's `home_currency`) |
| `transactions` | Top-ups, sends, invoice payments; `currency`/`amount` = wallet debit/credit; `payout_currency`/`payout_amount` = what the recipient actually received (differs from `currency` on cross-border sends *and* cross-currency invoice payments); `quote_id`; `margin_pct` (bridging margin when cross-currency, else the settlement-quote margin); `wallet_credited` / `wallet_refunded` |
| `invoices` | Business-created invoices with shareable codes |

---

## Known limitations & production notes

- **KYC** — format validation + manual document review; no automated ID verification
- **Network selection** — bot auto-picks provider (MyZaka, Orange, Mascom, BTC heuristic); no user-facing network menu
- **No admin dashboard** — use Supabase table editor or build one later
- **Production IP whitelist** — Vercel uses dynamic outbound IPs; route YC API calls through Fixie, QuotaGuard, Vercel Secure Compute, or migrate to Render/Railway
- **Webhook auth** — invalid `X-YC-Signature` / `Yellowcard-Signature` returns `401` and is not processed
- **Settlement RPCs** — must run `db/schema.sql` RPC block in Supabase for atomic credits/refunds
- **Recipient identity resolution is bank-only on Yellow Card's side** — `POST /business/details/bank` has no mobile-money equivalent, so momo recipients get a manual name-confirmation prompt instead of an API-verified one. Bank resolution itself is also only guaranteed for select countries per Yellow Card's docs; unsupported/errored lookups fail soft into the same manual-confirm flow rather than blocking the send
- **Cross-border sends are momo-only** — the recipient's country/currency is deduced from their momo number's dial code; bank cross-border sends still require the sender to manually pick the recipient's currency (no way to infer it from a bare bank account number)
- **Cross-border FX margin** — dynamic per transaction (2% standard, 1% VIP corridor — see Workflow 3), not the static per-user `fx_margin_pct` column (that column is used only for invoice payments' own settlement-quote leg, Workflow 4 — a separate rate concept from the wallet-bridging margin)
- **No rate limiting** on webhooks beyond Twilio signature + `CRON_SECRET`
- **YC API retries** — transient failures surface as user-visible errors; wallet refunds on failed debits where applicable
- **Old pending transactions** from before payload fixes may need Yellow Card support to cancel

---

## Quick test checklist

1. Message the bot **hi** → welcome menu
2. Complete registration (from a BWP number, e.g. `+267…`) → admin approves via email → home-currency wallet (BWP) created
3. **Top-up** 100 BWP via momo sandbox number `+2671111111111` (no currency question — goes straight to channel/amount)
4. **Check balance** → should show credited amount
5. **Send (domestic)** 50 BWP to `+2671111111111` → confirm combined fee total → receive PDF receipt
6. **Send (cross-border)** 50 BWP to a Zambian momo number `+2601111111111` → confirm FX estimate + fee → receive PDF receipt showing the ZMW amount received
7. (Business) **Create invoice** → pay with POBO fee quote + live rate

---

## Tech stack

- **Runtime:** Node.js serverless functions on Vercel
- **Messaging:** Twilio WhatsApp API
- **Database:** Supabase (PostgreSQL)
- **Payments:** Yellow Card API (HMAC auth, live quotes, receive + send)
- **FX quotes & send fees:** `lib/quotes.js` (domestic/cross-border send fee model for Workflow 3; shared bridging math reused by cross-currency invoice payments in Workflow 4; live-quote margin + expiry handling for Workflow 4's own settlement leg)
- **Fees:** `lib/fees.js` (POBO + PayLink markup on invoices, Workflow 4)
- **Country detection:** `lib/yellowcard.js` (`detectCountryFromNumber` — dial-code lookup for momo auto-detection)
- **Recipient identity resolution:** `lib/yellowcard.js` (`resolveBankAccount`, `isAccountNotFoundError`, `pickPreferredNetwork`) + `lib/conversation.js` (`resolveRecipientIdentity`, `formatRecipientConfirmMessage`) — the never-blindly-execute-a-payout confirmation gate for Workflows 3 & 4B
- **Settlement:** `lib/settlement.js` (atomic Postgres RPCs)
- **Email:** Resend (KYC review with approve/reject/request-info)
- **Receipts:** PDF generated on the fly (`lib/pdf.js`)
