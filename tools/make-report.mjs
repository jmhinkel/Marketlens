// Generates a standalone, self-contained HTML report of the current setup
// targets. No external CSS, fonts or scripts, so the output can be dropped on
// any host or emailed as a single file.
//
//   node tools/make-report.mjs                      -> core + vaneck
//   node tools/make-report.mjs wide vaneck          -> chosen universes
//   node tools/make-report.mjs --out targets.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanUniverse, UNIVERSES } from '../lib/scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join(here, '..', 'setup-targets.html');
const universes = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
const picked = universes.length ? universes : ['core', 'vaneck'];

// A stop sitting a few cents from entry produces an arithmetically enormous
// reward-to-risk that is pure artifact - the risk is inside the spread. Real
// setups do not offer 100:1, and publishing one would be embarrassing.
const MAX_CREDIBLE_RR = 20;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 0 : a >= 100 ? 2 : a >= 1 ? 2 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

async function collect() {
  const rows = [];
  const seen = new Set();
  const dropped = [];

  for (const u of picked) {
    if (!UNIVERSES[u]) throw new Error(`Unknown universe "${u}". Options: ${Object.keys(UNIVERSES).join(', ')}`);
    const scan = await scanUniverse({ universe: u, limit: 8 });
    for (const dir of ['longs', 'shorts']) {
      for (const s of scan[dir]) {
        const key = `${dir}:${s.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const p = s.pattern;
        if (!p || p.target == null) continue;
        if (p.riskReward != null && p.riskReward > MAX_CREDIBLE_RR) {
          dropped.push({ symbol: s.symbol, riskReward: p.riskReward });
          continue;
        }
        rows.push({ ...s, side: dir === 'longs' ? 'long' : 'short', universe: u });
      }
    }
  }
  return { rows, dropped };
}

function table(rows, side) {
  const list = rows.filter((r) => r.side === side).sort((a, b) => b.score - a.score);
  if (!list.length) return `<p class="none">No ${side} setup cleared the bar in this scan.</p>`;

  return `<table>
  <thead><tr>
    <th class="l">Symbol</th><th>Price</th><th>Entry</th><th>Target</th><th>Stop</th>
    <th>R:R</th><th>To target</th><th class="l">Formation</th>
  </tr></thead>
  <tbody>
  ${list
    .map((r) => {
      const p = r.pattern;
      const move = ((p.target - r.price) / r.price) * 100;
      const thin = p.riskReward != null && p.riskReward < 1;
      return `<tr>
      <td class="l"><b>${esc(r.symbol)}</b><span class="nm">${esc((r.name || '').replace(/ ETF$/, ''))}</span></td>
      <td>${money(r.price)}</td>
      <td>${money(p.trigger)}</td>
      <td class="tgt">${money(p.target)}</td>
      <td>${money(p.invalidation)}</td>
      <td class="${thin ? 'warn' : ''}">${p.riskReward ?? '—'}</td>
      <td class="${move > 0 ? 'up' : 'dn'}">${move > 0 ? '+' : ''}${move.toFixed(1)}%</td>
      <td class="l">${esc(p.name)}<span class="stage ${p.stage}">${p.stage}</span></td>
    </tr>`;
    })
    .join('\n')}
  </tbody></table>`;
}

const { rows, dropped } = await collect();
const now = new Date();
const thinCount = rows.filter((r) => r.pattern.riskReward != null && r.pattern.riskReward < 1).length;
const confirmedShorts = rows.filter((r) => r.side === 'short' && r.pattern.stage === 'confirmed').length;

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Setup Targets — ${now.toISOString().slice(0, 10)}</title>
<style>
  :root { --bg:#0b0e14; --panel:#121722; --panel2:#171d2a; --line:#232b3a; --text:#e4e8f0;
          --muted:#8792a8; --accent:#5aa9ff; --bull:#2fbf83; --bear:#f0655d; --warn:#e0a458; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:15px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif;padding:32px 20px 60px}
  .wrap{max-width:1040px;margin:0 auto}
  header{display:flex;align-items:center;gap:13px;margin-bottom:6px}
  .mark{width:34px;height:34px;border-radius:9px;flex:none;
        background:conic-gradient(from 210deg,var(--accent),var(--bull),var(--warn),var(--accent))}
  h1{margin:0;font-size:21px;font-weight:600}
  .stamp{color:var(--muted);font-size:13px;margin:0 0 22px 47px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.9px;margin:30px 0 12px}
  h2.long{color:var(--bull)} h2.short{color:var(--bear)}
  .disclaimer{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--warn);
       border-radius:8px;padding:14px 17px;font-size:13.5px;color:var(--muted);line-height:1.65;margin-bottom:8px}
  .disclaimer b{color:var(--text)}
  table{width:100%;border-collapse:collapse;font-size:13.5px;
        font-variant-numeric:tabular-nums;margin-bottom:4px}
  th{text-align:right;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;
     color:var(--muted);font-weight:600;padding:7px 9px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{text-align:right;padding:10px 9px;border-bottom:1px solid var(--line);
     font-family:ui-monospace,Consolas,monospace}
  th.l,td.l{text-align:left}
  td.l{font-family:inherit}
  .nm{display:block;color:var(--muted);font-size:11.5px;font-family:inherit}
  .tgt{color:var(--accent);font-weight:600}
  .up{color:var(--bull)} .dn{color:var(--bear)} .warn{color:var(--warn)}
  .stage{display:inline-block;margin-left:7px;font-size:9.5px;text-transform:uppercase;
         letter-spacing:.5px;padding:1px 6px;border-radius:3px;vertical-align:1px}
  .stage.confirmed{background:rgba(90,169,255,.16);color:var(--accent)}
  .stage.forming{background:rgba(224,164,88,.16);color:var(--warn)}
  .notes{background:var(--panel);border:1px solid var(--line);border-radius:8px;
         padding:16px 19px;margin-top:26px;font-size:13.5px;color:var(--muted)}
  .notes h3{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text);margin:0 0 9px}
  .notes li{margin-bottom:7px}
  .notes ul{margin:0;padding-left:19px}
  .none{color:var(--muted);font-size:14px}
  footer{color:var(--muted);font-size:12px;margin-top:26px;line-height:1.7}
  @media(max-width:700px){ body{padding:20px 12px 40px} th,td{padding:7px 5px;font-size:12px} .nm{display:none} }
</style></head>
<body><div class="wrap">

<header><span class="mark"></span><h1>Setup Targets</h1></header>
<p class="stamp">Generated ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}
   · ${picked.map((p) => UNIVERSES[p].label).join(' + ')} universe${picked.length > 1 ? 's' : ''}
   · ${rows.length} setups</p>

<div class="disclaimer">
  <b>This is not investment advice.</b> These are levels computed from chart geometry by an automated
  model. They take no account of anyone's circumstances, objectives or risk tolerance, they are not a
  recommendation or solicitation to buy or sell anything, and no one should act on them without doing
  their own work. Targets are <b>measured moves</b> — the distance implied by the formation projected
  from its trigger — not forecasts, and they carry no probability of being reached. Past price
  structure does not predict future prices. Data is delayed and may be wrong.
</div>

<h2 class="long">Longs</h2>
${table(rows, 'long')}

<h2 class="short">Shorts</h2>
${table(rows, 'short')}

<div class="notes">
  <h3>How to read this</h3>
  <ul>
    <li><b>Entry</b> is the formation's trigger level, <b>Stop</b> is the level that invalidates it, and
        <b>Target</b> is the measured move projected from the trigger.</li>
    <li><b>Check the R:R column before the target column.</b>${
      thinCount
        ? ` ${thinCount} of these setups carry reward-to-risk below 1 — the target is close and the
            invalidation is far, so the geometry does not pay well even if the direction is right.`
        : ''
    }</li>
    <li><b>"Confirmed" means already triggered.</b>${
      confirmedShorts
        ? ` ${confirmedShorts} of the shorts have already broken their level, so part of the move to
            target may be spent. Check how far price has run past entry.`
        : ''
    }</li>
    <li>Scores rank how <em>tradeable</em> the setup is — a defined trigger, a level that says you were
        wrong, a payoff worth the risk — not how bullish or bearish the asset looks.</li>
    ${
      dropped.length
        ? `<li>Excluded as arithmetic artifacts: ${dropped
            .map((d) => `${esc(d.symbol)} (${d.riskReward}:1)`)
            .join(', ')} — the stop sits inside the spread, which inflates reward-to-risk
            without reflecting any real edge.</li>`
        : ''
    }
  </ul>
</div>

<footer>
  Produced by Market Lens. Price history from Yahoo Finance; macro factors derived from market prices,
  not a live news feed. Formations searched over the last 320 daily bars.
</footer>

</div></body></html>`;

fs.writeFileSync(outPath, html, 'utf8');
console.log(`Wrote ${outPath}`);
console.log(`  ${rows.filter((r) => r.side === 'long').length} longs, ${rows.filter((r) => r.side === 'short').length} shorts`);
if (dropped.length) console.log(`  dropped as artifacts: ${dropped.map((d) => `${d.symbol} (${d.riskReward}:1)`).join(', ')}`);
