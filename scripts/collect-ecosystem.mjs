/**
 * collect-ecosystem.mjs
 *
 * Weekly collector for trending new npm packages in the AI/agentic ecosystem.
 * Runs in GitHub Actions every Sunday at 06:00 UTC.
 *
 * Output: data/ecosystem/YYYY-WW.json  (one file per ISO week)
 *         data/ecosystem/latest.json   (always points to most recent run)
 *
 * Schema of each output file:
 * {
 *   week: "2026-W24",
 *   generated: "2026-06-15T06:00:00.000Z",
 *   categories: {
 *     mcp: [ PackageEntry, ... ],
 *     ...
 *   },
 *   top_by_downloads: [ PackageEntry, ... ],   // top 20 overall
 *   top_by_growth:    [ PackageEntry, ... ],   // top 20 by week-over-week %
 * }
 *
 * PackageEntry: {
 *   name, description, date,        // from npm registry
 *   repo,                            // GitHub repo URL if available
 *   this_week, prev_week,           // download counts
 *   growth_pct,                     // null if prev_week === 0 (brand new)
 *   keyword,                        // category keyword that surfaced it
 * }
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ECO_DIR = join(ROOT, 'data', 'ecosystem');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KEYWORDS = [
  'mcp',
  'ai sdk',
  'llm',
  'ai agent',
  'rag',
  'openai',
  'anthropic',
  'embedding',
  'vector store',
  'agentic',
];

// Only include packages published within this many days
const RECENCY_DAYS = 60;

// Minimum downloads in current week to be included
const MIN_DOWNLOADS = 200;

// Max packages to fetch per keyword search
const SEARCH_SIZE = 25;

// Delay between batched API calls (ms) — stay well under rate limits
const BATCH_DELAY = 400;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil((((d - yearStart) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}

function dateRange(offsetWeeks = 0) {
  // Returns YYYY-MM-DD:YYYY-MM-DD for a complete Mon–Sun week.
  // offsetWeeks=0 → last fully completed week
  // offsetWeeks=-1 → the week before that
  // "Last complete week" = the Mon–Sun block that ended before today's Monday.
  // When run on Sunday the current week is still in progress, so we go back
  // an extra 7 days to ensure we always land on a completed week.
  const now = new Date();
  const day = now.getUTCDay() || 7; // 1=Mon … 7=Sun
  // Days since last Monday (0 if today is Monday)
  const daysSinceMon = day - 1;
  // Monday of the last *complete* week
  const lastMon = new Date(now);
  lastMon.setUTCDate(now.getUTCDate() - daysSinceMon - 7 + (offsetWeeks * 7));
  const lastSun = new Date(lastMon);
  lastSun.setUTCDate(lastMon.getUTCDate() + 6);
  const fmt = d => d.toISOString().slice(0, 10);
  return `${fmt(lastMon)}:${fmt(lastSun)}`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJSON(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'npm-analytics-ecosystem/1.0' } });
      if (res.status === 429) {
        const wait = 5000 * (attempt + 1);
        console.error(`[rate-limit] 429 on ${url}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      if (attempt === retries - 1) {
        console.error(`[fetch-error] ${url}: ${err.message}`);
        return null;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// npm search — returns packages sorted by popularity matching keyword,
// filtered to those published within RECENCY_DAYS
// ---------------------------------------------------------------------------

async function searchRecent(keyword) {
  const q = encodeURIComponent(keyword);
  const url = `https://registry.npmjs.org/-/v1/search?text=${q}&quality=0.0&popularity=1.0&maintenance=0.0&size=${SEARCH_SIZE}`;
  const data = await fetchJSON(url);
  if (!data?.objects) return [];

  const cutoff = Date.now() - RECENCY_DAYS * 86400000;
  return data.objects
    .filter(o => {
      const d = o.package?.date;
      return d && new Date(d).getTime() >= cutoff;
    })
    .map(o => ({
      name: o.package.name,
      description: (o.package.description || '').slice(0, 120),
      date: o.package.date?.slice(0, 10) || '',
      repo: extractRepo(o.package),
      keyword,
    }));
}

function extractRepo(pkg) {
  const links = pkg.links || {};
  return links.repository || links.homepage || '';
}

// ---------------------------------------------------------------------------
// npm downloads API
// Scoped packages (@org/pkg) must be fetched individually.
// Unscoped packages can be batched (comma-separated, up to ~128 names).
// ---------------------------------------------------------------------------

async function getDownloads(names, period) {
  const scoped = names.filter(n => n.startsWith('@'));
  const unscoped = names.filter(n => !n.startsWith('@'));
  const result = {};

  // Unscoped — batch
  for (let i = 0; i < unscoped.length; i += 10) {
    const batch = unscoped.slice(i, i + 10);
    const url = `https://api.npmjs.org/downloads/point/${period}/${batch.join(',')}`;
    const data = await fetchJSON(url);
    if (data && !data.error) {
      if (batch.length === 1 && 'downloads' in data) {
        result[batch[0]] = data.downloads ?? 0;
      } else {
        for (const [k, v] of Object.entries(data)) {
          result[k] = v?.downloads ?? 0;
        }
      }
    }
    await sleep(BATCH_DELAY);
  }

  // Scoped — individual
  for (const name of scoped) {
    const encoded = encodeURIComponent(name);
    const url = `https://api.npmjs.org/downloads/point/${period}/${encoded}`;
    const data = await fetchJSON(url);
    result[name] = data?.downloads ?? 0;
    await sleep(200);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error('[ecosystem] Starting collection...');

  // 1. Collect unique recent packages across all keywords
  const seen = new Map(); // name -> entry (first keyword wins)
  for (const kw of KEYWORDS) {
    console.error(`[search] keyword: ${kw}`);
    const results = await searchRecent(kw);
    for (const entry of results) {
      if (!seen.has(entry.name)) {
        seen.set(entry.name, entry);
      }
    }
    await sleep(300);
  }
  console.error(`[ecosystem] ${seen.size} unique packages found`);

  const allNames = [...seen.keys()];
  const thisWeekRange = dateRange(0);   // last complete week
  const prevWeekRange = dateRange(-1);  // week before that
  console.error(`[downloads] this week: ${thisWeekRange}, prev week: ${prevWeekRange}`);

  // 2. Fetch downloads
  const thisWeek = await getDownloads(allNames, thisWeekRange);
  const prevWeek = await getDownloads(allNames, prevWeekRange);

  // 3. Build enriched entries
  const entries = [];
  for (const [name, info] of seen.entries()) {
    const tw = thisWeek[name] ?? 0;
    const pw = prevWeek[name] ?? 0;
    if (tw < MIN_DOWNLOADS) continue;
    const growthPct = pw > 0 ? Math.round((tw - pw) / pw * 100) : null;
    entries.push({ ...info, this_week: tw, prev_week: pw, growth_pct: growthPct });
  }

  console.error(`[ecosystem] ${entries.length} packages with >${MIN_DOWNLOADS} downloads this week`);

  // 4. Group by category
  const categories = {};
  for (const kw of KEYWORDS) {
    const cat = entries.filter(e => e.keyword === kw).sort((a, b) => b.this_week - a.this_week);
    if (cat.length > 0) categories[kw] = cat;
  }

  // 5. Top lists
  const topByDownloads = [...entries].sort((a, b) => b.this_week - a.this_week).slice(0, 25);
  const topByGrowth = [...entries]
    .filter(e => e.growth_pct !== null && e.prev_week >= 100) // need baseline to be meaningful
    .sort((a, b) => b.growth_pct - a.growth_pct)
    .slice(0, 25);
  const brandNew = [...entries]
    .filter(e => e.growth_pct === null)
    .sort((a, b) => b.this_week - a.this_week)
    .slice(0, 15);

  // 6. Build output
  const week = isoWeek();
  const output = {
    week,
    generated: new Date().toISOString(),
    this_week_range: thisWeekRange,
    prev_week_range: prevWeekRange,
    total_packages_tracked: entries.length,
    categories,
    top_by_downloads: topByDownloads,
    top_by_growth: topByGrowth,
    brand_new: brandNew,   // first week tracked — no prev baseline
  };

  // 7. Write files
  mkdirSync(ECO_DIR, { recursive: true });
  const weekFile = join(ECO_DIR, `${week}.json`);
  const latestFile = join(ECO_DIR, 'latest.json');
  writeFileSync(weekFile, JSON.stringify(output, null, 2));
  writeFileSync(latestFile, JSON.stringify(output, null, 2));
  console.error(`[ecosystem] Written: ${weekFile}`);
  console.error(`[ecosystem] Written: ${latestFile}`);

  // Summary to stdout for Actions log
  console.log(`Ecosystem collection complete: ${entries.length} packages, week ${week}`);
  console.log(`Top by downloads: ${topByDownloads.slice(0, 5).map(e => e.name).join(', ')}`);
  console.log(`Top by growth:    ${topByGrowth.slice(0, 5).map(e => `${e.name} (+${e.growth_pct}%)`).join(', ')}`);
}

main().catch(err => {
  console.error('[ecosystem] Fatal error:', err);
  process.exit(1);
});
