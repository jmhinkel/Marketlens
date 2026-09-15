// Opportunity scanner: ranks a universe by how good the SETUP is right now,
// long and short, rather than by how bullish or bearish the asset looks.
//
// Those are different questions. A strongly trending asset with no defined
// entry and no invalidation level is a poor setup even though the direction is
// obvious; a coiled range with a formation one ATR from its trigger is a good
// setup even if the directional edge is modest. What makes something tradeable
// is a level to act on, a level that says you were wrong, and a payoff worth
// the risk.
//
// Two stages, for speed: a technical-only pass over the whole universe (one
// upstream call per symbol), then the full macro model on the finalists only.
import { runAnalysis } from './analyze.js';
import { cached } from './cache.js';

export const UNIVERSES = {
  core: {
    label: 'Core',
    note: 'Liquid, diversified cross-section: index, sector, commodity, rates and crypto.',
    symbols: [
      'SPY', 'QQQ', 'IWM', 'EEM', 'EFA',
      'XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLU', 'SMH', 'KRE', 'XBI',
      'GLD', 'SLV', 'GDX', 'COPX', 'USO', 'UNG',
      'HG=F', 'GC=F', 'CL=F', 'ZC=F',
      'TLT', 'HYG',
      'BTC-USD', 'ETH-USD',
    ],
  },
  wide: {
    label: 'Wide',
    note: 'Core plus megacap equities, more sectors, FX and additional commodities.',
    symbols: [
      'SPY', 'QQQ', 'IWM', 'DIA', 'EEM', 'EFA', 'FXI', 'EWZ', 'EWJ',
      'XLE', 'XLF', 'XLI', 'XLK', 'XLV', 'XLU', 'XLP', 'XLY', 'XLB', 'XLRE',
      'SMH', 'KRE', 'XBI', 'ITB', 'ARKK',
      'GLD', 'SLV', 'GDX', 'GDXJ', 'COPX', 'CPER', 'USO', 'UNG', 'DBA',
      'HG=F', 'GC=F', 'CL=F', 'SI=F', 'NG=F', 'ZC=F', 'ZW=F',
      'TLT', 'IEF', 'HYG', 'LQD',
      'BTC-USD', 'ETH-USD', 'IBIT', 'MSTR',
      'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'XOM',
      'EURUSD=X', 'USDJPY=X', 'DX-Y.NYB',
    ],
  },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Run an async fn over a list with bounded concurrency. Keeps the upstream
// feeds from being hit with sixty simultaneous requests, which is how you get
// rate limited.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = { ok: true, value: await fn(items[i]) };
        } catch (err) {
          out[i] = { ok: false, symbol: items[i], error: err.message };
        }
      }
    })
  );
  return out;
}

// Score how tradeable a setup is, in a given direction, from a completed
// analysis. Returns null when there is nothing actionable that way.
function scoreSetup(analysis, direction) {
  const t = analysis.technical;
  const price = t.price.last;
  const atr = t.volatility.atr;
  if (!price || !atr) return null;

  const wantBull = direction === 'long';
  const reasons = [];
  let score = 0;

  // --- The formation. A setup without one is just a directional opinion.
  const pattern = (t.patterns || []).find(
    (p) => p.direction === (wantBull ? 'bullish' : 'bearish')
  );

  if (pattern) {
    const stageWeight = pattern.stage === 'confirmed' ? 1 : 0.85;
    score += (pattern.confidence / 100) * 26 * stageWeight;
    reasons.push(
      `${pattern.name} (${pattern.stage}, ${pattern.confidence}% confidence)`
    );

    // Proximity to the trigger is what makes it actionable TODAY. A formation
    // whose trigger is six ATR away is a watchlist item, not a setup.
    if (pattern.trigger != null) {
      const distATR = Math.abs(price - pattern.trigger) / atr;
      if (pattern.stage === 'forming') {
        score += clamp(14 - distATR * 4.5, -8, 14);
        reasons.push(
          distATR < 1.2
            ? `trigger ${pattern.trigger.toFixed(2)} is ${distATR.toFixed(1)} ATR away - close to firing`
            : `trigger ${pattern.trigger.toFixed(2)} is ${distATR.toFixed(1)} ATR away`
        );
      } else {
        // A confirmed break is only a setup while the entry is still near the
        // level. Once price has run several ATR past the trigger the move is
        // largely spent and the stop sits a long way back, so this has to go
        // firmly negative rather than merely stop rewarding.
        const ext = pattern.extensionATR ?? distATR;
        score += clamp(10 - ext * 5, -14, 10);
        const bars = pattern.barsSinceTrigger;
        if (bars != null) {
          // Freshness matters separately from distance: a slow grind 12 bars
          // past the trigger is a different thing from a sharp break today.
          score += clamp(6 - bars * 0.8, -10, 6);
          reasons.push(
            `broke its trigger ${bars} bar${bars === 1 ? '' : 's'} ago, ${ext.toFixed(1)} ATR through`
          );
        }
      }
    }

    // Payoff for the risk taken. Below about 1.2:1 a setup rarely survives a
    // realistic win rate, so sub-par reward:risk is a real drag rather than a
    // small deduction.
    if (pattern.riskReward != null) {
      score += clamp((pattern.riskReward - 1.2) * 9, -14, 16);
      reasons.push(`reward:risk ${pattern.riskReward}:1`);
    }
  } else {
    // No formation in this direction. Still scoreable on trend and structure,
    // but it starts well behind anything that has a defined entry.
    score -= 8;
  }

  // --- Directional conviction from the engine's own bias score.
  const bias = wantBull ? t.score : -t.score;
  score += clamp(bias * 0.26, -20, 20);

  // --- Structure agreement. A bullish formation inside a downtrend is a
  // counter-trend trade and should rank below the same shape with the trend.
  const trend = t.structure?.trend || '';
  const withTrend = wantBull
    ? trend.startsWith('uptrend')
    : trend.startsWith('downtrend');
  const againstTrend = wantBull
    ? trend.startsWith('downtrend')
    : trend.startsWith('uptrend');
  if (withTrend) {
    score += 9;
    reasons.push(`structure is ${trend}, trading with it`);
  } else if (againstTrend) {
    score -= 9;
    reasons.push(`structure is ${trend} - this is counter-trend`);
  }

  // --- Regime. A squeeze with a formation is a coiled spring; a directionless
  // range without one is the worst place to force a trade.
  if (t.volatility?.squeeze) {
    score += pattern ? 8 : 2;
    reasons.push('volatility compressed - bands in the bottom fifth of their range');
  }
  if (t.momentum?.adx != null && t.momentum.adx >= 25) {
    score += 5;
    reasons.push(`ADX ${t.momentum.adx.toFixed(0)} - trending`);
  }

  // --- Room to the next barrier. Selling into support, or buying into
  // resistance, is a worse entry than one with clear air ahead.
  const ahead = (t.levels || []).filter((l) =>
    wantBull ? l.price > price : l.price < price
  );
  if (ahead.length) {
    const nearest = ahead.reduce((m, l) =>
      Math.abs(l.price - price) < Math.abs(m.price - price) ? l : m
    );
    const roomATR = Math.abs(nearest.price - price) / atr;
    score += clamp((roomATR - 1.5) * 2.2, -7, 7);
    if (roomATR < 1) {
      reasons.push(
        `${wantBull ? 'resistance' : 'support'} at ${nearest.price.toFixed(2)} is only ${roomATR.toFixed(1)} ATR away`
      );
    }
  }

  // Rescaled rather than simply offset: with a 50 base the top of the range
  // saturated and half a dozen names tied at 100, which tells you nothing.
  // This keeps genuinely excellent setups in the 80s and leaves the ceiling
  // for something that is strong on every dimension at once.
  return {
    direction,
    score: Math.round(clamp(30 + score * 0.75, 0, 100)),
    pattern: pattern
      ? {
          name: pattern.name,
          stage: pattern.stage,
          confidence: pattern.confidence,
          trigger: pattern.trigger,
          target: pattern.target,
          invalidation: pattern.invalidation,
          riskReward: pattern.riskReward,
          triggerLabel: pattern.triggerLabel,
          distanceToTriggerPct:
            pattern.trigger != null ? ((pattern.trigger - price) / price) * 100 : null,
        }
      : null,
    reasons,
  };
}

// Macro either backs the technical setup or argues with it. Applied in stage
// two, on the finalists only.
function applyMacro(entry, analysis) {
  const macro = analysis.macro;
  if (!macro) return entry;
  const wantBull = entry.direction === 'long';
  const macroFor = wantBull ? macro.score : -macro.score;

  // Deliberately modest: macro sets the backdrop over weeks, while most of
  // these setups resolve in days. It should tilt the ranking, not rewrite it.
  const adj = clamp(macroFor * 0.12, -12, 12);
  const reasons = [...entry.reasons];
  if (Math.abs(macroFor) > 20) {
    reasons.push(
      macroFor > 0
        ? `macro backdrop supports it (${macro.profile.label.toLowerCase()} model reads ${macro.score > 0 ? '+' : ''}${macro.score})`
        : `macro backdrop argues against it (${macro.profile.label.toLowerCase()} model reads ${macro.score > 0 ? '+' : ''}${macro.score})`
    );
  }

  return {
    ...entry,
    score: Math.round(clamp(entry.score + adj, 0, 100)),
    macroScore: macro.score,
    macroProfile: macro.profile.label,
    alignment: analysis.composite.alignment,
    composite: analysis.composite.score,
    reasons,
  };
}

function summarise(analysis, entry) {
  const t = analysis.technical;
  return {
    ...entry,
    symbol: analysis.symbol,
    name: analysis.name,
    price: t.price.last,
    change5: t.price.change5,
    change20: t.price.change20,
    atrPct: t.volatility.atrPct,
    regime: t.regime,
    structure: t.structure?.trend,
    technicalScore: t.score,
    rsi: t.momentum?.rsi,
  };
}

export async function scanUniverse({ universe = 'core', limit = 6, timeframe = '1d' } = {}) {
  const spec = UNIVERSES[universe];
  if (!spec) throw new Error(`Unknown universe: ${universe}`);

  return cached(`scan:${universe}:${timeframe}:${limit}`, 600_000, async () => {
    const started = Date.now();

    // --- Stage 1: technical only, whole universe, one upstream call each.
    const stage1 = await pool(spec.symbols, 12, (symbol) =>
      runAnalysis({ symbol, timeframe, skipMacro: true })
    );

    const failures = [];
    const candidates = [];
    stage1.forEach((r, i) => {
      if (!r.ok) {
        failures.push({ symbol: spec.symbols[i], error: r.error });
        return;
      }
      for (const dir of ['long', 'short']) {
        const setup = scoreSetup(r.value, dir);
        if (setup) candidates.push({ analysis: r.value, setup });
      }
    });

    const byDir = (dir) =>
      candidates
        .filter((c) => c.setup.direction === dir)
        .sort((a, b) => b.setup.score - a.setup.score);

    // --- Stage 2: full macro model, finalists only. Take a few extra so the
    // macro adjustment has room to reorder without running out of names.
    const shortlist = [...byDir('long').slice(0, limit + 3), ...byDir('short').slice(0, limit + 3)];
    const uniqueSymbols = [...new Set(shortlist.map((c) => c.analysis.symbol))];

    const full = new Map();
    const stage2 = await pool(uniqueSymbols, 8, (symbol) =>
      runAnalysis({ symbol, timeframe })
    );
    stage2.forEach((r, i) => {
      if (r.ok) full.set(uniqueSymbols[i], r.value);
    });

    const rank = (dir) =>
      shortlist
        .filter((c) => c.setup.direction === dir)
        .map((c) => {
          const enriched = full.get(c.analysis.symbol);
          const entry = enriched ? applyMacro(c.setup, enriched) : c.setup;
          return summarise(enriched || c.analysis, entry);
        })
        .sort((a, b) => b.score - a.score);

    let longs = rank('long');
    let shorts = rank('short');

    // A chart can genuinely contain both a bullish and a bearish formation -
    // copper often shows a bottoming shape inside a rising wedge. That is
    // honest about the chart but useless as a recommendation, so when a symbol
    // ranks on both sides only the stronger one survives, and it carries a
    // note that the other side is live too.
    const bestShort = new Map(shorts.map((s) => [s.symbol, s.score]));
    const bestLong = new Map(longs.map((s) => [s.symbol, s.score]));
    const twoSided = (entry, otherScore) => ({
      ...entry,
      twoSided: true,
      reasons: [
        ...entry.reasons,
        `the chart also shows a credible ${entry.direction === 'long' ? 'short' : 'long'} formation (scored ${otherScore}) - this is a two-sided chart, not a clean setup`,
      ],
    });

    longs = longs
      .filter((l) => !(bestShort.has(l.symbol) && bestShort.get(l.symbol) > l.score))
      .map((l) => (bestShort.has(l.symbol) ? twoSided(l, bestShort.get(l.symbol)) : l))
      .slice(0, limit);
    shorts = shorts
      .filter((s) => !(bestLong.has(s.symbol) && bestLong.get(s.symbol) >= s.score))
      .map((s) => (bestLong.has(s.symbol) ? twoSided(s, bestLong.get(s.symbol)) : s))
      .slice(0, limit);

    return {
      universe,
      universeLabel: spec.label,
      universeNote: spec.note,
      timeframe,
      generatedAt: new Date().toISOString(),
      scanned: spec.symbols.length - failures.length,
      failed: failures,
      elapsedMs: Date.now() - started,
      longs,
      shorts,
    };
  });
}
