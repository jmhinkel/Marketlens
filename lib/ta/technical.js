// Assembles the full technical picture and reduces it to a single bias score
// with an auditable list of contributions.
import {
  sma, ema, rsi, macd, atr, bollinger, adx, percentileRank, pctChange, linreg,
} from './indicators.js';
import { findPivots, pivotWidth, swingStructure, supportResistance, volumeProfile } from './structure.js';
import { detectPatterns } from './patterns.js';

// Month-of-year statistics from the asset's own history. Only meaningful on
// daily or slower bars with a few years behind them.
export function seasonality(bars, timeframe) {
  if (!['1d', '1w', '1M'].includes(timeframe) || bars.length < 400) return null;
  const monthly = new Map();
  let cursor = null;

  for (const b of bars) {
    const d = new Date(b.time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (!cursor || cursor.key !== key) {
      if (cursor) monthly.set(cursor.key, cursor);
      cursor = { key, month: d.getUTCMonth(), open: b.open, close: b.close };
    } else {
      cursor.close = b.close;
    }
  }
  if (cursor) monthly.set(cursor.key, cursor);

  const byMonth = Array.from({ length: 12 }, () => []);
  for (const m of monthly.values()) {
    if (!m.open) continue;
    byMonth[m.month].push(((m.close - m.open) / m.open) * 100);
  }

  const stats = byMonth.map((rets, i) => {
    if (rets.length < 3) return { month: i, samples: rets.length, avg: null, winRate: null };
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const wins = rets.filter((r) => r > 0).length;
    return {
      month: i,
      samples: rets.length,
      avg: Number(avg.toFixed(2)),
      winRate: Math.round((100 * wins) / rets.length),
    };
  });

  const current = stats[new Date().getUTCMonth()];
  return { byMonth: stats, current };
}

// How many bars of chart the formation search looks at. Indicators still use
// the full history (a 200-period average needs its warm-up), but pattern
// recognition should only see what a trader would have on screen - otherwise
// it surfaces shapes from years ago that no longer matter.
const VIEW_BARS = 320;

export function analyzeTechnicals(series) {
  const { bars, timeframe, timeframeLabel } = series;
  const closes = bars.map((b) => b.close);
  const last = closes.at(-1);
  const viewBars = bars.slice(-Math.min(VIEW_BARS, bars.length));
  const viewOffset = bars.length - viewBars.length;

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);
  const atr14 = atr(bars, 14);
  const bb = bollinger(closes, 20, 2);
  const adxData = adx(bars, 14);

  const atrNow = atr14.at(-1);
  const atrPct = atrNow ? (atrNow / last) * 100 : null;
  const bbWidthNow = bb.width.at(-1);
  // A squeeze is band width in the bottom fifth of its own recent history -
  // the classic pre-expansion condition.
  const bbWidthPct = bbWidthNow != null ? percentileRank(bb.width.slice(-250), bbWidthNow) : null;
  const adxNow = adxData.adx.at(-1);

  // Structure, levels and formations are all read off the view window, so
  // every index in the output lines up with the chart the UI draws.
  const width = pivotWidth(viewBars.length);
  const pivots = findPivots(viewBars, width, width);
  const structure = swingStructure(pivots);
  const levels = supportResistance(viewBars, pivots);
  const { patterns, stale, channel, candles } = detectPatterns(viewBars, pivots);
  const profile = volumeProfile(viewBars.slice(-180));

  // Moving average alignment is a compact read on trend across timescales.
  const maStack = [];
  if (ma20.at(-1) != null) maStack.push({ label: 'SMA 20', value: ma20.at(-1) });
  if (ma50.at(-1) != null) maStack.push({ label: 'SMA 50', value: ma50.at(-1) });
  if (ma200.at(-1) != null) maStack.push({ label: 'SMA 200', value: ma200.at(-1) });

  const above = maStack.filter((m) => last > m.value).length;
  const bullStack =
    ma20.at(-1) != null && ma50.at(-1) != null && ma200.at(-1) != null &&
    ma20.at(-1) > ma50.at(-1) && ma50.at(-1) > ma200.at(-1);
  const bearStack =
    ma20.at(-1) != null && ma50.at(-1) != null && ma200.at(-1) != null &&
    ma20.at(-1) < ma50.at(-1) && ma50.at(-1) < ma200.at(-1);

  // Slope of the 200 MA over the last 40 bars, as % per 100 bars.
  const ma200Slope = (() => {
    const tail = ma200.slice(-40).filter((v) => v != null);
    if (tail.length < 20) return null;
    const fit = linreg(tail.map((v, i) => [i, v]));
    return fit ? (fit.slope / last) * 100 * 100 : null;
  })();

  // ATR as % of price, over the last 250 bars, with warm-up nulls dropped so
  // they cannot skew the percentile.
  const atrPctHistory = atr14
    .map((v, i) => (v == null ? null : (v / closes[i]) * 100))
    .slice(-250)
    .filter((v) => v != null);
  const atrPercentile = atrPct != null ? percentileRank(atrPctHistory, atrPct) : null;

  let regime = 'ranging';
  if (adxNow != null && adxNow >= 25) regime = 'trending';
  if (bbWidthPct != null && bbWidthPct < 20) regime = 'compressed (squeeze)';
  if (atrPercentile != null && atrPercentile > 85) regime = 'high volatility';

  // --- Bias score: every contribution is named so the output can be audited.
  const contributions = [];
  const add = (label, points, detail) => contributions.push({ label, points, detail });

  if (bullStack) add('Moving average stack', 14, '20 > 50 > 200 - full bullish alignment');
  else if (bearStack) add('Moving average stack', -14, '20 < 50 < 200 - full bearish alignment');
  else add('Moving average stack', (above - maStack.length / 2) * 5, `Price above ${above} of ${maStack.length} averages`);

  if (ma200Slope != null) {
    add('Long-term trend slope', Math.max(-10, Math.min(10, ma200Slope * 1.2)),
      `200-period average sloping ${ma200Slope >= 0 ? 'up' : 'down'} (${ma200Slope.toFixed(1)}% per 100 bars)`);
  }

  const trendPoints = { uptrend: 16, 'uptrend-weakening': 6, contracting: 0, expanding: 0, indeterminate: 0, 'downtrend-weakening': -6, downtrend: -16 };
  add('Swing structure', trendPoints[structure.trend] ?? 0, structure.detail);

  const r = rsi14.at(-1);
  if (r != null) {
    // RSI is scored as momentum bias, with the extremes damped rather than
    // flipped - overbought in a strong trend is not a sell signal by itself.
    let pts = ((r - 50) / 50) * 12;
    if (r > 78) pts *= 0.4;
    if (r < 22) pts *= 0.4;
    add('RSI(14)', pts, `${r.toFixed(1)} - ${r > 70 ? 'overbought' : r < 30 ? 'oversold' : r > 55 ? 'firm' : r < 45 ? 'soft' : 'neutral'}`);
  }

  const hist = macdData.hist.at(-1);
  const histPrev = macdData.hist.at(-4);
  if (hist != null) {
    const rising = histPrev != null && hist > histPrev;
    add('MACD histogram', (hist > 0 ? 8 : -8) + (rising ? 3 : -3),
      `${hist > 0 ? 'Above' : 'Below'} signal and ${rising ? 'expanding' : 'contracting'}`);
  }

  const best = patterns[0];
  if (best) {
    const weight = (best.confidence / 100) * (best.stage === 'confirmed' ? 26 : 15);
    const sign = best.direction === 'bullish' ? 1 : best.direction === 'bearish' ? -1 : 0;
    add('Chart formation', sign * weight, `${best.name} (${best.stage}, ${best.confidence}% confidence)`);
  }

  if (channel) {
    // Position inside a channel is a mean-reversion input: near the top is a
    // poor place to add, near the bottom is where the trend usually resumes.
    const pos = channel.positionInChannel;
    const pts = ((50 - pos) / 50) * 6;
    add('Channel position', pts, `${pos.toFixed(0)}% of the way up a ${channel.direction} channel`);
  }

  const nearestSupport = levels.filter((l) => l.type === 'support')[0];
  const nearestResistance = levels.filter((l) => l.type === 'resistance')[0];
  if (nearestSupport && nearestResistance) {
    const room = Math.abs(nearestResistance.distancePct) - Math.abs(nearestSupport.distancePct);
    add('Level asymmetry', Math.max(-8, Math.min(8, room * 1.5)),
      `${Math.abs(nearestSupport.distancePct).toFixed(1)}% to support, ${Math.abs(nearestResistance.distancePct).toFixed(1)}% to resistance`);
  }

  const raw = contributions.reduce((s, c) => s + c.points, 0);
  const score = Math.max(-100, Math.min(100, Math.round(raw * 1.15)));

  return {
    timeframe,
    timeframeLabel,
    price: {
      last,
      change1: pctChange(closes, 1),
      change5: pctChange(closes, 5),
      change20: pctChange(closes, 20),
      change60: pctChange(closes, 60),
      high52: Math.max(...closes.slice(-252)),
      low52: Math.min(...closes.slice(-252)),
    },
    movingAverages: {
      sma20: ma20.at(-1), sma50: ma50.at(-1), sma200: ma200.at(-1), ema21: ema21.at(-1),
      bullStack, bearStack, aboveCount: above, total: maStack.length, slope200: ma200Slope,
    },
    momentum: {
      rsi: r,
      macd: { line: macdData.line.at(-1), signal: macdData.signal.at(-1), hist },
      adx: adxNow,
      plusDI: adxData.plusDI.at(-1),
      minusDI: adxData.minusDI.at(-1),
    },
    volatility: {
      atr: atrNow, atrPct, atrPercentile, bbWidth: bbWidthNow, bbWidthPercentile: bbWidthPct,
      upper: bb.upper.at(-1), lower: bb.lower.at(-1), squeeze: bbWidthPct != null && bbWidthPct < 20,
    },
    regime,
    structure,
    levels,
    patterns,
    stalePatterns: stale,
    channel,
    candles,
    volumeProfile: profile,
    seasonality: seasonality(bars, timeframe),
    score,
    contributions: contributions.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    pivots: {
      highs: pivots.highs.slice(-12),
      lows: pivots.lows.slice(-12),
    },
    // The chart window plus the indicator series clipped to match it, so the
    // front end can draw candles and overlays off one index space.
    view: {
      offset: viewOffset,
      bars: viewBars,
      sma20: ma20.slice(viewOffset),
      sma50: ma50.slice(viewOffset),
      sma200: ma200.slice(viewOffset),
      bbUpper: bb.upper.slice(viewOffset),
      bbLower: bb.lower.slice(viewOffset),
      rsi: rsi14.slice(viewOffset),
      macdHist: macdData.hist.slice(viewOffset),
    },
  };
}
