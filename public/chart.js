// Candlestick renderer with pattern overlays. Everything the engine returns in
// `technical.view` shares one index space with the bars, so an overlay point of
// [index, price] maps straight onto the chart with no realignment.

const COLORS = {
  grid: '#1b2230',
  axis: '#8792a8',
  up: '#2fbf83',
  down: '#f0655d',
  wickUp: '#2fbf83',
  wickDown: '#f0655d',
  sma20: '#5aa9ff',
  sma50: '#e0a458',
  sma200: '#b48ce8',
  band: 'rgba(90,169,255,0.055)',
  support: '#2fbf83',
  resistance: '#f0655d',
  neckline: '#e0a458',
  shape: '#5aa9ff',
  level: '#8792a8',
  pole: '#b48ce8',
  channel: 'rgba(180,140,232,0.75)',
  // The projection is deliberately monochrome. Colouring a cone by its median
  // would read as a forecast of direction, which is the one thing it is not.
  coneBand: 'rgba(135,146,168,0.10)',
  coneBody: 'rgba(135,146,168,0.42)',
  coneWick: 'rgba(135,146,168,0.55)',
  coneMedian: 'rgba(216,222,233,0.75)',
  coneEdge: 'rgba(135,146,168,0.5)',
};

function niceTicks(min, max, count = 6) {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const first = Math.ceil(min / step) * step;
  const out = [];
  for (let v = first; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

function fmtPrice(v) {
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtDate(ms, timeframe) {
  const d = new Date(ms);
  if (['5m', '15m', '1h', '4h'].includes(timeframe)) {
    return `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:00`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function drawChart(canvas, analysis, projection = null) {
  const t = analysis.technical;
  const view = t.view;
  const bars = view.bars;
  if (!bars?.length) return;

  // Projected steps share the bar index space, continuing past the last real
  // bar, so the same x() maps both without any realignment.
  const proj = projection?.available ? projection.steps : null;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 8;
  const padR = 66;
  const padT = 10;
  const padB = 22;
  const volH = Math.round((cssH - padT - padB) * 0.16);
  const priceH = cssH - padT - padB - volH - 8;

  const n = bars.length;
  // The drawing width covers history plus the projection, so adding a cone
  // squeezes the candles slightly rather than running off the right edge.
  const nTotal = n + (proj?.length ?? 0);
  const plotW = cssW - padL - padR;
  const bw = plotW / nTotal;

  // --- price range, widened to include anything we are about to draw on it
  let lo = Math.min(...bars.map((b) => b.low));
  let hi = Math.max(...bars.map((b) => b.high));
  const span = hi - lo;

  const consider = (v) => {
    if (v == null || !Number.isFinite(v)) return;
    // Ignore overlay points miles off the chart - a projected trendline can
    // run far past the visible price and would flatten everything else.
    if (v < lo - span * 0.45 || v > hi + span * 0.45) return;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  };
  for (const p of t.patterns || []) {
    for (const line of p.lines || []) for (const [, price] of line.points) consider(price);
    consider(p.trigger);
  }
  for (const l of t.levels || []) consider(l.price);
  if (t.channel) { consider(t.channel.top); consider(t.channel.bottom); }
  // Make room for the cone, or its outer band gets clipped and the projection
  // looks narrower than it is - which would understate the risk on screen.
  if (proj) for (const s of proj) { consider(s.p05); consider(s.p95); }

  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;

  const x = (i) => padL + (i + 0.5) * bw;
  const y = (p) => padT + priceH - ((p - lo) / (hi - lo)) * priceH;

  // --- grid + price axis
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  for (const tick of niceTicks(lo, hi)) {
    const py = y(tick);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(py) + 0.5);
    ctx.lineTo(cssW - padR, Math.round(py) + 0.5);
    ctx.stroke();
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(tick), cssW - padR + 6, py);
  }

  // --- time axis
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.axis;
  const labelEvery = Math.max(1, Math.floor(n / 7));
  for (let i = 0; i < n; i += labelEvery) {
    ctx.fillText(fmtDate(bars[i].time, analysis.timeframe), x(i), cssH - padB / 2);
  }

  // --- Bollinger band fill
  const bandTop = view.bbUpper;
  const bandBot = view.bbLower;
  if (bandTop && bandBot) {
    ctx.fillStyle = COLORS.band;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (bandTop[i] == null) continue;
      if (!started) { ctx.moveTo(x(i), y(bandTop[i])); started = true; }
      else ctx.lineTo(x(i), y(bandTop[i]));
    }
    for (let i = n - 1; i >= 0; i--) {
      if (bandBot[i] == null) continue;
      ctx.lineTo(x(i), y(bandBot[i]));
    }
    if (started) { ctx.closePath(); ctx.fill(); }
  }

  // --- moving averages
  const drawLine = (series, color, width = 1.4) => {
    if (!series) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      if (v == null) { started = false; continue; }
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    }
    ctx.stroke();
  };
  drawLine(view.sma200, COLORS.sma200, 1.6);
  drawLine(view.sma50, COLORS.sma50);
  drawLine(view.sma20, COLORS.sma20);

  // --- candles
  const body = Math.max(1, Math.min(bw * 0.68, 14));
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const up = b.close >= b.open;
    const cx = x(i);
    ctx.strokeStyle = up ? COLORS.wickUp : COLORS.wickDown;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, y(b.high));
    ctx.lineTo(Math.round(cx) + 0.5, y(b.low));
    ctx.stroke();

    const yo = y(b.open);
    const yc = y(b.close);
    const top = Math.min(yo, yc);
    const h = Math.max(1, Math.abs(yc - yo));
    ctx.fillStyle = up ? COLORS.up : COLORS.down;
    ctx.fillRect(cx - body / 2, top, body, h);
  }

  // --- projection
  //
  // Drawn as candles because that is the shape the eye already reads, but each
  // one is a QUANTILE SUMMARY of where price could be on that date, not a
  // predicted bar: body spans the 25th-75th percentile, wicks the 10th-90th.
  // Deliberately rendered in a single neutral colour rather than green/red -
  // colouring them by the median against spot would read as a direction call,
  // and the conditioning study found nothing that predicts direction.
  if (proj) {
    // Soft fill between the 10th and 90th so the cone reads as one object.
    ctx.fillStyle = COLORS.coneBand;
    ctx.beginPath();
    ctx.moveTo(x(n - 1), y(bars[n - 1].close));
    for (const s of proj) ctx.lineTo(x(n - 1 + s.step), y(s.p90));
    for (let i = proj.length - 1; i >= 0; i--) ctx.lineTo(x(n - 1 + proj[i].step), y(proj[i].p10));
    ctx.closePath();
    ctx.fill();

    // The boundary between history and projection.
    const splitX = Math.round(x(n - 1) + bw / 2) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = COLORS.coneEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(splitX, padT);
    ctx.lineTo(splitX, padT + priceH);
    ctx.stroke();
    ctx.restore();

    for (const s of proj) {
      const cx = x(n - 1 + s.step);
      ctx.strokeStyle = COLORS.coneWick;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y(s.p90));
      ctx.lineTo(Math.round(cx) + 0.5, y(s.p10));
      ctx.stroke();

      const top = y(s.p75);
      const h = Math.max(1, y(s.p25) - y(s.p75));
      ctx.fillStyle = COLORS.coneBody;
      ctx.fillRect(cx - body / 2, top, body, h);

      // Median tick. Thin, and left uncoloured - see the note above.
      ctx.strokeStyle = COLORS.coneMedian;
      ctx.beginPath();
      ctx.moveTo(cx - body / 2, Math.round(y(s.p50)) + 0.5);
      ctx.lineTo(cx + body / 2, Math.round(y(s.p50)) + 0.5);
      ctx.stroke();
    }
  }

  // --- horizontal support / resistance
  ctx.setLineDash([4, 4]);
  ctx.font = '10px ui-monospace, Consolas, monospace';
  // Levels often cluster within a few pixels of each other. Draw every line,
  // but only label the ones that will not collide with a label already placed.
  const placedLabels = [];
  for (const l of (t.levels || []).slice(0, 5)) {
    if (l.price < lo || l.price > hi) continue;
    const py = y(l.price);
    ctx.strokeStyle = l.type === 'support' ? COLORS.support : COLORS.resistance;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(cssW - padR, py);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (placedLabels.some((p) => Math.abs(p - py) < 12)) continue;
    placedLabels.push(py);
    ctx.fillStyle = l.type === 'support' ? COLORS.support : COLORS.resistance;
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(l.price), padL + 4, py - 6);
  }
  ctx.setLineDash([]);

  // --- channel
  if (t.channel) {
    const ch = t.channel;
    const drawSloped = (fromIdx, fromP, toIdx, toP) => {
      ctx.beginPath();
      ctx.moveTo(x(fromIdx), y(fromP));
      ctx.lineTo(x(toIdx), y(toP));
      ctx.stroke();
    };
    ctx.strokeStyle = COLORS.channel;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    drawSloped(ch.upper.startIndex, ch.upper.startPrice, n - 1, ch.top);
    drawSloped(ch.lower.startIndex, ch.lower.startPrice, n - 1, ch.bottom);
    ctx.setLineDash([]);
  }

  // --- pattern geometry (top formation only, so the chart stays readable)
  const best = (t.patterns || [])[0];
  if (best) {
    for (const line of best.lines || []) {
      const color = COLORS[line.type] || COLORS.shape;
      ctx.strokeStyle = color;
      ctx.lineWidth = line.type === 'shape' ? 1.3 : 1.8;
      ctx.setLineDash(line.type === 'shape' ? [3, 3] : []);
      ctx.beginPath();
      line.points.forEach(([idx, price], k) => {
        const px = x(Math.max(0, Math.min(n - 1, idx)));
        const py = y(price);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      if (line.type === 'shape') {
        ctx.fillStyle = color;
        for (const [idx, price] of line.points) {
          ctx.beginPath();
          ctx.arc(x(Math.max(0, Math.min(n - 1, idx))), y(price), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.setLineDash([]);

    if (best.target != null && best.target >= lo && best.target <= hi) {
      const py = y(best.target);
      ctx.strokeStyle = best.direction === 'bearish' ? COLORS.down : COLORS.up;
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(cssW - padR, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = best.direction === 'bearish' ? COLORS.down : COLORS.up;
      ctx.textAlign = 'right';
      ctx.fillText(`target ${fmtPrice(best.target)}`, cssW - padR - 5, py - 6);
    }
  }

  // --- last price tag
  const last = bars[n - 1].close;
  const lastY = y(last);
  ctx.fillStyle = '#5aa9ff';
  ctx.fillRect(cssW - padR + 1, lastY - 8, padR - 2, 16);
  ctx.fillStyle = '#04101f';
  ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtPrice(last), cssW - padR + 5, lastY);

  // --- volume
  const volTop = padT + priceH + 8;
  const maxVol = Math.max(...bars.map((b) => b.volume || 0));
  if (maxVol > 0) {
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const h = ((b.volume || 0) / maxVol) * volH;
      ctx.fillStyle = b.close >= b.open ? 'rgba(47,191,131,.32)' : 'rgba(240,101,93,.32)';
      ctx.fillRect(x(i) - body / 2, volTop + volH - h, body, h);
    }
  }
}

function chartLegend(analysis) {
  const items = [
    ['SMA 20', COLORS.sma20],
    ['SMA 50', COLORS.sma50],
    ['SMA 200', COLORS.sma200],
  ];
  const best = analysis.technical.patterns?.[0];
  if (best) items.push([best.name, COLORS.shape]);
  if (analysis.technical.channel) items.push(['Channel', COLORS.channel]);
  return items.map(([label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('');
}

// A close-up of just the handover: the last stretch of real bars and the
// projected ones beside them at a width where each is actually legible.
//
// The main chart shows 320 bars, which squeezes a 21-step projection into a
// grey fan about two pixels wide per step. That is honest but useless - the
// whole point of drawing a projection as candles is that you can read one. So
// this draws the junction at a usable scale, and nothing else.
function drawProjectionChart(canvas, analysis, projection) {
  if (!projection?.available || !projection.steps?.length) return;
  const all = analysis.technical.view.bars;
  if (!all?.length) return;

  const steps = projection.steps;
  // Roughly as much history as projection, so the eye has a reference for how
  // wide the cone is against bars it has already seen.
  const hist = all.slice(-Math.max(12, Math.min(40, steps.length * 2)));

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 8;
  const padR = 60;
  const padT = 10;
  const padB = 20;
  const plotH = cssH - padT - padB;
  const total = hist.length + steps.length;
  const plotW = cssW - padL - padR;
  const bw = plotW / total;

  let lo = Math.min(...hist.map((b) => b.low), ...steps.map((s) => s.p05));
  let hi = Math.max(...hist.map((b) => b.high), ...steps.map((s) => s.p95));
  const pad = (hi - lo) * 0.07;
  lo -= pad;
  hi += pad;

  const x = (i) => padL + (i + 0.5) * bw;
  const y = (p) => padT + plotH - ((p - lo) / (hi - lo)) * plotH;

  ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  for (const tick of niceTicks(lo, hi, 5)) {
    const py = y(tick);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(py) + 0.5);
    ctx.lineTo(cssW - padR, Math.round(py) + 0.5);
    ctx.stroke();
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(tick), cssW - padR + 6, py);
  }

  const body = Math.max(2, Math.min(bw * 0.7, 16));

  for (let i = 0; i < hist.length; i++) {
    const b = hist[i];
    const up = b.close >= b.open;
    const cx = x(i);
    ctx.strokeStyle = up ? COLORS.wickUp : COLORS.wickDown;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, y(b.high));
    ctx.lineTo(Math.round(cx) + 0.5, y(b.low));
    ctx.stroke();
    const top = Math.min(y(b.open), y(b.close));
    const h = Math.max(1, Math.abs(y(b.close) - y(b.open)));
    ctx.fillStyle = up ? COLORS.up : COLORS.down;
    ctx.fillRect(cx - body / 2, top, body, h);
  }

  const base = hist.length - 1;

  ctx.fillStyle = COLORS.coneBand;
  ctx.beginPath();
  ctx.moveTo(x(base), y(hist.at(-1).close));
  for (const s of steps) ctx.lineTo(x(base + s.step), y(s.p90));
  for (let i = steps.length - 1; i >= 0; i--) ctx.lineTo(x(base + steps[i].step), y(steps[i].p10));
  ctx.closePath();
  ctx.fill();

  const splitX = Math.round(x(base) + bw / 2) + 0.5;
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = COLORS.coneEdge;
  ctx.beginPath();
  ctx.moveTo(splitX, padT);
  ctx.lineTo(splitX, padT + plotH);
  ctx.stroke();
  ctx.restore();

  for (const s of steps) {
    const cx = x(base + s.step);
    ctx.strokeStyle = COLORS.coneWick;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, y(s.p90));
    ctx.lineTo(Math.round(cx) + 0.5, y(s.p10));
    ctx.stroke();

    ctx.fillStyle = COLORS.coneBody;
    ctx.fillRect(cx - body / 2, y(s.p75), body, Math.max(1, y(s.p25) - y(s.p75)));

    ctx.strokeStyle = COLORS.coneMedian;
    ctx.beginPath();
    ctx.moveTo(cx - body / 2, Math.round(y(s.p50)) + 0.5);
    ctx.lineTo(cx + body / 2, Math.round(y(s.p50)) + 0.5);
    ctx.stroke();
  }

  ctx.fillStyle = COLORS.axis;
  ctx.textAlign = 'center';
  ctx.fillText('today', splitX, cssH - padB / 2);
  ctx.fillText(`+${steps.length}`, x(base + steps.length), cssH - padB / 2);
}

window.MarketChart = { drawChart, drawProjectionChart, chartLegend };
