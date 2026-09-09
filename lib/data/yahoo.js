// Keyless OHLCV from Yahoo's chart endpoint. Covers equities, ETFs, indices,
// futures (HG=F copper, CL=F crude), FX (EURUSD=X) and crypto (BTC-USD).
import { cached } from '../cache.js';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// Yahoo has no 4h bar, so anything it can't serve natively is resampled from a
// finer interval it can. [nativeInterval, range, resampleFactor]
export const TIMEFRAMES = {
  '5m':  { interval: '5m',  range: '60d',  factor: 1,  label: '5 minute' },
  '15m': { interval: '15m', range: '60d',  factor: 1,  label: '15 minute' },
  '1h':  { interval: '1h',  range: '730d', factor: 1,  label: '1 hour' },
  '4h':  { interval: '1h',  range: '730d', factor: 4,  label: '4 hour' },
  '1d':  { interval: '1d',  range: '10y',  factor: 1,  label: 'daily' },
  '1w':  { interval: '1wk', range: '10y',  factor: 1,  label: 'weekly' },
  '1M':  { interval: '1mo', range: 'max',  factor: 1,  label: 'monthly' },
};

async function fetchJson(path, symbol) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      // A 404 here means the ticker does not exist, which is by far the most
      // common failure - say so rather than surfacing a bare status code.
      if (res.status === 404) {
        throw new Error(
          `No such symbol${symbol ? `: ${symbol}` : ''}. Start typing a name to search, or use Yahoo notation ` +
          `(HG=F copper, BTC-USD bitcoin, EURUSD=X euro, ^GSPC S&P 500).`
        );
      }
      if (res.status === 429) throw new Error('Yahoo is rate limiting this machine - wait a minute and retry.');
      if (!res.ok) throw new Error(`Price feed returned HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Aggregate N bars into one. Partial trailing groups are kept so the most
// recent (still forming) bar is not silently dropped.
function resample(bars, factor) {
  if (factor <= 1) return bars;
  const out = [];
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, b) => sum + (b.volume || 0), 0),
    });
  }
  return out;
}

export async function fetchSeries(symbol, timeframe = '1d') {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) throw new Error(`Unknown timeframe: ${timeframe}`);
  const key = `yahoo:${symbol}:${timeframe}`;
  // Intraday data goes stale fast; daily and slower can sit for 15 minutes.
  const ttl = tf.interval.endsWith('m') ? 60_000 : 900_000;

  return cached(key, ttl, async () => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${tf.range}&interval=${tf.interval}&includePrePost=false`;
    const json = await fetchJson(path, symbol);
    const err = json?.chart?.error;
    if (err) throw new Error(`${err.code}: ${err.description}`);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No data returned for ${symbol}`);

    const { timestamp = [], indicators, meta } = result;
    const q = indicators?.quote?.[0] || {};
    const bars = [];
    let partialLastBar = false;

    for (let i = 0; i < timestamp.length; i++) {
      const isLast = i === timestamp.length - 1;
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      if (open == null || high == null || low == null) continue;

      let close = q.close?.[i];
      if (close == null) {
        // Yahoo pads holidays and halts with nulls - drop those. But the most
        // recent session routinely arrives with open/high/low/volume populated
        // and close still null, because the consolidated close lags the tape.
        // Dropping it silently costs us the entire current session: on an
        // active day that is a multi-percent error in every level, pattern
        // stage and price readout downstream. meta.regularMarketPrice carries
        // the live value, so use it and mark the bar provisional.
        if (!isLast || !Number.isFinite(meta?.regularMarketPrice)) continue;
        close = meta.regularMarketPrice;
        partialLastBar = true;
      }

      bars.push({
        time: timestamp[i] * 1000,
        open,
        // Guard the range in case the live print sits outside the session's
        // reported extremes.
        high: Math.max(high, close),
        low: Math.min(low, close),
        close,
        volume: q.volume?.[i] ?? 0,
      });
    }
    if (bars.length < 30) throw new Error(`Only ${bars.length} usable bars for ${symbol} — try a slower timeframe`);

    return {
      symbol: meta?.symbol || symbol,
      bars: resample(bars, tf.factor),
      timeframe,
      timeframeLabel: tf.label,
      partialLastBar,
      meta: {
        currency: meta?.currency,
        exchange: meta?.fullExchangeName || meta?.exchangeName,
        quoteType: meta?.instrumentType,
        name: meta?.longName || meta?.shortName || meta?.symbol || symbol,
        price: meta?.regularMarketPrice,
        previousClose: meta?.chartPreviousClose,
      },
    };
  });
}

// Daily closes keyed by YYYY-MM-DD, for cross-asset correlation work.
export async function fetchDailyCloses(symbol, years = 3) {
  return cached(`closes:${symbol}:${years}`, 900_000, async () => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`;
    const json = await fetchJson(path, symbol);
    const result = json?.chart?.result?.[0];
    if (!result) return {};
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const live = result.meta?.regularMarketPrice;
    const map = {};
    for (let i = 0; i < ts.length; i++) {
      let close = closes[i];
      // Same lagging-close problem as fetchSeries: without this the current
      // session drops out of every correlation and realised-vol window.
      if (close == null) {
        if (i !== ts.length - 1 || !Number.isFinite(live)) continue;
        close = live;
      }
      map[new Date(ts[i] * 1000).toISOString().slice(0, 10)] = close;
    }
    return map;
  });
}

export async function searchSymbol(query) {
  const json = await fetchJson(`/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`);
  return (json?.quotes || [])
    .filter((q) => q.symbol)
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      type: q.quoteType,
      exchange: q.exchDisp,
    }));
}
