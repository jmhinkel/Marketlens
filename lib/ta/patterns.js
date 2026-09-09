// Chart formation detection, built on the confirmed pivot list.
//
// Every detector returns the same shape so the UI and the scoring engine can
// treat them uniformly:
//   name, direction, stage, confidence, trigger, invalidation, target, lines
//
// stage: 'forming'   - shape is present, trigger level not yet broken
//        'confirmed' - price has broken the trigger level in the pattern's
//                      direction
//        'failed'    - price broke the invalidation level instead
import { atr, linreg } from './indicators.js';
import { fitTrendline, detectChannel } from './structure.js';

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

// Two prices "equal" within a tolerance expressed in ATR units.
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// Volume confirmation: is the volume on the breakout bars above the recent
// average? Real breakouts usually carry volume. Returns a -10..+15 adjustment.
function volumeBoost(bars, lookback = 3) {
  const withVol = bars.filter((b) => b.volume > 0);
  if (withVol.length < 40) return 0;
  const recent = bars.slice(-lookback).reduce((s, b) => s + b.volume, 0) / lookback;
  const base = bars.slice(-60, -lookback).reduce((s, b) => s + b.volume, 0) / Math.max(1, 60 - lookback);
  if (!base) return 0;
  const ratio = recent / base;
  if (ratio > 1.6) return 15;
  if (ratio > 1.2) return 8;
  if (ratio < 0.6) return -10;
  return 0;
}

// Risk/reward from where you would actually enter: the trigger while the
// pattern is still forming, the current price once it has already broken.
function riskReward(entry, target, stop) {
  if (entry == null || target == null || stop == null) return null;
  const reward = Math.abs(target - entry);
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  return Number((reward / risk).toFixed(2));
}

// A pattern is only a setup while the break is recent and price has not run
// far past the trigger. This resolves the stage AND measures how stale it is,
// so formations that completed long ago can be filtered out instead of being
// presented as live.
function resolveStage(bars, direction, trigger, invalidation, a) {
  const last = bars.at(-1).close;
  let stage = 'forming';
  if (direction === 'bullish') {
    if (last > trigger) stage = 'confirmed';
    else if (invalidation != null && last < invalidation) stage = 'failed';
  } else if (direction === 'bearish') {
    if (last < trigger) stage = 'confirmed';
    else if (invalidation != null && last > invalidation) stage = 'failed';
  } else if (last > trigger || (invalidation != null && last < invalidation)) {
    stage = 'confirmed';
  }

  let barsSinceTrigger = null;
  if (stage === 'confirmed') {
    // Walk back to the last bar that was still on the pre-breakout side.
    for (let i = bars.length - 1; i >= 0; i--) {
      const onOtherSide =
        direction === 'bearish' ? bars[i].close >= trigger : bars[i].close <= trigger;
      if (onOtherSide) {
        barsSinceTrigger = bars.length - 1 - i;
        break;
      }
    }
    if (barsSinceTrigger === null) barsSinceTrigger = bars.length;
  }

  return {
    stage,
    barsSinceTrigger,
    extensionATR: a ? Number((Math.abs(last - trigger) / a).toFixed(1)) : null,
  };
}

// Entry price for risk/reward purposes.
function entryFor(stage, last, trigger) {
  return stage === 'confirmed' ? last : trigger;
}

// --- Head and shoulders (and its inverse) --------------------------------

function detectHeadShoulders(bars, pivots, a) {
  const out = [];
  const last = bars.at(-1).close;

  const scan = (peaks, troughs, inverse) => {
    // Need three peaks of the same kind with two opposite pivots between them.
    const recent = peaks.slice(-5);
    for (let i = 0; i <= recent.length - 3; i++) {
      const [ls, head, rs] = [recent[i], recent[i + 1], recent[i + 2]];
      const cmp = inverse
        ? head.price < ls.price && head.price < rs.price
        : head.price > ls.price && head.price > rs.price;
      if (!cmp) continue;

      // Shoulders should be roughly level with each other.
      const shoulderTol = a * 2.2;
      if (!near(ls.price, rs.price, shoulderTol)) continue;

      // The head must stand clear of the shoulders, not just barely exceed them.
      const prominence = Math.abs(head.price - (ls.price + rs.price) / 2);
      if (prominence < a * 1.2) continue;

      const between = troughs.filter((t) => t.index > ls.index && t.index < rs.index);
      if (between.length < 2) continue;
      const n1 = between[0];
      const n2 = between[between.length - 1];

      // Neckline runs through the two intervening pivots and is extended
      // forward to today - a sloping neckline is normal and matters for the
      // trigger price.
      const slope = (n2.price - n1.price) / (n2.index - n1.index);
      const necklineAt = (idx) => n1.price + slope * (idx - n1.index);
      const trigger = necklineAt(bars.length - 1);
      const direction = inverse ? 'bullish' : 'bearish';
      const height = Math.abs(head.price - necklineAt(head.index));
      const target = inverse ? trigger + height : trigger - height;
      const invalidation = head.price;

      const symmetry = 1 - Math.abs(ls.price - rs.price) / Math.max(a * 3, 1e-9);
      const spacing =
        1 - Math.abs((head.index - ls.index) - (rs.index - head.index)) / Math.max(rs.index - ls.index, 1);
      const res = resolveStage(bars, direction, trigger, invalidation, a);
      const { stage } = res;

      out.push({
        name: inverse ? 'Inverse head and shoulders' : 'Head and shoulders',
        family: 'reversal',
        direction,
        stage,
        barsSinceTrigger: res.barsSinceTrigger,
        extensionATR: res.extensionATR,
        confidence: clamp(
          Math.round(
            46 + clamp(symmetry, 0, 1) * 14 + clamp(spacing, 0, 1) * 16 +
            (stage === 'confirmed' ? 12 : 0) + volumeBoost(bars)
          )
        ),
        trigger,
        triggerLabel: 'neckline',
        invalidation,
        target,
        riskReward: riskReward(entryFor(stage, last, trigger), target, invalidation),
        startIndex: ls.index,
        endIndex: rs.index,
        description: inverse
          ? 'Three troughs with the middle one deepest and the outer two level - a bottoming structure. It completes on a close above the neckline.'
          : 'Three peaks with the middle one highest and the outer two level - a topping structure. It completes on a close below the neckline.',
        lines: [
          { type: 'neckline', points: [[n1.index, n1.price], [bars.length - 1, trigger]] },
          {
            type: 'shape',
            points: [
              [ls.index, ls.price],
              [n1.index, n1.price],
              [head.index, head.price],
              [n2.index, n2.price],
              [rs.index, rs.price],
            ],
          },
        ],
      });
    }
  };

  scan(pivots.highs, pivots.lows, false);
  scan(pivots.lows, pivots.highs, true);
  return out;
}

// --- Double and triple tops / bottoms ------------------------------------

function detectDoubleTopBottom(bars, pivots, a) {
  const out = [];
  const last = bars.at(-1).close;

  const scan = (peaks, troughs, isTop) => {
    const recent = peaks.slice(-4);
    for (let i = 0; i <= recent.length - 2; i++) {
      const p1 = recent[i];
      const p2 = recent[i + 1];
      // The two extremes must be level and separated by enough time to be a
      // genuine retest rather than a two-bar wiggle.
      if (!near(p1.price, p2.price, a * 1.6)) continue;
      const gap = p2.index - p1.index;
      if (gap < 8) continue;

      const between = troughs.filter((t) => t.index > p1.index && t.index < p2.index);
      if (!between.length) continue;
      const mid = isTop
        ? between.reduce((m, t) => (t.price < m.price ? t : m))
        : between.reduce((m, t) => (t.price > m.price ? t : m));

      const depth = Math.abs(p1.price - mid.price);
      if (depth < a * 1.5) continue;

      // Is there a third touch at the same level? Then it is a triple.
      const third = recent[i + 2];
      const isTriple = third && near(third.price, p2.price, a * 1.6);

      const direction = isTop ? 'bearish' : 'bullish';
      const trigger = mid.price;
      const target = isTop ? trigger - depth : trigger + depth;
      const invalidation = isTop ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
      const res = resolveStage(bars, direction, trigger, invalidation, a);
      const { stage } = res;
      const levelness = 1 - Math.abs(p1.price - p2.price) / Math.max(a * 2, 1e-9);

      out.push({
        name: `${isTriple ? 'Triple' : 'Double'} ${isTop ? 'top' : 'bottom'}`,
        family: 'reversal',
        direction,
        stage,
        barsSinceTrigger: res.barsSinceTrigger,
        extensionATR: res.extensionATR,
        confidence: clamp(
          Math.round(
            44 + clamp(levelness, 0, 1) * 16 + Math.min(gap, 60) / 4 + (isTriple ? 8 : 0) +
            (stage === 'confirmed' ? 12 : 0) + volumeBoost(bars)
          )
        ),
        trigger,
        triggerLabel: isTop ? 'neckline (interim low)' : 'neckline (interim high)',
        invalidation,
        target,
        riskReward: riskReward(entryFor(stage, last, trigger), target, invalidation),
        startIndex: p1.index,
        endIndex: p2.index,
        description: isTop
          ? `Price failed ${isTriple ? 'three times' : 'twice'} at the same resistance. It completes on a close below the low between the peaks.`
          : `Price held ${isTriple ? 'three times' : 'twice'} at the same support. It completes on a close above the high between the troughs.`,
        lines: [
          { type: 'level', points: [[p1.index, p1.price], [bars.length - 1, (p1.price + p2.price) / 2]] },
          { type: 'neckline', points: [[mid.index, mid.price], [bars.length - 1, mid.price]] },
          { type: 'shape', points: [[p1.index, p1.price], [mid.index, mid.price], [p2.index, p2.price]] },
        ],
      });
    }
  };

  scan(pivots.highs, pivots.lows, true);
  scan(pivots.lows, pivots.highs, false);
  return out;
}

// --- Triangles, wedges and rectangles ------------------------------------

function detectConverging(bars, pivots, a) {
  const upper = fitTrendline(bars, pivots.highs, 'resistance', 2);
  const lower = fitTrendline(bars, pivots.lows, 'support', 2);
  if (!upper || !lower) return [];

  const last = bars.at(-1).close;
  const top = upper.currentValue;
  const bottom = lower.currentValue;
  if (top <= bottom) return [];

  // Slopes normalised to % of price per 100 bars, so "flat" means the same
  // thing on copper as on bitcoin.
  const us = upper.slopePct;
  const ls = lower.slopePct;
  const flat = 2.5;
  const height = top - bottom;
  const converging = Math.abs(us - ls) > 1.5 && (us < ls);

  const startIndex = Math.max(upper.startIndex, lower.startIndex);
  const startHeight = upper.project(startIndex) - lower.project(startIndex);
  const compression = startHeight > 0 ? 1 - height / startHeight : 0;

  let name = null;
  let direction = 'neutral';
  let trigger = null;
  let invalidation = null;
  let description = '';

  if (converging && Math.abs(us) <= flat && ls > flat) {
    name = 'Ascending triangle';
    direction = 'bullish';
    trigger = top;
    invalidation = bottom;
    description = 'Flat resistance with rising lows - buyers paying up into a fixed supply level. Usually resolves upward.';
  } else if (converging && Math.abs(ls) <= flat && us < -flat) {
    name = 'Descending triangle';
    direction = 'bearish';
    trigger = bottom;
    invalidation = top;
    description = 'Flat support with falling highs - sellers accepting less into a fixed demand level. Usually resolves downward.';
  } else if (converging && us < -flat && ls > flat) {
    name = 'Symmetrical triangle';
    direction = 'neutral';
    trigger = top;
    invalidation = bottom;
    description = 'Both boundaries converging - a coiling range that takes its direction from whichever side breaks.';
  } else if (converging && us < -flat && ls < -flat) {
    name = 'Falling wedge';
    direction = 'bullish';
    trigger = top;
    invalidation = bottom;
    description = 'Both boundaries falling but the lows falling slower - selling pressure exhausting. Typically resolves upward.';
  } else if (converging && us > flat && ls > flat) {
    name = 'Rising wedge';
    direction = 'bearish';
    trigger = bottom;
    invalidation = top;
    description = 'Both boundaries rising but the highs rising slower - buying pressure exhausting. Typically resolves downward.';
  } else if (Math.abs(us) <= flat && Math.abs(ls) <= flat && height / last > 0.02) {
    name = 'Rectangle range';
    direction = 'neutral';
    trigger = top;
    invalidation = bottom;
    description = 'Horizontal boundaries holding on both sides - a balanced range. Trade the edges until one gives way.';
  }

  if (!name) return [];

  // Measured move for a triangle is the height at the widest point, projected
  // from the breakout.
  const projected = name === 'Rectangle range' ? height : startHeight || height;
  let target;
  if (direction === 'bullish') target = trigger + projected;
  else if (direction === 'bearish') target = trigger - projected;
  else target = null;

  const res = resolveStage(bars, direction, trigger, invalidation, a);
  const { stage } = res;

  return [
    {
      name,
      family: 'continuation',
      direction,
      stage,
      barsSinceTrigger: res.barsSinceTrigger,
      extensionATR: res.extensionATR,
      confidence: clamp(
        Math.round(
          40 + Math.min(upper.touches + lower.touches, 8) * 4 + clamp(compression, 0, 1) * 18 +
          (stage === 'confirmed' ? 10 : 0) + volumeBoost(bars)
        )
      ),
      trigger,
      triggerLabel: direction === 'bearish' ? 'lower boundary' : 'upper boundary',
      invalidation,
      target,
      riskReward: riskReward(entryFor(stage, last, trigger), target, invalidation),
      startIndex,
      endIndex: bars.length - 1,
      description,
      apexBarsAway:
        upper.slopePerBar !== lower.slopePerBar
          ? Math.round((bottom - top) / (upper.slopePerBar - lower.slopePerBar))
          : null,
      lines: [
        { type: 'resistance', points: [[startIndex, upper.project(startIndex)], [bars.length - 1, top]] },
        { type: 'support', points: [[startIndex, lower.project(startIndex)], [bars.length - 1, bottom]] },
      ],
    },
  ];
}

// --- Flags and pennants ---------------------------------------------------

function detectFlag(bars, a) {
  const last = bars.at(-1).close;
  const results = [];

  // Look for a sharp directional pole followed by a shallow drift against it.
  for (const poleLen of [8, 12, 18]) {
    for (const flagLen of [5, 8, 12]) {
      const total = poleLen + flagLen;
      if (bars.length < total + 20) continue;
      const pole = bars.slice(-total, -flagLen);
      const flag = bars.slice(-flagLen);
      const poleMove = pole.at(-1).close - pole[0].close;
      const poleSize = Math.abs(poleMove);

      // The pole has to be a real thrust, not ordinary drift.
      if (poleSize < a * 3.5) continue;

      const flagHigh = Math.max(...flag.map((b) => b.high));
      const flagLow = Math.min(...flag.map((b) => b.low));
      const flagRange = flagHigh - flagLow;
      // The consolidation must be tight relative to the pole.
      if (flagRange > poleSize * 0.55) continue;

      const flagSlope = linreg(flag.map((b, i) => [i, b.close]))?.slope ?? 0;
      const bullish = poleMove > 0;
      // A proper flag drifts against the pole (or sideways), never with it.
      if (bullish && flagSlope > 0.2 * a) continue;
      if (!bullish && flagSlope < -0.2 * a) continue;

      const direction = bullish ? 'bullish' : 'bearish';
      const trigger = bullish ? flagHigh : flagLow;
      const invalidation = bullish ? flagLow : flagHigh;
      const target = bullish ? trigger + poleSize : trigger - poleSize;
      const res = resolveStage(bars, direction, trigger, invalidation, a);
      const { stage } = res;
      const tightness = 1 - flagRange / (poleSize * 0.55);
      const shape = flagRange / poleSize < 0.25 ? 'pennant' : 'flag';

      results.push({
        name: `${bullish ? 'Bull' : 'Bear'} ${shape}`,
        family: 'continuation',
        direction,
        stage,
        barsSinceTrigger: res.barsSinceTrigger,
        extensionATR: res.extensionATR,
        confidence: clamp(
          Math.round(42 + clamp(tightness, 0, 1) * 22 + (stage === 'confirmed' ? 12 : 0) + volumeBoost(bars))
        ),
        trigger,
        triggerLabel: bullish ? 'flag high' : 'flag low',
        invalidation,
        target,
        riskReward: riskReward(entryFor(stage, last, trigger), target, invalidation),
        startIndex: bars.length - total,
        endIndex: bars.length - 1,
        description: bullish
          ? 'A sharp advance followed by a tight drift lower - a pause inside an uptrend. The measured move projects the pole from the breakout.'
          : 'A sharp decline followed by a tight drift higher - a pause inside a downtrend. The measured move projects the pole from the breakdown.',
        lines: [
          { type: 'pole', points: [[bars.length - total, pole[0].close], [bars.length - flagLen, pole.at(-1).close]] },
          { type: 'resistance', points: [[bars.length - flagLen, flagHigh], [bars.length - 1, flagHigh]] },
          { type: 'support', points: [[bars.length - flagLen, flagLow], [bars.length - 1, flagLow]] },
        ],
      });
    }
  }

  // Keep only the best-scoring flag - the variants overlap heavily.
  return results.sort((x, y) => y.confidence - x.confidence).slice(0, 1);
}

// --- Cup and handle -------------------------------------------------------

function detectCupHandle(bars, pivots, a) {
  const highs = pivots.highs.slice(-4);
  const lows = pivots.lows.slice(-4);
  if (highs.length < 2 || !lows.length) return [];
  const last = bars.at(-1).close;

  for (let i = 0; i < highs.length - 1; i++) {
    const leftRim = highs[i];
    const rightRim = highs[i + 1];
    if (rightRim.index - leftRim.index < 25) continue;
    if (!near(leftRim.price, rightRim.price, a * 2.5)) continue;

    const cupLows = lows.filter((l) => l.index > leftRim.index && l.index < rightRim.index);
    if (!cupLows.length) continue;
    const bottom = cupLows.reduce((m, l) => (l.price < m.price ? l : m));

    const depth = leftRim.price - bottom.price;
    const depthPct = (depth / leftRim.price) * 100;
    // A cup is a rounded base, not a V-spike and not a shallow dip.
    if (depthPct < 8 || depthPct > 55) continue;

    // Roundness: the low should sit near the middle of the span.
    const mid = (leftRim.index + rightRim.index) / 2;
    const offset = Math.abs(bottom.index - mid) / (rightRim.index - leftRim.index);
    if (offset > 0.3) continue;

    // The handle is the shallow pullback after the right rim.
    const handle = bars.slice(rightRim.index);
    if (handle.length < 3) continue;
    const handleLow = Math.min(...handle.map((b) => b.low));
    const handleDepth = rightRim.price - handleLow;
    if (handleDepth > depth * 0.5) continue;

    const trigger = rightRim.price;
    const target = trigger + depth;
    const res = resolveStage(bars, 'bullish', trigger, handleLow, a);
    const { stage } = res;

    return [
      {
        name: 'Cup and handle',
        family: 'continuation',
        direction: 'bullish',
        stage,
        barsSinceTrigger: res.barsSinceTrigger,
        extensionATR: res.extensionATR,
        confidence: clamp(
          Math.round(42 + (1 - offset / 0.3) * 16 + (handleDepth < depth * 0.33 ? 8 : 0) +
          (stage === 'confirmed' ? 12 : 0) + volumeBoost(bars))
        ),
        trigger,
        triggerLabel: 'cup rim',
        invalidation: handleLow,
        target,
        riskReward: riskReward(entryFor(stage, last, trigger), target, handleLow),
        startIndex: leftRim.index,
        endIndex: bars.length - 1,
        description:
          'A rounded base between two level rims, followed by a shallow drift lower. It completes on a close above the rim, projecting the cup depth.',
        lines: [
          { type: 'level', points: [[leftRim.index, leftRim.price], [bars.length - 1, rightRim.price]] },
          {
            type: 'shape',
            points: [[leftRim.index, leftRim.price], [bottom.index, bottom.price], [rightRim.index, rightRim.price]],
          },
        ],
      },
    ];
  }
  return [];
}

// --- Range breakout state -------------------------------------------------

function detectBreakout(bars, a) {
  if (bars.length < 60) return [];
  const window = bars.slice(-60, -1);
  const hi = Math.max(...window.map((b) => b.high));
  const lo = Math.min(...window.map((b) => b.low));
  const last = bars.at(-1).close;
  const range = hi - lo;
  if (range <= 0) return [];

  // Only report a breakout that clears the range by a meaningful margin.
  if (last > hi + a * 0.3) {
    const res = resolveStage(bars, 'bullish', hi, hi - a, a);
    return [
      {
        name: '60-bar range breakout',
        family: 'breakout',
        direction: 'bullish',
        stage: 'confirmed',
        barsSinceTrigger: res.barsSinceTrigger,
        extensionATR: res.extensionATR,
        confidence: clamp(Math.round(52 + Math.min(((last - hi) / a) * 6, 18) + volumeBoost(bars))),
        trigger: hi,
        triggerLabel: 'prior range high',
        invalidation: hi - a,
        target: last + range * 0.5,
        riskReward: riskReward(last, last + range * 0.5, hi - a),
        startIndex: bars.length - 60,
        endIndex: bars.length - 1,
        description: 'Price has cleared the high of its last 60 bars. Prior resistance becomes the level that has to hold.',
        lines: [{ type: 'resistance', points: [[bars.length - 60, hi], [bars.length - 1, hi]] }],
      },
    ];
  }
  if (last < lo - a * 0.3) {
    const res = resolveStage(bars, 'bearish', lo, lo + a, a);
    return [
      {
        name: '60-bar range breakdown',
        family: 'breakout',
        direction: 'bearish',
        stage: 'confirmed',
        barsSinceTrigger: res.barsSinceTrigger,
        extensionATR: res.extensionATR,
        confidence: clamp(Math.round(52 + Math.min(((lo - last) / a) * 6, 18) + volumeBoost(bars))),
        trigger: lo,
        triggerLabel: 'prior range low',
        invalidation: lo + a,
        target: last - range * 0.5,
        riskReward: riskReward(last, last - range * 0.5, lo + a),
        startIndex: bars.length - 60,
        endIndex: bars.length - 1,
        description: 'Price has broken the low of its last 60 bars. Prior support becomes the level that has to cap rallies.',
        lines: [{ type: 'support', points: [[bars.length - 60, lo], [bars.length - 1, lo]] }],
      },
    ];
  }
  return [];
}

// --- Candlestick signals on the most recent bars -------------------------

export function candleSignals(bars) {
  const out = [];
  const n = bars.length;
  if (n < 3) return out;
  const [prev, cur] = [bars[n - 2], bars[n - 1]];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range <= 0) return out;
  const upperWick = cur.high - Math.max(cur.close, cur.open);
  const lowerWick = Math.min(cur.close, cur.open) - cur.low;
  const prevBody = Math.abs(prev.close - prev.open);

  if (body > prevBody && cur.close > cur.open && prev.close < prev.open && cur.close > prev.open && cur.open < prev.close)
    out.push({ name: 'Bullish engulfing', direction: 'bullish' });
  if (body > prevBody && cur.close < cur.open && prev.close > prev.open && cur.close < prev.open && cur.open > prev.close)
    out.push({ name: 'Bearish engulfing', direction: 'bearish' });
  if (lowerWick > body * 2 && upperWick < body * 0.6)
    out.push({ name: 'Hammer / long lower wick', direction: 'bullish' });
  if (upperWick > body * 2 && lowerWick < body * 0.6)
    out.push({ name: 'Shooting star / long upper wick', direction: 'bearish' });
  if (body / range < 0.1) out.push({ name: 'Doji (indecision)', direction: 'neutral' });
  return out;
}

// --- Orchestrator ---------------------------------------------------------

export function detectPatterns(bars, pivots) {
  const a = atr(bars, 14).at(-1) || bars.at(-1).close * 0.01;
  const found = [
    ...detectHeadShoulders(bars, pivots, a),
    ...detectDoubleTopBottom(bars, pivots, a),
    ...detectConverging(bars, pivots, a),
    ...detectFlag(bars, a),
    ...detectCupHandle(bars, pivots, a),
    ...detectBreakout(bars, a),
  ];

  // A formation that resolved long ago is history, not a setup. Three ways a
  // pattern stops being actionable:
  //   1. its right edge is far back in the window
  //   2. the breakout happened many bars ago
  //   3. price has already run a long way past the trigger, so the measured
  //      move is mostly spent and the invalidation level is nowhere near
  const edgeCutoff = bars.length - Math.max(30, Math.round(bars.length * 0.25));
  const stale = [];
  const live = found.filter((p) => {
    if (p.stage === 'failed') return false;
    if (p.endIndex < edgeCutoff) {
      stale.push({ ...p, staleReason: 'formed too far back in the window' });
      return false;
    }
    if (p.stage === 'confirmed') {
      if (p.barsSinceTrigger != null && p.barsSinceTrigger > 25) {
        stale.push({ ...p, staleReason: `broke out ${p.barsSinceTrigger} bars ago` });
        return false;
      }
      if (p.extensionATR != null && p.extensionATR > 6) {
        stale.push({ ...p, staleReason: `price is ${p.extensionATR} ATR past the trigger` });
        return false;
      }
    }
    return true;
  });

  // Two detectors firing on the same swings is common (a triple bottom is also
  // a double bottom). Keep the stronger read of each direction+family pair.
  const seen = new Set();
  const deduped = live
    .sort((x, y) => y.confidence - x.confidence)
    .filter((p) => {
      const key = `${p.family}:${p.direction}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    patterns: deduped.slice(0, 4),
    stale: stale.sort((x, y) => y.confidence - x.confidence).slice(0, 3),
    channel: detectChannel(bars, pivots),
    candles: candleSignals(bars),
  };
}
