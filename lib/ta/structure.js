// Market structure: pivots, swing sequence, horizontal levels, trendlines and
// channels. Everything downstream (pattern recognition, targets, risk levels)
// is built from the pivot list this module produces.
import { atr, linreg } from './indicators.js';

// A pivot high is a bar whose high is not exceeded by the `left` bars before it
// or the `right` bars after it. The `right` requirement is why the most recent
// bars can never be pivots yet - they are unconfirmed.
export function findPivots(bars, left = 3, right = 3) {
  const highs = [];
  const lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high, time: bars[i].time, kind: 'high' });
    if (isLow) lows.push({ index: i, price: bars[i].low, time: bars[i].time, kind: 'low' });
  }
  const all = [...highs, ...lows].sort((a, b) => a.index - b.index);
  return { highs, lows, all };
}

// Adaptive pivot width: enough sensitivity to see the shape, not so much that
// every wiggle becomes a swing. Scales with how many bars we are looking at.
export function pivotWidth(barCount) {
  if (barCount < 120) return 3;
  if (barCount < 300) return 4;
  if (barCount < 700) return 5;
  return 6;
}

// Classify the swing sequence into a trend label using the last few confirmed
// pivots. Higher highs + higher lows = uptrend, and so on.
export function swingStructure(pivots) {
  const highs = pivots.highs.slice(-3);
  const lows = pivots.lows.slice(-3);
  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'indeterminate', detail: 'Not enough confirmed swings to read structure.' };
  }
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;

  if (hh && hl) return { trend: 'uptrend', detail: 'Higher highs and higher lows.' };
  if (lh && ll) return { trend: 'downtrend', detail: 'Lower highs and lower lows.' };
  if (lh && hl) return { trend: 'contracting', detail: 'Lower highs into higher lows - range compressing.' };
  if (hh && ll) return { trend: 'expanding', detail: 'Higher highs and lower lows - volatility expanding.' };
  if (hh || hl) return { trend: 'uptrend-weakening', detail: 'Upward structure intact but one leg failed to extend.' };
  return { trend: 'downtrend-weakening', detail: 'Downward structure intact but one leg failed to extend.' };
}

// Cluster pivot prices into horizontal levels. Tolerance is ATR-based so it
// adapts to the instrument instead of using a fixed percentage.
export function supportResistance(bars, pivots, maxLevels = 6) {
  const a = atr(bars, 14).at(-1) || bars.at(-1).close * 0.01;
  const tolerance = a * 0.9;
  const last = bars.at(-1).close;
  const points = pivots.all.map((p) => ({ ...p }));
  const clusters = [];

  for (const p of points) {
    const hit = clusters.find((c) => Math.abs(c.price - p.price) <= tolerance);
    if (hit) {
      hit.members.push(p);
      hit.price = hit.members.reduce((s, m) => s + m.price, 0) / hit.members.length;
    } else {
      clusters.push({ price: p.price, members: [p] });
    }
  }

  const newestIndex = bars.length - 1;
  return clusters
    .map((c) => {
      const touches = c.members.length;
      // Recency weighting: a level touched last month matters more than one
      // touched two years ago.
      const recency = Math.max(...c.members.map((m) => m.index)) / newestIndex;
      const distancePct = ((c.price - last) / last) * 100;
      return {
        price: c.price,
        touches,
        lastTouchTime: Math.max(...c.members.map((m) => m.time)),
        type: c.price > last ? 'resistance' : 'support',
        distancePct,
        strength: Math.min(100, Math.round(touches * 22 + recency * 35)),
      };
    })
    .filter((l) => l.touches >= 2 || Math.abs(l.distancePct) < 6)
    .sort((a2, b2) => Math.abs(a2.distancePct) - Math.abs(b2.distancePct))
    .slice(0, maxLevels);
}

// Fit a sloped line to pivots. For resistance we want the line that sits on top
// of the highs (few violations); for support, underneath the lows.
export function fitTrendline(bars, pivotList, kind, minTouches = 3) {
  if (pivotList.length < minTouches) return null;
  const recent = pivotList.slice(-6);
  const a = atr(bars, 14).at(-1) || bars.at(-1).close * 0.01;
  let best = null;

  // Try every pair of pivots as the anchor line, then count how many other
  // pivots sit close to it and how many bars violate it.
  for (let i = 0; i < recent.length - 1; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const p1 = recent[i];
      const p2 = recent[j];
      if (p2.index === p1.index) continue;
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      const intercept = p1.price - slope * p1.index;
      const at = (idx) => slope * idx + intercept;

      let touches = 0;
      for (const p of recent) {
        if (Math.abs(p.price - at(p.index)) <= a * 0.75) touches++;
      }
      if (touches < minTouches) continue;

      let violations = 0;
      for (let k = p1.index; k < bars.length; k++) {
        const line = at(k);
        if (kind === 'resistance' && bars[k].close > line + a * 0.5) violations++;
        if (kind === 'support' && bars[k].close < line - a * 0.5) violations++;
      }
      const span = p2.index - p1.index;
      const score = touches * 10 + span / 10 - violations * 2;
      if (!best || score > best.score) {
        best = { kind, slope, intercept, touches, violations, fromIndex: p1.index, score, span };
      }
    }
  }
  if (!best) return null;

  const priceAt = (idx) => best.slope * idx + best.intercept;
  const lastIdx = bars.length - 1;
  return {
    kind: best.kind,
    touches: best.touches,
    slopePerBar: best.slope,
    // Slope expressed as % of price per 100 bars - comparable across assets.
    slopePct: (best.slope / bars.at(-1).close) * 100 * 100,
    startIndex: best.fromIndex,
    startPrice: priceAt(best.fromIndex),
    endIndex: lastIdx,
    currentValue: priceAt(lastIdx),
    project: priceAt,
    quality: Math.min(100, Math.round(best.touches * 18 + Math.min(best.span, 200) / 4 - best.violations * 3)),
  };
}

// A channel is a support and resistance trendline running roughly parallel.
export function detectChannel(bars, pivots) {
  const upper = fitTrendline(bars, pivots.highs, 'resistance', 2);
  const lower = fitTrendline(bars, pivots.lows, 'support', 2);
  if (!upper || !lower) return null;
  const last = bars.at(-1).close;
  const top = upper.currentValue;
  const bottom = lower.currentValue;
  if (top <= bottom) return null;

  // Parallel enough? Compare slopes relative to the channel's own height.
  const height = top - bottom;
  const slopeDiff = Math.abs(upper.slopePerBar - lower.slopePerBar);
  const parallel = slopeDiff < (height / Math.max(bars.length * 0.3, 30)) * 1.5;
  if (!parallel) return null;

  const position = ((last - bottom) / height) * 100;
  const avgSlope = (upper.slopePerBar + lower.slopePerBar) / 2;
  const slopePct = (avgSlope / last) * 100 * 100;
  let direction = 'horizontal';
  if (slopePct > 3) direction = 'rising';
  else if (slopePct < -3) direction = 'falling';

  return {
    direction,
    top,
    bottom,
    heightPct: (height / last) * 100,
    positionInChannel: position,
    upper,
    lower,
    quality: Math.round((upper.quality + lower.quality) / 2),
  };
}

// Volume-at-price histogram - shows where real trading happened, which is a
// different (and often better) map of support than pivots alone.
export function volumeProfile(bars, buckets = 24) {
  const hasVolume = bars.some((b) => b.volume > 0);
  if (!hasVolume) return null;
  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  if (hi <= lo) return null;
  const size = (hi - lo) / buckets;
  const bins = new Array(buckets).fill(0);

  for (const b of bars) {
    // Spread each bar's volume across the buckets its range covers.
    const startBin = Math.max(0, Math.floor((b.low - lo) / size));
    const endBin = Math.min(buckets - 1, Math.floor((b.high - lo) / size));
    const spread = endBin - startBin + 1;
    for (let i = startBin; i <= endBin; i++) bins[i] += b.volume / spread;
  }

  const total = bins.reduce((s, v) => s + v, 0);
  const pocIndex = bins.indexOf(Math.max(...bins));

  // Value area: expand out from the point of control until 70% of volume is
  // enclosed - the zone the market accepted as fair.
  let lower = pocIndex;
  let upper = pocIndex;
  let acc = bins[pocIndex];
  while (acc < total * 0.7 && (lower > 0 || upper < buckets - 1)) {
    const below = lower > 0 ? bins[lower - 1] : -1;
    const above = upper < buckets - 1 ? bins[upper + 1] : -1;
    if (above >= below) acc += bins[++upper];
    else acc += bins[--lower];
  }

  return {
    pointOfControl: lo + (pocIndex + 0.5) * size,
    valueAreaLow: lo + lower * size,
    valueAreaHigh: lo + (upper + 1) * size,
    bins: bins.map((v, i) => ({ price: lo + (i + 0.5) * size, volume: v })),
  };
}
