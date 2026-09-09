# Market Lens

Reads chart formations off real price history, then weighs them against a macro
factor model that is tuned per asset class — so copper is scored on Chinese
industrial demand and the dollar, while bitcoin is scored on liquidity, real
rates and ETF flow.

```bash
npm start
```

Then open http://localhost:5178 (or double-click `Start Market Lens.bat`).

---

## What it actually does

**1. Technical engine (deterministic, no LLM).**
Pulls OHLCV from Yahoo's chart endpoint — equities, ETFs, indices, futures, FX
and crypto, all keyless — and computes:

- Pivot-based market structure (higher highs / lower lows), ATR-clustered
  support and resistance, fitted trendlines and channels, volume profile with
  point of control and value area
- Formations: head and shoulders (and inverse), double/triple tops and bottoms,
  ascending / descending / symmetrical triangles, rising and falling wedges,
  rectangles, bull and bear flags and pennants, cup and handle, range breakouts
- For each formation: stage (forming / confirmed), a confidence score, the
  trigger level, the invalidation level, the measured-move target, and
  reward-to-risk measured from where you would actually enter
- Indicators: RSI, MACD, ADX with directional movement, ATR, Bollinger bands
  with squeeze detection, 20/50/200 averages and their slope
- Month-of-year seasonality computed from the asset's own history

Formations are searched over the **last 320 bars** — what a trader would have on
screen — while indicators use the full history. Patterns that already resolved
are filtered out rather than presented as live: a formation is dropped if it
broke out more than 25 bars ago, or if price has run more than 6 ATR past its
trigger.

**2. Macro engine (deterministic, no LLM).**
Fourteen factors — real rates, the dollar, yield curve slope, global growth
cycle, China/Asia industrial demand, central bank liquidity, risk appetite,
inflation expectations, energy, geopolitical stress, crypto flows, equity beta,
seasonality, positioning stretch.

Each factor produces a **stance** from -1 to +1 describing *the factor's own*
direction. Each asset profile then supplies a **weight** and a **sign** saying
what a rising reading means *for that asset*. Rising real rates are a heavy
headwind for gold (weight 0.26, sign -1) and near-irrelevant for copper
(weight 0.07). That is the whole point of the design.

**Weights are not purely hand-set.** The prior weight is scaled by how closely
the asset has actually tracked that factor's proxy over the last 90 sessions.
Two consequences:

- A factor the asset has decoupled from gets down-weighted automatically
- If an asset is trading *against* its textbook relationship, the model follows
  the market, flips the sign, and flags it in the UI

Correlations above 0.9 are treated as no evidence — that indicates the proxy is
effectively the asset itself (IBIT against BTC-USD), not a real relationship.

**3. Covered calls.** Optional panel, driven by CBOE's public delayed-quote feed
(keyless, and it ships delta/gamma/theta/vega and IV per contract). Three questions
in order:

- **Is premium worth selling?** Implied vol against realised vol, measured with
  both close-to-close and Parkinson estimators over a window matched to the
  option's tenor. If IV is at or below RV the panel says so and returns
  *unfavourable* regardless of how good the strikes look - that is a
  negative-expectancy starting point.
- **Does this fight our own read?** If the chart engine has a confirmed bullish
  formation projecting higher, or a rising channel whose rail projects above the
  strike by expiry, selling beneath that caps the exact move the model is
  forecasting. Confirmed formations set a hard ceiling; untriggered ones are a
  flagged caution.
- **Which strike?** Every out-of-the-money call is scored on premium collected,
  assignment probability (banded around the conventional 0.15-0.35 delta range),
  clustered resistance sitting between spot and the strike, distance in expected-move
  units, historical breach rate, and liquidity. Every component is shown with its
  point contribution, so the ranking is auditable rather than a black box.

Strikes paying less than 5% annualised are dropped outright - a call that pays a
rounding error is not a safe trade, it is a pointless one.

For instruments with no listed options (futures, spot crypto), the panel maps to
the liquid proxies people actually sell calls on - copper to FCX/COPX/CPER, gold to
GLD/GDX - and one click re-runs the whole model against that underlying.

**4. Composite.** Technical and macro scores are blended by timeframe. On a
5-minute chart macro carries 5%; on a monthly chart it carries 65%. Agreement
between the two lenses is reported rather than averaged away.

**5. Written briefing (Claude).** Optional. Every number is computed before
Claude sees it — the model explains the reading and adds named real-world
context, explicitly flagged as background knowledge rather than live reporting.
It is instructed never to invent a level.

---

## Configuration

Copy `.env.example` to `.env`:

```
APP_PASSWORD=                    # password gate; REQUIRED before exposing the app
ANTHROPIC_API_KEY=sk-ant-...     # written briefing; everything else works without it
FRED_API_KEY=                    # optional, free, instant
PORT=5178
```

**`APP_PASSWORD` gates the whole app** - the page itself, not just the API.
Leave it blank for localhost-only use and the app runs open (the startup banner
says so loudly). Set it before the app is reachable from anywhere else: without
it, anyone who can reach the port can spend your Anthropic key through
`/api/narrative`.

The session is an HMAC-signed, 30-day expiring cookie keyed off the password, so
changing the password signs out every existing session. Login attempts are capped
at 10 per 15 minutes per IP. No new dependencies - it is all `node:crypto`.

**Without a FRED key** the app still runs. Real rates fall back to the nominal
10-year, liquidity falls back to a credit-and-dollar conditions proxy, and
inflation falls back to TIPS-versus-nominals. The yield curve still comes from
the US Treasury's keyless daily CSV. Every fallback is labelled "proxy" in the
UI so you always know which readings are hard data.

**With a FRED key** you get the actual 10-year TIPS yield, the 10s-2s spread,
5-year breakevens, the Fed balance sheet, M2, industrial production, and
high-yield spreads. Free key: https://fredaccount.stlouisfed.org/apikeys

---

## Symbols

Yahoo notation. `HG=F` copper, `GC=F` gold, `CL=F` crude, `ZC=F` corn,
`BTC-USD` bitcoin, `EURUSD=X` euro, `^GSPC` S&P 500, `AAPL` equities. The
search box resolves names to tickers as you type.

Asset classification is automatic — futures and ETFs map to their commodity
class, and miners like FCX and GDX are deliberately classified with the metal
they dig rather than as ordinary equities.

---

## Known limits

These are real, and the UI states them rather than papering over them:

- **Geopolitical stress is market-implied, not a news feed.** It reads gold,
  crude, defense-sector relative strength and implied volatility to measure what
  markets are *pricing*. Named events come from Claude's own knowledge in the
  written briefing, with a training cutoff, and need verifying.
- **Commodity inventories and futures curve shape are not modelled.** Neither is
  weather for agriculture. Both are paywalled.
- **China activity is proxied by FXI and EWY**, not official PMI.
- **For FX, only the US leg of the rate differential is measured.**
- **Single stocks carry no company-specific input** — no earnings, guidance or
  litigation. The macro read is backdrop, not thesis.
- **Options quotes are delayed ~15 minutes.** Fine for choosing a strike, useless
  for timing a fill.
- **Historical breach rates are unconditional.** They pool every regime in the
  asset's history, so they are a base rate rather than a forecast. On a trending
  underlying they run well above what delta implies - that gap is the point, but
  do not read it as a prediction.
- **No per-symbol IV rank.** There is no free history of single-name implied vol.
  Asset-class context comes from VIX, GVZ and OVX instead, and IV/RV does the work
  IV rank usually does.
- **No earnings or ex-dividend calendar yet.** Check both before selling a call
  that spans either.
- Yahoo is an unofficial endpoint. It can rate-limit; the app caches for 15
  minutes (1 minute for intraday) to stay well inside its tolerance.

## This is an analysis tool

It does not give personalised investment advice, does not know your
circumstances, and does not size positions. Treat the output as one input.

---

## Layout

```
server.js              Express host and JSON API
lib/
  analyze.js           composite engine, timeframe blending, invalidation
  llm.js               Claude synthesis (claude-opus-5), strictly grounded
  cache.js             TTL cache
  data/yahoo.js        OHLCV, daily closes, symbol search
  data/fred.js         FRED series + keyless Treasury curve fallback
  data/cboe.js         options chains with greeks, proxy map for unlisted assets
  options/vol.js       realised vol, IV/RV, expected move, historical breach
  options/covered.js   strike scoring, thesis conflict check, panel verdict
  ta/indicators.js     SMA/EMA/RSI/MACD/ATR/Bollinger/ADX/correlation/linreg
  ta/structure.js      pivots, swing structure, S/R, trendlines, channels, volume profile
  ta/patterns.js       formation detection, staleness filtering
  ta/technical.js      orchestration, regime, bias score, seasonality
  macro/profiles.js    asset classification and per-class factor weights + signs
  macro/factors.js     factor readings from market and economic data
  macro/macro.js       correlation-adjusted weighting and macro score
public/                UI, canvas chart with pattern overlays
```
