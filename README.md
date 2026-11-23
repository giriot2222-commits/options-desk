# Options Desk v4 – broker-style options paper-trading app (EDUCATIONAL PURPOSE ONLY)

Not investment advice. Paper trading by default. SEBI studies found most individual F&O traders lose money.

## Build the APK
Push this folder to GitHub (`main`). The workflow builds the app and publishes `OptionsDesk.apk` under the repo's **Releases** page
(also as an Actions artifact). Local build: `./build.sh` (Node 20, JDK 17, Android SDK).

## The concept (from your workbook + the book)
- **Agent 1 – book rules:** Bull (B1-B6) vs Bear (R1-R6) scores, planner strategy by trend score + VIX, candidate if edge >= min edge and
  the strategy matches the direction, then **13 book-rule checks** (expiry, breakeven, credit yield, cushion, support/resistance,
  open interest, bid-ask, volume, straddle cost (40/60/80-day range by expiry), event, reward:risk, trend & support, consolidation).
- **Agent 2 – history & movement** (runs only after Agent 1 triggers and rules pass): 10 checks (momentum 5/20d, RSI, breakout, volume,
  strength vs Nifty, closed intraday candles, room to run, ATR movement vs target, your own paper-trade history).
- **Judge:** blends both convictions, decides BUY / SELL / NEUTRAL or IGNORE (strictness: lenient / normal / strict).
- **Closed-candle check (default ON):** signals use only fully closed candles (5/15/30/60m); today's forming daily candle is excluded.
- **Trading time:** new orders only 09:30–15:10 IST by default (editable). Profit is booked / stops hit any time the market is open.
- **Money management:** AI risk-based lots (scaled by conviction) inside utilisation caps, daily loss limit, max trades/day, max 20 open.
- **Win-rate pages:** History → Win rate (by strategy, side, conviction, trade type, Agent 2 score, candle confirmation, exit reason).
- **AI tuning (optional, OFF by default):** adjusts strategy ON/OFF, min conviction, candle confirmation and Agent 2 strictness from your
  closed paper trades. Never changes risk, stop-loss or book rules. No guarantee of results.

## Feed and orders are separate
- Feed: Demo, Upstox (Analytics token), or **Custom JSON feed** (your adapter server: `/quotes`, `/candles?symbol=&tf=day`, `/closed?symbol=&tf=`,
  `/expiries?symbol=`, `/chain?symbol=&expiry=` – see the in-app text and engine/feed.js).
- Orders: **Paper only (default)**, **Broker – confirm each order**, or **Broker – AUTO**. Built-in: Upstox (`POST /v2/order/place`, needs a
  TRADING access token, not the Analytics token). Any other broker: **Custom webhook** with a body template.
  Safety: needs typing "I UNDERSTAND", starts in DRY RUN, max order value, daily order cap, BUY legs sent first, blocked on demo data.
  Live execution is untested against a real broker account – test in dry run and with 1 lot first. Some brokers require an algo id for API orders.

## Limits
No tick data; app works while open; trend signals ignore news/results; lot sizes / holidays approximate; email alerts unavailable (Telegram + phone notifications).
