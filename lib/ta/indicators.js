// Indicator math. Every function returns an array aligned to the input bars,
// with null in the warm-up region so indexes always line up with candles.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    out[i] = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  }
  return out;
}

// Wilder RSI (smoothed averages, not simple ones).
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]
  );
  const defined = line.filter((v) => v != null);
  const sig = ema(defined, signalPeriod);
  const offset = line.length - defined.length;
  const signal = new Array(closes.length).fill(null);
  const hist = new Array(closes.length).fill(null);
  for (let i = 0; i < defined.length; i++) {
    if (sig[i] == null) continue;
    signal[i + offset] = sig[i];
    hist[i + offset] = defined[i] - sig[i];
  }
  return { line, signal, hist };
}

export function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < tr.length; i++) {
    if (i === period - 1) {
      prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  return {
    mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
    width: mid.map((m, i) => (m == null || m === 0 ? null : (2 * mult * sd[i]) / m)),
  };
}

// ADX via Wilder smoothing - the trend-vs-range discriminator.
export function adx(bars, period = 14) {
  const len = bars.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(bars);
  const smooth = (arr) => {
    const out = new Array(len).fill(null);
    let acc = null;
    for (let i = 0; i < len; i++) {
      if (i === period) {
        acc = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
        out[i] = acc;
      } else if (i > period) {
        acc = acc - acc / period + arr[i];
        out[i] = acc;
      }
    }
    return out;
  };
  const strP = smooth(plusDM);
  const strM = smooth(minusDM);
  const strTR = smooth(tr);
  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (strTR[i] == null || strTR[i] === 0) continue;
    plusDI[i] = (100 * strP[i]) / strTR[i];
    minusDI[i] = (100 * strM[i]) / strTR[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  }
  const adxOut = new Array(len).fill(null);
  let prev = null;
  for (let i = period * 2; i < len; i++) {
    const window = dx.slice(i - period + 1, i + 1).filter((v) => v != null);
    if (window.length < period) continue;
    if (prev == null) prev = window.reduce((a, b) => a + b, 0) / period;
    else prev = (prev * (period - 1) + dx[i]) / period;
    adxOut[i] = prev;
  }
  return { adx: adxOut, plusDI, minusDI };
}

// Where the latest reading sits within its own history - turns any raw
// indicator into a comparable 0-100 percentile.
export function percentileRank(values, value) {
  const clean = values.filter((v) => v != null && Number.isFinite(v));
  if (!clean.length) return null;
  const below = clean.filter((v) => v <= value).length;
  return (100 * below) / clean.length;
}

export function pctChange(series, lookback) {
  if (series.length <= lookback) return null;
  const now = series[series.length - 1];
  const then = series[series.length - 1 - lookback];
  if (then == null || then === 0 || now == null) return null;
  return ((now - then) / Math.abs(then)) * 100;
}

export function zScore(values, value, lookback = 250) {
  const win = values.slice(-lookback).filter((v) => v != null && Number.isFinite(v));
  if (win.length < 20) return null;
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
  return sd === 0 ? 0 : (value - mean) / sd;
}

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

// Ordinary least squares on (index, value) pairs - used for trendline fitting
// and for measuring the slope of a moving average.
export function linreg(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const [x, y] of points) {
    ssTot += (y - meanY) ** 2;
    ssRes += (y - (slope * x + intercept)) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}
