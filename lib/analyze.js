// Composite engine: runs the technical read and the macro read, then combines
// them into one view with the disagreements kept visible rather than averaged
// away.
import { fetchSeries } from './data/yahoo.js';
import { analyzeTechnicals } from './ta/technical.js';
import { analyzeMacro } from './macro/macro.js';

// How much the macro layer should matter, by timeframe. Nothing in the yield
// curve tells you where a 5-minute bar goes; on a weekly chart it is most of
// the story.
const MACRO_WEIGHT = {
  '5m': 0.05,
  '15m': 0.08,
  '1h': 0.15,
  '4h': 0.25,
  '1d': 0.40,
  '1w': 0.55,
  '1M': 0.65,
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function buildAssetContext(technical) {
  const ctx = {};

  const s = technical.seasonality?.current;
  if (s && s.avg != null && s.samples >= 5) {
    // Blend the average return with the hit rate so a single outlier year
    // cannot manufacture a signal.
    const fromAvg = Math.max(-1, Math.min(1, s.avg / 3));
    const fromWin = (s.winRate - 50) / 50;
    ctx.seasonalityStance = Number((fromAvg * 0.6 + fromWin * 0.4).toFixed(3));
    ctx.seasonalityDetail =
      `${MONTHS[s.month]} has averaged ${s.avg > 0 ? '+' : ''}${s.avg}% across ${s.samples} years, ` +
      `positive ${s.winRate}% of the time.`;
  }

  const { sma200 } = technical.movingAverages;
  const { atr } = technical.volatility;
  if (sma200 && atr) {
    // Distance from the long-term average, in ATR units - comparable across
    // assets with very different volatility.
    const distATR = (technical.price.last - sma200) / atr;
    ctx.stretchStance = Number(Math.max(-1, Math.min(1, distATR / 8)).toFixed(3));
    ctx.stretchDetail =
      `Price is ${Math.abs(distATR).toFixed(1)} ATR ${distATR > 0 ? 'above' : 'below'} its 200-period average ` +
      `(${(((technical.price.last - sma200) / sma200) * 100).toFixed(1)}%).`;
  }

  return ctx;
}

function verdictLabel(score) {
  if (score >= 55) return 'Strongly constructive';
  if (score >= 25) return 'Constructive';
  if (score >= 8) return 'Mildly constructive';
  if (score > -8) return 'Neutral / two-sided';
  if (score > -25) return 'Mildly negative';
  if (score > -55) return 'Negative';
  return 'Strongly negative';
}

// The levels and readings that would break the current thesis. This is the
// part a trader actually acts on.
function buildInvalidation(technical, macro) {
  const out = [];
  const best = technical.patterns[0];
  if (best) {
    out.push({
      type: 'level',
      text: `${best.name} fails if price ${best.direction === 'bearish' ? 'reclaims' : 'loses'} ${best.invalidation != null ? best.invalidation.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : 'the pattern extreme'}.`,
    });
    if (best.stage === 'forming' && best.trigger != null) {
      out.push({
        type: 'trigger',
        text: `The formation only becomes actionable on a close ${best.direction === 'bearish' ? 'below' : 'above'} ${best.trigger.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} (${best.triggerLabel}).`,
      });
    }
  }

  const support = technical.levels.find((l) => l.type === 'support');
  const resistance = technical.levels.find((l) => l.type === 'resistance');
  if (support) out.push({ type: 'level', text: `Nearest support ${support.price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}, ${Math.abs(support.distancePct).toFixed(1)}% below, tested ${support.touches} times.` });
  if (resistance) out.push({ type: 'level', text: `Nearest resistance ${resistance.price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}, ${Math.abs(resistance.distancePct).toFixed(1)}% above, tested ${resistance.touches} times.` });

  // Two different questions: which factor carries the most weight for this
  // asset, and which is actually pushing the score right now. Report both.
  const heaviest = [...macro.factors].sort((a, b) => b.weight - a.weight)[0];
  const driver = macro.factors[0];
  if (heaviest) {
    out.push({
      type: 'macro',
      text: `${heaviest.label} carries the most weight for this asset (${(heaviest.weight * 100).toFixed(0)}% of the macro model), so a turn there changes the thesis more than anything else.`,
    });
  }
  if (driver && driver.id !== heaviest?.id) {
    out.push({
      type: 'macro',
      text: `The biggest live contributor is ${driver.label.toLowerCase()} at ${driver.contribution > 0 ? '+' : ''}${driver.contribution} points, despite carrying only ${(driver.weight * 100).toFixed(0)}% of the weight.`,
    });
  }
  return out;
}

export async function runAnalysis({ symbol, timeframe = '1d', skipMacro = false }) {
  const series = await fetchSeries(symbol, timeframe);
  const technical = analyzeTechnicals(series);
  const assetContext = buildAssetContext(technical);

  const macro = skipMacro
    ? null
    // Hand the daily bars straight to the macro layer so it does not re-fetch
    // closes we already have. Only valid when these ARE daily bars; on an
    // intraday timeframe it falls back to fetching its own.
    : await analyzeMacro(
        series.symbol,
        series.meta,
        assetContext,
        timeframe === '1d' ? series.bars : null
      );

  const macroWeight = macro ? MACRO_WEIGHT[timeframe] ?? 0.4 : 0;
  const techWeight = 1 - macroWeight;
  const composite = Math.round(technical.score * techWeight + (macro?.score ?? 0) * macroWeight);

  // Agreement between the two lenses is itself information: when they point
  // the same way the signal is worth more than either alone.
  let alignment = 'no macro layer';
  if (macro) {
    const both = technical.score * macro.score;
    const spread = Math.abs(technical.score - macro.score);
    if (both > 0 && spread < 45) alignment = 'aligned';
    else if (both < 0 && spread > 45) alignment = 'conflicted';
    else alignment = 'mixed';
  }

  return {
    symbol: series.symbol,
    requestedSymbol: symbol,
    name: series.meta.name,
    exchange: series.meta.exchange,
    currency: series.meta.currency,
    timeframe,
    timeframeLabel: series.timeframeLabel,
    generatedAt: new Date().toISOString(),
    barCount: series.bars.length,
    partialLastBar: Boolean(series.partialLastBar),
    technical,
    macro,
    composite: {
      score: composite,
      label: verdictLabel(composite),
      technicalScore: technical.score,
      macroScore: macro?.score ?? null,
      macroWeight,
      techWeight,
      alignment,
    },
    invalidation: buildInvalidation(technical, macro || { factors: [] }),
  };
}
