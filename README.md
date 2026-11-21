# Options Desk – Android app (paper trading)

Port of your workbook (Guy Cohen's 10 strategies + book thumb rules + Bull/Bear/Judge agents) to an Android app.
Paper trading only: the app never places real orders.

## Get the APK (I could not compile it in my sandbox - no Android SDK access)
**Easiest (no PC setup):** create a free GitHub repo, upload this folder's contents, open Actions > "Build APK" > Run workflow.
Download artifact `OptionsDesk-apk` (app-debug.apk), copy to phone, allow "install unknown apps", install.
**On a PC:** install Node 20, JDK 17, Android Studio (SDK), then run `./build.sh`.

## First run
1. Settings > Data feed: Mode = Demo works offline immediately (synthetic prices, to test everything).
2. For real prices: Mode = Live, paste your Upstox **Analytics token** (read-only, cannot trade), tap "Test connection".
3. Settings > Option expiry: AUTO (book rule) or pick a fetched monthly expiry (near / next / far).
4. Settings > The 10 strategy concepts: toggle each ON/OFF (defaults copy your workbook's Status column).

## Paper trading realism
Fills at option-chain ask (buy) / bid (sell) + slippage %; lot-size quantities; margin check (debit = premium,
credit = max loss); brokerage + STT/exchange/GST estimates; mark-to-market at liquidation value (bid for longs, ask for shorts);
auto exit on target / SL / exit-by date / expiry; auto-trade by min conviction; trade log with CSV copy.

## Assumptions to verify
- Upstox endpoints used: market-quote/quotes, historical-candle (day), option/contract, option/chain. Not tested against your account.
- Charge rates (STT 0.1% default etc.) are editable estimates. Lot sizes/instrument keys come from your workbook (verify with NSE).
- Neutral strategies 7-10 get a fixed conviction of 50 (the workbook never promoted them to its Dashboard).
- Manual expiry choice turns the book's days-to-expiry rules into warnings.
- Most individual F&O traders lose money (SEBI). Educational tool, not advice.
