const $ = (id) => document.getElementById(id);
let current = null;
let config = { llm: false, fred: false, timeframes: [] };

// If the session expires while the page is open, every API call starts
// returning 401. Bounce to the login screen rather than surfacing that as a
// stack of confusing request failures.
const rawFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await rawFetch(...args);
  if (res.status === 401 && !String(args[0]).includes('/api/login')) {
    location.href = '/login';
  }
  return res;
};

// ---------- helpers ----------

const fmt = (v, digits) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = digits ?? (a >= 1000 ? 2 : a >= 1 ? 2 : 4);
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const signed = (v, digits = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`);
const toneColor = (v) => (v > 3 ? 'var(--bull)' : v < -3 ? 'var(--bear)' : 'var(--muted)');

function status(msg, isError = false, spinner = false) {
  const el = $('status');
  if (!msg) return el.classList.remove('show');
  el.innerHTML = (spinner ? '<span class="spin"></span>' : '') + msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
}

// Minimal markdown renderer for the briefing: headings, bold, code, lists.
function renderMarkdown(md) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

  const out = [];
  let inList = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h2>${inline(h[2])}</h2>`);
    } else if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (!line.trim()) {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// ---------- rendering ----------

function renderVerdict(a) {
  $('assetName').textContent = `${a.name}`;
  $('assetMeta').textContent =
    `${a.symbol} · ${a.exchange || 'market'} · ${a.timeframeLabel} bars · ${a.barCount} bars of history · ` +
    `as of ${new Date(a.generatedAt).toLocaleString()}` +
    (a.partialLastBar ? " · latest bar still forming (live price)" : "");

  const p = a.technical.price;
  $('price').textContent = fmt(p.last);
  const chg = p.change1;
  $('priceChange').innerHTML =
    `<span style="color:${chg > 0 ? 'var(--bull)' : chg < 0 ? 'var(--bear)' : 'var(--muted)'}">` +
    `${signed(chg, 2)}% last bar</span> · ${signed(p.change20, 1)}% 20 bars`;

  const c = a.composite;
  $('compositeScore').textContent = signed(c.score, 0);
  $('compositeScore').style.color = toneColor(c.score);
  $('compositeLabel').textContent = c.label;

  const fill = $('scoreFill');
  const half = Math.abs(c.score) / 2;
  if (c.score >= 0) {
    fill.style.left = '50%';
    fill.style.right = 'auto';
    fill.style.width = `${half}%`;
    fill.style.background = 'var(--bull)';
  } else {
    fill.style.right = '50%';
    fill.style.left = 'auto';
    fill.style.width = `${half}%`;
    fill.style.background = 'var(--bear)';
  }

  $('techScore').textContent = signed(c.technicalScore, 0);
  $('techScore').style.color = toneColor(c.technicalScore);
  $('macroScore').textContent = c.macroScore == null ? '—' : signed(c.macroScore, 0);
  $('macroScore').style.color = toneColor(c.macroScore ?? 0);
  $('blendLabel').textContent = `${Math.round(c.techWeight * 100)}/${Math.round(c.macroWeight * 100)}`;
  $('alignment').textContent = c.alignment;
  $('alignment').style.color =
    c.alignment === 'aligned' ? 'var(--bull)' : c.alignment === 'conflicted' ? 'var(--warn)' : 'var(--muted)';

  const t = a.technical;
  const chips = [
    ['Regime', t.regime],
    ['Structure', t.structure.trend],
    ['RSI', t.momentum.rsi?.toFixed(1) ?? '—'],
    ['ADX', t.momentum.adx?.toFixed(1) ?? '—'],
    ['ATR', `${t.volatility.atrPct?.toFixed(2) ?? '—'}%`],
  ];
  if (t.volatility.squeeze) chips.push(['Volatility', 'band squeeze']);
  if (t.candles?.length) chips.push(['Last candle', t.candles.map((x) => x.name).join(', ')]);
  if (t.seasonality?.current?.avg != null)
    chips.push(['Seasonality', `${signed(t.seasonality.current.avg, 1)}% avg this month`]);
  $('regimeRow').innerHTML = chips.map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('');
}

function renderPatterns(a) {
  const list = a.technical.patterns || [];
  const host = $('patterns');
  if (!list.length) {
    host.innerHTML = `<div class="empty">No completed formation on this timeframe. Structure reads as
      <b>${a.technical.structure.trend}</b> — ${a.technical.structure.detail}</div>`;
  } else {
    host.innerHTML = list
      .map((p) => {
        const rr = p.riskReward == null ? '—' : `${p.riskReward} : 1`;
        return `
        <div class="pattern">
          <div class="pattern-head">
            <span class="pattern-name">${p.name}</span>
            <span>
              <span class="badge ${p.direction}">${p.direction}</span>
              <span class="badge ${p.stage}">${p.stage}</span>
            </span>
          </div>
          <p class="pattern-desc">${p.description}</p>
          <div class="pattern-levels">
            <div class="pl"><span class="k">${p.triggerLabel || 'trigger'}</span><span class="v">${fmt(p.trigger)}</span></div>
            <div class="pl"><span class="k">target</span><span class="v">${fmt(p.target)}</span></div>
            <div class="pl"><span class="k">invalidation</span><span class="v">${fmt(p.invalidation)}</span></div>
            <div class="pl"><span class="k">reward : risk</span><span class="v">${rr}</span></div>
          </div>
          <div class="confbar"><div style="width:${p.confidence}%"></div></div>
          <div class="muted small" style="margin-top:5px">
            ${p.confidence}% confidence${p.stage === 'confirmed' && p.barsSinceTrigger != null
              ? ` · broke out ${p.barsSinceTrigger} bar${p.barsSinceTrigger === 1 ? '' : 's'} ago`
              : ''}${p.apexBarsAway != null && p.apexBarsAway > 0 ? ` · apex in ~${p.apexBarsAway} bars` : ''}
          </div>
        </div>`;
      })
      .join('');
  }

  const stale = a.technical.stalePatterns || [];
  $('stalePatterns').innerHTML = stale.length
    ? `Set aside as no longer actionable: ${stale.map((s) => `${s.name} (${s.staleReason})`).join('; ')}.`
    : '';
}

function renderFactors(a) {
  if (!a.macro) return;
  $('profileTag').textContent = a.macro.profile.label;
  $('profileThesis').textContent = a.macro.profile.thesis;

  $('factors').innerHTML = a.macro.factors
    .map((f) => {
      const pct = Math.abs(f.stance) * 50;
      const color = f.contribution > 0 ? 'var(--bull)' : f.contribution < 0 ? 'var(--bear)' : 'var(--muted)';
      const bar =
        f.stance >= 0
          ? `<span style="left:50%;width:${pct}%;background:${color}"></span>`
          : `<span style="right:50%;width:${pct}%;background:${color}"></span>`;
      const corr =
        f.observedCorrelation == null
          ? ''
          : ` · 90-day correlation ${f.observedCorrelation > 0 ? '+' : ''}${f.observedCorrelation}`;
      return `
      <div class="factor">
        <div class="factor-head">
          <span class="factor-name">${f.label}</span>
          <span class="factor-reading">${f.value}</span>
          <span class="factor-weight">${(f.weight * 100).toFixed(0)}% · ${signed(f.contribution, 1)}</span>
        </div>
        <div class="factor-bar"><span class="mid"></span>${bar}</div>
        <div class="factor-detail">${f.detail}</div>
        <div class="factor-detail" style="opacity:.75;margin-top:3px">
          Why it is weighted here: ${f.note}. Source: ${f.source}${corr}.
        </div>
        ${f.conflict
          ? `<div class="factor-flag">This asset is currently moving <b>against</b> its textbook relationship with
             ${f.label.toLowerCase()} (correlation ${f.observedCorrelation}). The model has followed the market and
             flipped the sign rather than assuming the historical relationship still holds.</div>`
          : ''}
      </div>`;
    })
    .join('');

  $('dataQuality').textContent =
    `${a.macro.dataQuality.note} Weights start from a prior for this asset class and are then scaled by how ` +
    `closely the asset has actually tracked each factor over the last 90 sessions.`;
}

function renderLevels(a) {
  const levels = a.technical.levels || [];
  $('levels').innerHTML = levels.length
    ? levels
        .map(
          (l) => `
      <div class="row">
        <span class="pill ${l.type}">${l.type}</span>
        <span class="lvl">${fmt(l.price)}</span>
        <span class="dist">${signed(l.distancePct, 1)}%</span>
        <span class="strength"><div style="width:${l.strength}%"></div></span>
        <span class="meta">${l.touches} touch${l.touches === 1 ? '' : 'es'}</span>
      </div>`
        )
        .join('')
    : '<div class="empty">No clustered levels found.</div>';

  const vp = a.technical.volumeProfile;
  if (vp) {
    $('levels').innerHTML += `
      <div class="row"><span class="meta" style="padding-top:6px">
        Volume point of control <b>${fmt(vp.pointOfControl)}</b>,
        value area ${fmt(vp.valueAreaLow)} – ${fmt(vp.valueAreaHigh)}.
      </span></div>`;
  }
}

function renderContributions(a) {
  const list = a.technical.contributions || [];
  const max = Math.max(...list.map((c) => Math.abs(c.points)), 10);
  $('contributions').innerHTML = list
    .map((c) => {
      const w = (Math.abs(c.points) / max) * 50;
      const color = c.points > 0 ? 'var(--bull)' : c.points < 0 ? 'var(--bear)' : 'var(--muted)';
      const bar =
        c.points >= 0
          ? `<b style="left:50%;width:${w}%;background:${color}"></b>`
          : `<b style="right:50%;width:${w}%;background:${color}"></b>`;
      return `
      <div class="contrib">
        <span class="name">${c.label}</span>
        <span class="track"><span class="zero"></span>${bar}</span>
        <span class="pts" style="color:${color}">${signed(c.points, 1)}</span>
        <span class="why">${c.detail}</span>
      </div>`;
    })
    .join('');
}

function renderInvalidation(a) {
  $('invalidation').innerHTML = (a.invalidation || []).map((i) => `<li>${i.text}</li>`).join('');
}

function render(a) {
  current = a;
  $('main').hidden = false;
  renderVerdict(a);
  renderPatterns(a);
  renderFactors(a);
  renderLevels(a);
  renderContributions(a);
  renderInvalidation(a);
  $('chartLegend').innerHTML = window.MarketChart.chartLegend(a);
  window.MarketChart.drawChart($('chart'), a);
  $('chartNote').textContent =
    `Formations are searched over the ${a.technical.view.bars.length} most recent bars; indicators use the full ` +
    `${a.barCount}-bar history. Only the highest-confidence formation is drawn.`;
  $('narrative').innerHTML = '';
  // Chain fetch runs behind the main render so the chart is never held up by it.
  loadCovered(a.symbol);
}

// ---------- actions ----------

async function analyze() {
  const symbol = $('symbol').value.trim();
  if (!symbol) return status('Enter a symbol first.', true);
  const timeframe = $('timeframe').value;

  $('run').disabled = true;
  status('Pulling price history and macro factors…', false, true);
  try {
    const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    render(data);
    status('');
    history.replaceState(null, '', `?symbol=${encodeURIComponent(symbol)}&tf=${timeframe}`);
  } catch (err) {
    status(err.message, true);
    setTimeout(() => status(''), 6000);
  } finally {
    $('run').disabled = false;
  }
}

async function writeup() {
  if (!current) return;
  if (!config.llm) return status('Set ANTHROPIC_API_KEY in .env to enable the written briefing.', true);

  const btn = $('writeup');
  btn.disabled = true;
  btn.textContent = 'Writing…';
  $('narrative').innerHTML = '<p class="muted"><span class="spin"></span>Claude is reading the analysis…</p>';
  try {
    const res = await fetch('/api/narrative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: current.symbol,
        timeframe: current.timeframe,
        question: $('question').value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (data.error || !data.text) throw new Error(data.error || 'No text returned');
    $('narrative').innerHTML = renderMarkdown(data.text);
  } catch (err) {
    $('narrative').innerHTML = `<p style="color:var(--bear)">${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regenerate';
  }
}

// ---------- symbol search ----------

let searchTimer = null;
$('symbol').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('symbol').value.trim();
  if (q.length < 2) return ($('suggestions').hidden = true);
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const { results } = await res.json();
      if (!results?.length) return ($('suggestions').hidden = true);
      $('suggestions').innerHTML = results
        .map(
          (r) =>
            `<div data-sym="${r.symbol}"><span class="sym">${r.symbol}</span>${r.name}<span class="ex">${r.exchange || r.type || ''}</span></div>`
        )
        .join('');
      $('suggestions').hidden = false;
    } catch {
      $('suggestions').hidden = true;
    }
  }, 220);
});

$('suggestions').addEventListener('click', (e) => {
  const row = e.target.closest('[data-sym]');
  if (!row) return;
  $('symbol').value = row.dataset.sym;
  $('suggestions').hidden = true;
  analyze();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.symbol-wrap')) $('suggestions').hidden = true;
});

$('symbol').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { $('suggestions').hidden = true; analyze(); }
});

$('run').addEventListener('click', analyze);
$('writeup').addEventListener('click', writeup);
$('timeframe').addEventListener('change', () => { if (current) analyze(); });
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sym]');
  if (!b) return;
  $('symbol').value = b.dataset.sym;
  analyze();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (current) window.MarketChart.drawChart($('chart'), current); }, 120);
});

// ---------- boot ----------

(async function boot() {
  try {
    config = await (await fetch('/api/config')).json();
  } catch { /* defaults are fine */ }

  $('timeframe').innerHTML = config.timeframes
    .map((t) => `<option value="${t.id}"${t.id === '1d' ? ' selected' : ''}>${t.label}</option>`)
    .join('');

  if (!config.llm) {
    $('writeup').disabled = true;
    $('writeup').title = 'Set ANTHROPIC_API_KEY in .env to enable';
  }

  $("scanUniverse").innerHTML = (config.universes || [])
    .map((u) => `<option value="${u.id}">${u.label} (${u.size})</option>`)
    .join("");

  if (config.auth) {
    $('lock').hidden = false;
    $('lock').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/login';
    });
  }

  const params = new URLSearchParams(location.search);
  const sym = params.get('symbol');
  if (sym) {
    $('symbol').value = sym;
    if (params.get('tf')) $('timeframe').value = params.get('tf');
    analyze();
  }
})();

// ---------- covered calls ----------

let ccData = null;

// 1st / 2nd / 3rd / 11th - used for the volatility-index percentile.
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

function ccScoreColor(s) {
  if (s >= 70) return 'var(--bull)';
  if (s >= 55) return 'var(--accent)';
  if (s >= 40) return 'var(--warn)';
  return 'var(--bear)';
}

function renderProxies(d) {
  $('ccExpiry').hidden = true;
  $('ccStamp').textContent = '';
  if (!d.proxies?.length) {
    $('covered').innerHTML = `<div class="empty">${d.reason} ${d.hint || ''}</div>`;
    return;
  }
  $('covered').innerHTML =
    `<div class="empty" style="padding-bottom:12px">${d.reason} ${d.hint}</div>` +
    `<div class="cc-proxy">${d.proxies
      .map(
        (p) => `<div class="p">
          <button data-proxy="${p.symbol}">${p.symbol}</button>
          <span class="pn">${p.note}</span>
        </div>`
      )
      .join('')}</div>`;
}

function renderCovered(d) {
  ccData = d;
  if (!d.available) return renderProxies(d);

  const v = d.volatility;
  const em = v.expectedMove;

  $('ccStamp').textContent = `${d.symbol} ${d.spot} · quotes delayed ~15 min`;
  const sel = $('ccExpiry');
  sel.hidden = false;
  sel.innerHTML = d.expiries
    .map((e) => `<option value="${e.expiry}"${e.expiry === d.expiry.expiry ? ' selected' : ''}>${e.expiry} · ${e.dte}d</option>`)
    .join('');

  const gate = [
    ['Implied vol', v.impliedVol == null ? '—' : `${v.impliedVol}%`],
    ['Realized vol', v.realizedVol == null ? '—' : `${v.realizedVol}%`],
    ['IV / RV', v.ratio == null ? '—' : v.ratio.toFixed(2)],
    ['Expected move', em ? `±${em.oneSigmaPct.toFixed(1)}%` : '—'],
  ];
  if (v.volIndex) gate.push([v.volIndex.label, `${v.volIndex.value} · ${ordinal(v.volIndex.percentile)} pct`]);

  const rows = d.strikes
    .map((s, i) => {
      const res = s.strongestResistance
        ? `${s.resistanceCount}&nbsp;@&nbsp;${fmt(s.strongestResistance.price)}`
        : '—';
      const br = s.historicalBreach ? `${s.historicalBreach.finishAbove}%` : '—';
      return `<tr class="${i === 0 ? 'pick' : ''}${s.belowThesisCeiling ? ' flagged' : ''}">
        <td><span class="sc" style="background:${ccScoreColor(s.score)}22;color:${ccScoreColor(s.score)}">${s.score}</span></td>
        <td>${fmt(s.strike, 2)}</td>
        <td>${s.moneyness.toFixed(1)}%</td>
        <td>${fmt(s.bid, 2)}</td>
        <td>${s.premiumPct.toFixed(2)}%</td>
        <td>${s.staticAnnual.toFixed(1)}%</td>
        <td>${s.delta == null ? '—' : s.delta.toFixed(2)}</td>
        <td>${s.sigmaDistance == null ? '—' : s.sigmaDistance.toFixed(2)}</td>
        <td>${res}</td>
        <td>${br}</td>
        <td>${fmt(s.breakeven, 2)}</td>
      </tr>`;
    })
    .join('');

  const top = d.strikes[0];
  const why = top
    ? `<div class="cc-why"><b>Why ${fmt(top.strike, 2)} ranks first</b>` +
      top.components
        .map(
          (c) =>
            `<span class="comp"><span class="pt" style="color:${c.points > 0 ? 'var(--bull)' : 'var(--bear)'}">${
              c.points > 0 ? '+' : ''
            }${c.points.toFixed(1)}</span> <b>${c.label}</b> — ${c.detail}</span>`
        )
        .join('') +
      `</div>`
    : '';

  $('covered').innerHTML = `
    <div class="cc-verdict ${d.verdict.verdict}">
      <span class="vlabel">${d.verdict.verdict}</span>
      <ul>${d.verdict.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
    </div>
    <div class="cc-gate">${gate
      .map(([k, val]) => `<div class="g"><span class="gk">${k}</span><span class="gv">${val}</span></div>`)
      .join('')}</div>
    ${
      d.strikes.length
        ? `<table class="cc-table">
      <thead><tr>
        <th>Score</th><th>Strike</th><th>OTM</th><th>Bid</th><th>Prem</th>
        <th>Ann.</th><th>Delta</th><th>σ</th><th>Res below</th><th>Hist. breach</th><th>Breakeven</th>
      </tr></thead>
      <tbody>${rows}</tbody></table>${why}`
        : '<div class="empty">No out-of-the-money call in this expiry clears the minimum premium worth selling.</div>'
    }
    <p class="muted small" style="margin-bottom:0">
      Premium is quoted at the bid, which is what you would actually receive. "Hist. breach" is how often this
      underlying has historically gained at least that much over a comparable window, pooled across all regimes —
      a base rate, not a forecast. Delayed quotes: use for strike selection, not execution.
    </p>`;
}

async function loadCovered(symbol, expiry) {
  $('covered').innerHTML = '<div class="empty"><span class="spin"></span>Pulling the options chain…</div>';
  $('ccExpiry').hidden = true;
  $('ccStamp').textContent = '';
  try {
    const url = `/api/covered?symbol=${encodeURIComponent(symbol)}${expiry ? `&expiry=${expiry}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    renderCovered(data);
  } catch (err) {
    $('covered').innerHTML = `<div class="empty" style="color:var(--bear)">${err.message}</div>`;
  }
}

$('ccExpiry').addEventListener('change', () => {
  if (current) loadCovered(ccData?.symbol || current.symbol, $('ccExpiry').value);
});

$('covered').addEventListener('click', (e) => {
  const b = e.target.closest('[data-proxy]');
  if (!b) return;
  $('symbol').value = b.dataset.proxy;
  analyze();
});

// ---------- opportunity scan ----------

function setupScoreColor(s) {
  if (s >= 75) return 'var(--bull)';
  if (s >= 60) return 'var(--accent)';
  if (s >= 45) return 'var(--warn)';
  return 'var(--muted)';
}

function renderSetup(s) {
  const long = s.direction === 'long';
  const p = s.pattern;
  const color = setupScoreColor(s.score);
  const levels = p
    ? `<div class="setup-levels">
         <div><span class="k">${p.triggerLabel || 'trigger'}</span><span class="v">${fmt(p.trigger, 2)}</span></div>
         <div><span class="k">target</span><span class="v">${fmt(p.target, 2)}</span></div>
         <div><span class="k">invalidation</span><span class="v">${fmt(p.invalidation, 2)}</span></div>
         <div><span class="k">r:r</span><span class="v">${p.riskReward ?? '—'}</span></div>
       </div>`
    : '';
  return `
    <div class="setup" data-sym="${s.symbol}">
      <div class="setup-head">
        <span class="setup-score" style="background:${color}22;color:${color}">${s.score}</span>
        <span class="setup-sym">${s.symbol}</span>
        <span class="setup-name">${s.name || ''}</span>
        <span class="setup-px">${fmt(s.price, 2)}</span>
      </div>
      ${p ? `<div class="setup-pattern"><b>${p.name}</b> <span class="badge ${p.stage}">${p.stage}</span></div>` : ''}
      ${levels}
      <div class="setup-why${s.twoSided ? ' setup-flag' : ''}">${s.reasons.join(' · ')}</div>
    </div>`;
}

function renderScan(d) {
  $('scanMeta').textContent =
    `${d.scanned} symbols · ${d.universeLabel} · ${(d.elapsedMs / 1000).toFixed(1)}s` +
    (d.failed?.length ? ` · ${d.failed.length} unavailable` : '');

  const col = (title, rows, cls) => `
    <div class="scan-col ${cls}">
      <h4>${title} <span>${rows.length ? `${rows.length} ranked` : 'nothing worth listing'}</span></h4>
      ${rows.length ? rows.map(renderSetup).join('') : '<div class="empty">No setup in this direction cleared the bar.</div>'}
    </div>`;

  $('scanBody').innerHTML = `
    <div class="scan-cols">
      ${col('Best longs', d.longs, 'long')}
      ${col('Best shorts', d.shorts, 'short')}
    </div>
    <p class="scan-foot">
      Ranked by how tradeable the setup is right now — a defined trigger, a level that says you were wrong, and a
      payoff worth the risk — not by how bullish or bearish the asset looks. A confirmed break that already ran
      several ATR past its trigger scores <em>lower</em> than one that just fired, because the entry is spent.
      Click any row for the full analysis. ${d.universeNote}
      ${d.tooQuiet?.length
        ? `<br><br><b>${d.tooQuiet.length} excluded as too quiet</b> — under ${d.minAtrPct}% average daily range,
           where a measured move is smaller than the spread it costs to trade:
           ${d.tooQuiet.map((q) => `${q.symbol} ${q.atrPct}%`).join(', ')}.`
        : ''}
    </p>`;
}

async function loadScan(universe) {
  $('scanSection').hidden = false;
  $('scanBody').innerHTML = '<div class="empty"><span class="spin"></span>Scanning for setups…</div>';
  try {
    const res = await fetch(`/api/scan?universe=${encodeURIComponent(universe)}&limit=6`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    renderScan(data);
  } catch (err) {
    $('scanBody').innerHTML = `<div class="empty" style="color:var(--bear)">${err.message}</div>`;
  }
}

$('scanBtn').addEventListener('click', () => {
  if (!$('scanSection').hidden) return ($('scanSection').hidden = true);
  loadScan($('scanUniverse').value || 'core');
});
$('scanRefresh').addEventListener('click', () => loadScan($('scanUniverse').value || 'core'));
$('scanUniverse').addEventListener('change', () => loadScan($('scanUniverse').value));
$('scanBody').addEventListener('click', (e) => {
  const row = e.target.closest('[data-sym]');
  if (!row) return;
  $('symbol').value = row.dataset.sym;
  analyze();
  document.getElementById('main').scrollIntoView({ behavior: 'smooth' });
});
