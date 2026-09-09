// FRED economic data, with a keyless fallback for the yield curve so the macro
// layer still produces a real curve reading when no API key is configured.
import { cached } from '../cache.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

export function hasFredKey() {
  return Boolean(process.env.FRED_API_KEY);
}

// Returns { date: value } for the last `years` years, nulls dropped.
export async function fredSeries(seriesId, years = 3) {
  if (!hasFredKey()) return null;
  return cached(`fred:${seriesId}:${years}`, 6 * 3600_000, async () => {
    const start = new Date();
    start.setFullYear(start.getFullYear() - years);
    const url =
      `${FRED_BASE}?series_id=${seriesId}` +
      `&api_key=${process.env.FRED_API_KEY}` +
      `&file_type=json&observation_start=${start.toISOString().slice(0, 10)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      const json = await res.json();
      const out = {};
      for (const o of json.observations || []) {
        const v = Number(o.value);
        if (Number.isFinite(v)) out[o.date] = v;
      }
      return Object.keys(out).length ? out : null;
    } catch {
      return null;
    }
  });
}

// US Treasury publishes the daily par yield curve as CSV with no key. Used
// when FRED is unavailable so the curve factor never goes dark.
export async function treasuryCurve() {
  return cached('treasury:curve', 6 * 3600_000, async () => {
    const year = new Date().getFullYear();
    const url =
      `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all` +
      `?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return null;
      const text = await res.text();
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) return null;

      // Header is quoted and column order is not guaranteed, so resolve by name.
      const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
      const idx = (name) => header.indexOf(name);
      const iDate = 0;
      const i2 = idx('2 Yr');
      const i10 = idx('10 Yr');
      const i3m = idx('3 Mo');
      if (i2 < 0 || i10 < 0) return null;

      const rows = [];
      for (const line of lines.slice(1)) {
        const cells = line.split(',').map((c) => c.replace(/"/g, '').trim());
        const y2 = Number(cells[i2]);
        const y10 = Number(cells[i10]);
        if (!Number.isFinite(y2) || !Number.isFinite(y10)) continue;
        rows.push({
          date: new Date(cells[iDate]).toISOString().slice(0, 10),
          y3m: i3m >= 0 ? Number(cells[i3m]) : null,
          y2,
          y10,
          spread: y10 - y2,
        });
      }
      // The CSV arrives newest-first; sort ascending so "latest" is the tail.
      rows.sort((a, b) => a.date.localeCompare(b.date));
      return rows.length ? rows : null;
    } catch {
      return null;
    }
  });
}
