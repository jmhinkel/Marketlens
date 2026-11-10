# Market Lens

Reads chart formations off real price history, then weighs them against a macro
factor model that is tuned per asset class — so copper is scored on Chinese
industrial demand and the dollar, while bitcoin is scored on liquidity, real
rates and ETF flow.

> **This is a research and analysis tool, not investment advice.** It does not
> know your circumstances, does not size positions, and does not recommend
> trades. Its macro readings are derived from market prices rather than a live
> news feed, and its options quotes are delayed. Nothing here is a solicitation
> or an offer, and no output should be relied on without independent
> verification. Use at your own risk.

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

**4. Cash-secured puts.** The mirror of the covered-call panel, but three
things invert rather than reflect, and the scoring turns on them:

- **Structure inverts.** A call seller wants resistance below the strike; a put
  seller wants *support above* it - clustered demand price has to break through
  before the strike is threatened.
- **The thesis check inverts.** A bullish formation argues *for* selling puts.
  The trap case is a confirmed bearish formation projecting through the strike,
  where you would be underwriting the exact decline the model is forecasting.
- **Assignment starts a position rather than ending one.** So "is the effective
  basis a price worth owning at" is a scored criterion, not a footnote - the
  strike less premium is measured against support and the 200-day average.

It also measures **put skew** - equidistant put IV against call IV. Equity puts
usually carry a fear premium, and that spread is the reason put selling can
out-earn call selling on the same name. SMH currently prices puts 5.1 vol points
above equidistant calls; GDX is flat, so there is no downside premium advantage
there.

Returns are quoted on the cash actually committed (strike less premium), not on
notional.

**5. Buying calls.** Not the covered-call panel with the sign flipped —
premium buying and premium selling are different trades and nearly every test
inverts:

- **The volatility gate reverses.** A seller wants implied above realised; a
  buyer wants it at or below. Paying 45 vol for an asset that delivers 30 means
  being right on direction and still losing.
- **You pay the ask**, not the bid. On a wide market that gap is the largest
  single cost in the trade, so every number here is quoted off the ask.
- **Time is the enemy.** Theta is shown as a daily percentage bleed, and a
  formation that has not triggered yet is penalised — decay runs while you wait
  for the thesis to even start.
- **The target must clear the breakeven.** This is the test the rest of the app
  uniquely enables: the chart engine already computes a measured move, so the
  panel can ask whether the forecast move is even enough to pay for the option.
  A negative "Target − BE" means the position loses while the thesis plays out
  perfectly, which is the most common way a correct directional call still
  loses money.

Measured moves are geometry, not probability, so the credit for clearing the
breakeven is discounted as the target drifts beyond what the option market
prices as plausible — a flag pole projecting 3.7 standard deviations is not a
basis for buying premium. A soberer **return at 1σ** column sits alongside the
return at target.

**6. Opportunity scan.** Ranks a universe by how tradeable the SETUP is right
now, long and short - which is a different question from how bullish or bearish
the asset looks. A strong trend with no defined entry is a poor setup; a coiled
range with a formation one ATR from its trigger is a good one. Each candidate is
scored on the formation and its confidence, how close price sits to the trigger,
reward-to-risk, agreement with the swing structure, regime, and room to the next
barrier - then nudged by the macro model.

Two things it deliberately punishes: a confirmed break that already ran several
ATR past its trigger scores *lower* than one that just fired, because the entry
is spent and the stop sits far behind; and reward-to-risk below about 1.2:1 is a
real drag rather than a rounding error. When a chart shows credible formations in
both directions, only the stronger side is listed, flagged as two-sided.

Runs in two stages for speed - a technical-only pass over the whole universe,
then the full macro model on the finalists - which keeps a 28-symbol scan around
two seconds and inside a serverless timeout.

**7. Contract scanner.** The options counterpart to the opportunity scan, and
built on the opposite principle. Where that one ranks chart setups with a
weighted score, this one refuses to: it prices every liquid contract in a
universe against the asset's own return distribution and ranks by expected
value per dollar of capital - premium received minus what the contract is
actually worth. Hard gates first (variance risk premium, liquidity, sample
adequacy), ordering second.

Unlike the setup score, the quantity underneath it has an observable
counterpart, so it could be calibrated out of sample - and was, which caught
two of its own design errors before shipping. It also carries the app's first
earnings guard, read out of the chain's implied-volatility term structure
rather than a calendar feed. Full account below.

**8. Composite.** Technical and macro scores are blended by timeframe. On a
5-minute chart macro carries 5%; on a monthly chart it carries 65%. Agreement
between the two lenses is reported rather than averaged away.

**9. Written briefing (optional).** Every number is computed before the model
sees it - it explains the reading and adds named real-world context, flagged as
background knowledge rather than live reporting, and is instructed never to
invent a level.

Two providers are supported. Set `ANTHROPIC_API_KEY` for Claude, or
`VENICE_API_KEY` for Venice (OpenAI-compatible, no SDK needed). With both set,
`LLM_PROVIDER` picks. `VENICE_MODEL` defaults to `gemini-3-6-flash`, measured at
roughly 30-45 seconds for a full briefing - the larger Venice models ran past
two minutes, which is too slow for something a person waits on.

The payload is rounded before it is sent. Handed a raw float a model will
faithfully repeat it, and an early run quoted copper to fifteen decimal places
while overrunning its token budget mid-section.

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

## Backtest result: the setup score does not predict direction

`node tools/backtest-setups.mjs [universe] [horizonDays] [stepBars]`

Walk-forward over ten years of the core universe. At each sampled bar the
engine sees only the bars up to that point - the array is sliced before the
analysis gets it, so lookahead is prevented structurally rather than by care -
the setup is scored exactly as the live scanner scores it, and the forward
return is recorded.

The result, consistent across 5, 10 and 20 trading-day horizons:

| Horizon | Long rank correlation | Top bucket (70+) | Unselected baseline |
|---|---|---|---|
| 5 days | +0.003 | -0.18% | +0.19% |
| 10 days | -0.022 | +0.26% | +0.58% |
| 20 days | -0.018 | +0.63% | +1.19% |

**Rank correlation is indistinguishable from zero at every horizon, and the
highest-scoring longs underperform an unselected entry.** Short setups lost
money in every bucket, which is partly a ten-year bull sample, but the score
does not order those outcomes either (rho -0.03).

Two honest caveats, neither of which rescues the result. Sampling every 10
bars with a 20-day horizon produces overlapping windows, so the effective
sample is far smaller than the raw count and the error bars are wide. And the
score was built to rank *tradeability* - a defined trigger, stop and target -
while this test holds blindly for N days, ignoring both the stop and the
target. A trigger/stop/target simulation is the fairer test and has not been
run.

What the finding does support: treat the scores as a **filter and a
checklist**, not a forecast. They are good at catching things worth avoiding -
implied vol below realised, a target that cannot clear the breakeven, a stop
inside the spread, an entry already spent. There is no evidence they rank what
will go up.

## The fair test: trigger, stop, target

`node tools/backtest-trades.mjs [universe] [maxHoldBars] [maxWaitBars]`

Trades the setup as specified instead of holding blindly: wait for the
trigger, enter there, exit at the stop or the target, measure in R. One
position per symbol at a time, so the trades are independent. Where intrabar
order is unknowable the stop is assumed to have hit first, and entries fill at
the trigger or the gap open - never the better of the two.

| Score | Long expectancy | Long win% | Short expectancy | Short win% |
|---|---|---|---|---|
| < 40 | 0.130R | 84.7% | 0.056R | 76.6% |
| 40-49 | 0.134R | 83.2% | 0.041R | 71.7% |
| 50-59 | 0.133R | 69.6% | -0.155R | 56.6% |
| 60-69 | 0.141R | 54.6% | 0.082R | 47.9% |
| 70+ | **0.246R** | 38.0% | **-0.202R** | 26.1% |
| all | 0.147R | 71.7% | -0.008R | 65.0% |

Better news than the naive test, and still not an endorsement.

**What the score actually selects is reward-to-risk geometry, not direction.**
Win rate falls monotonically with score (84.7% to 38.0%) because a higher
score means a wider target relative to the stop - easy to see in the stop-out
column, which climbs from 13% to 60%. Expectancy is roughly flat across the
first four buckets at about 0.13R.

The one positive signal is the top long bucket at 0.246R, but n=237 and the
variance of R is large enough that it overlaps the baseline; it is suggestive,
not established. **Short setups are the clear negative: rank correlation
-0.14, and the highest-scoring shorts lost 0.202R at a 26% win rate.** Treat a
high short score as a reason for scepticism, not conviction.

Two further qualifications. No costs are modelled - commission and slippage
would consume a meaningful share of a 0.13R edge. And the sample is a decade
that mostly went up, which flatters every long and punishes every short.

One finding is actionable as it stands: entries on a **confirmed** break
returned 0.090R against 0.054R for entries waiting on a trigger cross.

## How much to trust the option scores

The arithmetic is verified. An audit recomputes every derived figure
independently from the raw chain - premium sourced from the bid when selling
and the ask when buying, breakeven, collateral, annualised return, assignment
basis, delta signs, breach direction - and all of it reconciles.

**The weights are not validated.** They are hand-set from trading principles,
never fitted to outcomes, and no backtest has been run. A sensitivity test
re-scores each panel 400 times with every component weight jittered at random:

| Panel | top pick survives +/-15% | survives +/-50% |
|---|---|---|
| Covered calls | 97% | 43% |
| Cash-secured puts | 69% | 34% |
| Buying calls | every strike ties | - |

Read that as: the *region* is robust and the *single winner* often is not. The
panels now flag strikes within 4 points of the top as a tied band rather than
implying a ranking that the weights cannot support.

The buying-calls panel is the weakest discriminator by design - its dominant
terms (the volatility gate, target plausibility) are properties of the
underlying, identical across every strike, so it answers "should I buy calls on
this at all" far better than "which strike".

## The contract scanner: expected value instead of a score

`/api/opscan`, the **Find contracts** button. Hand-weighted scores are
tolerable once you have picked a symbol and are reading the reasoning. They are
not tolerable as a basis for ranking forty-four symbols against each other,
because the errors compound instead of cancelling and nothing on screen says
which comparisons are real. So this scanner never consults them.

It ranks on one quantity with an observable counterpart: **premium received
minus the contract's fair value**, where fair value is the expected payoff
under the asset's own return distribution. Writers are credited at the bid and
buyers charged the ask. Expressed per dollar of capital committed and
annualised, that number is comparable across strikes, expiries, symbols and
strategies - which no score ever was.

Hard gates come first, because a condition that makes a trade bad regardless of
everything else must not be tradeable against other factors the way a weighted
sum allows: implied volatility must beat the forecast to write (or sit below it
to buy), spreads under 15% and 50+ open interest, and enough independent
observations beyond the strike to price it at all.

### What the calibration test settled

`node tools/validate-expectancy.mjs [universe] [dte] [stepBars]` walks history,
builds each distribution from only the bars up to the decision date, and
compares predicted P(finishing beyond the strike) against what happened. Three
findings, two of which killed a design:

**1. Current realised vol is a biased forecast.** Over 10,914 decision points
forward vol arrived at 1.195x the current-vol blend, and 1.39x in the quietest
quintile. Every IV-versus-RV screener that compares implied to *current*
realised - including this app's own three panels - overstates the variance risk
premium. Correcting it cut calibration error from 4.15 to 2.16 points.

**2. The empirical distribution's fat tails are worth almost nothing.** Per
strike it calibrates at 4.00 points against 4.20 for a plain lognormal at the
same width. Ten years of pooled returns mixes calm and crisis regimes, and most
of the resulting kurtosis is that mixing rather than a property of any one
forward month. The real distribution is kept because it is marginally ahead and
yields a CVaR measured from actual drawdowns - not because it prices better.

**3. Drift is the dominant error term, by a factor of two.**

| drift assumption | per-strike calibration error |
|---|---|
| zero | 4.00 pts |
| risk-free, contemporaneous | 2.95 pts |
| 8%/yr | 2.00 pts |
| the sample's own realised drift | 1.37 pts (unattainable) |

The risk-free rate is used. 8%/yr scores better only because the sample rose
16%/yr, and adopting it would repeat the exact error the setup-score backtest
already caught. The honest cost: in a rising market this **under-states** the
chance a short call is breached, which is the optimistic direction for a call
writer. The scanner says so on screen.

### The volatility forecast

`node tools/fit-volforecast.mjs` fits it, on the first half of each symbol's
history, scored on the second. Three specifications, two rejected:

| specification | out-of-sample MAE | cross-symbol bias spread |
|---|---|---|
| blend + flat multiplier | 6.67 | 0.341 |
| full regression per symbol | 7.32 | 0.382 |
| **shared log slope + per-symbol bias constant** | **6.17** | **0.170** |

The flat multiplier failed in a diagnosable way: it pushed SPY's forecast 18%
above reality and deleted SPY's variance risk premium, which hid the most
reliable premium in the universe. Full per-symbol regressions overfit - the
fitted slope collapsed to 0.36 on BTC, which is noise, not mean reversion.

The bias *spread* is the number that matters for a scanner, more than accuracy:
a forecast biased the same way everywhere still ranks correctly, while one
biased differently per symbol invents premium on the names it runs cold on and
hides it on the names it runs hot on.

### The earnings guard, at last

The volatility forecast is built from price history and cannot see a scheduled
earnings date. When it cannot, implied vol sits far above the forecast and the
model reports the gap as edge - and because the gap scales with the size of the
event, **contaminated names sort to the top**. The first run of this scanner put
NVDA first at a claimed 46% edge with earnings inside the tenor.

Yahoo's earnings endpoint now requires a session crumb, so the event is read out
of the chain instead. Forward implied variance between consecutive expiries
isolates the volatility priced for just that interval, and an interval that
spikes above the rest of the term is the market pointing at a date:

```
NVDA   2.52x   118.6% forward IV over 11-16 -> 11-18   (reports 11-18)
AVGO   1.63x    78.5% forward IV over 12-04 -> 12-11   (reports ~12-10)
SPY    1.21x
TLT    1.06x
```

It flagged 2 of 11 single names, which is the right count rather than a miss:
the other nine had already reported, so their next earnings falls outside the
tenor. Flagged chains are held out of the ranking and listed separately with
the window, not dropped - the premium is real, it is just not free.

This catches event premium large enough to stand out of the term structure, not
every scheduled event. Singles run a median kink of 1.27x and broad ETFs 1.16x,
so the populations overlap and a small earnings premium passes through.

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
- **No ex-dividend calendar.** Check it before selling a call that spans one.
  Earnings are now caught by the term-structure detector in the contract
  scanner, but only when the premium is large enough to show; the three
  per-symbol panels have no such guard at all.
- **The contract scanner's three panels and the scanner itself will disagree.**
  That is intended. The panels compare implied volatility to *current* realised
  vol, which the calibration test showed overstates the variance risk premium
  by around 19%. The scanner uses the corrected forecast. Where they conflict,
  the scanner has the measurement behind it.
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
  data/rates.js        short risk-free rate, the drift assumption for valuation
  options/vol.js       realised vol, IV/RV, expected move, historical breach,
                       fitted forward-vol forecast, term-structure event detector
  options/expectancy.js  empirical fair value: distribution, EV, tail risk
  options/opscan.js    contract scanner - hard gates, then EV ranking
  options/covered.js   call strike scoring, thesis conflict check, panel verdict
  options/puts.js      put strike scoring, assignment-basis test, skew read
  options/longcalls.js premium-buying: inverted vol gate, breakeven vs target
  scan.js              universe definitions, setup scoring, long/short ranking
  ta/indicators.js     SMA/EMA/RSI/MACD/ATR/Bollinger/ADX/correlation/linreg
  ta/structure.js      pivots, swing structure, S/R, trendlines, channels, volume profile
  ta/patterns.js       formation detection, staleness filtering
  ta/technical.js      orchestration, regime, bias score, seasonality
  macro/profiles.js    asset classification and per-class factor weights + signs
  macro/factors.js     factor readings from market and economic data
  macro/macro.js       correlation-adjusted weighting and macro score
  tools/validate-expectancy.mjs  out-of-sample calibration of the valuer
  tools/fit-volforecast.mjs      fits the forward-vol forecast, train/test split
  tools/backtest-setups.mjs      walk-forward test of the setup score
  tools/backtest-trades.mjs      trigger/stop/target simulation, results in R
public/                UI, canvas chart with pattern overlays
```
