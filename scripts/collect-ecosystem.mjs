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
 *   this_week_range, prev_week_range,
 *   total_packages_tracked: N,     // packages that passed MIN_DOWNLOADS
 *   packages_found: N,             // all unique packages discovered
 *   packages_fetch_failed: N,      // packages where download API failed
 *   categories: { keyword: [ PackageEntry, ... ], ... },
 *   top_by_downloads: [ PackageEntry, ... ],   // top 25 by this_week downloads
 *   top_by_growth:    [ PackageEntry, ... ],   // top 25 by week-over-week %
 *   brand_new:        [ PackageEntry, ... ],   // new packages, no prev baseline
 *   fetch_failed:     [ PackageEntry, ... ],   // couldn't get download counts
 * }
 *
 * PackageEntry: {
 *   name, description, date,        // from npm registry
 *   repo,                            // GitHub repo URL if available
 *   this_week, prev_week,           // download counts (null = fetch failed)
 *   growth_pct,                     // null if prev_week === 0 or null (brand new / fetch failed)
 *   fetch_failed,                   // true if download fetch failed
 *   keyword,                        // category keyword that surfaced it
 *   gh_stars,                        // GitHub stars (null = no repo / fetch failed)
 *   days_since_publish,             // integer days since first npm publish
 *   quality_score,                  // npms.io composite score 0..1 (null = unavailable)
 *   growth_streak,                  // consecutive weeks of positive WoW growth (0 = new/flat/down)
 * }
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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

// Minimum downloads in current week to be included in main output lists
// Packages that FAILED to fetch downloads are NOT filtered by this threshold.
const MIN_DOWNLOADS = 200;

// Max packages to fetch per keyword search
const SEARCH_SIZE = 25;

// Delay between unscoped batch API calls (ms)
const BATCH_DELAY_UNSCOPED = 800;

// Delay between individual scoped package API calls (ms)
// npm downloads API rate limit is ~1 req/sec for scoped packages
const BATCH_DELAY_SCOPED = 700;

// Delay between npms.io quality score fetches (ms) — their API is generous but be polite
const BATCH_DELAY_NPMS = 300;

// Delay between GitHub API calls (ms) — unauthenticated: 60 req/min
const BATCH_DELAY_GH = 1100;

// Max packages to enrich with GitHub stars (unauthenticated rate limit friendly)
const MAX_GH_ENRICHMENT = 50;

// Retry config — exponential backoff with jitter
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 8000;   // first wait
const RETRY_CAP_MS = 120000;  // max wait per attempt

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
  // offsetWeeks=0  → last fully completed week
  // offsetWeeks=-1 → the week before that
  //
  // "Last complete week" = Mon–Sun that ended before today.
  // Works correctly on all days including Sunday (day=7 means current week
  // started 6 days ago — we step back another 7 to land on the prior week).
  const now = new Date();
  const day = now.getUTCDay() || 7; // 1=Mon … 7=Sun
  // Days elapsed since this week's Monday (0 if today IS Monday)
  const daysSinceMon = day - 1;
  // Monday of the last *complete* week
  const lastMon = new Date(now);
  lastMon.setUTCHours(0, 0, 0, 0);
  lastMon.setUTCDate(now.getUTCDate() - daysSinceMon - 7 + (offsetWeeks * 7));
  const lastSun = new Date(lastMon);
  lastSun.setUTCDate(lastMon.getUTCDate() + 6);
  const fmt = d => d.toISOString().slice(0, 10);
  return `${fmt(lastMon)}:${fmt(lastSun)}`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch JSON with retry + exponential backoff on 429 and transient errors.
 * Returns parsed JSON on success, null if all retries exhausted or non-429 error.
 */
async function fetchJSON(url) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'npm-analytics-ecosystem/1.0' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      // Network error / timeout
      const wait = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_CAP_MS);
      console.error(`[fetch-error] attempt ${attempt + 1}/${MAX_RETRIES} ${url}: ${err.message}, waiting ${wait}ms`);
      if (attempt < MAX_RETRIES - 1) await sleep(wait + jitter());
      continue;
    }

    if (res.status === 429) {
      // Respect Retry-After header if present, otherwise exponential backoff
      const retryAfter = res.headers.get('retry-after');
      const wait = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_CAP_MS);
      console.error(`[rate-limit] 429 on ${url} (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${wait}ms`);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(wait + jitter());
        continue;
      } else {
        console.error(`[rate-limit] Giving up on ${url} after ${MAX_RETRIES} attempts`);
        return null;
      }
    }

    if (res.status === 404) return null; // package doesn't exist in downloads API

    if (!res.ok) {
      console.error(`[http-error] ${res.status} on ${url}`);
      return null;
    }

    try {
      return await res.json();
    } catch (err) {
      console.error(`[parse-error] ${url}: ${err.message}`);
      return null;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Add up to 500ms of jitter to prevent thundering herd after rate-limit waits */
function jitter() {
  return Math.floor(Math.random() * 500);
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
//
// Returns: { [name]: number | null }
//   number = download count
//   null   = fetch failed (rate limited / API error after all retries)
// ---------------------------------------------------------------------------

async function getDownloads(names, period) {
  const scoped = names.filter(n => n.startsWith('@'));
  const unscoped = names.filter(n => !n.startsWith('@'));
  const result = {};

  // Unscoped — batch in groups of 10
  for (let i = 0; i < unscoped.length; i += 10) {
    const batch = unscoped.slice(i, i + 10);
    const url = `https://api.npmjs.org/downloads/point/${period}/${batch.join(',')}`;
    const data = await fetchJSON(url);

    if (data === null || data?.error) {
      // Whole batch failed — mark each as null (not 0)
      for (const name of batch) result[name] = null;
    } else if (batch.length === 1 && 'downloads' in data) {
      result[batch[0]] = data.downloads ?? 0;
    } else {
      for (const name of batch) {
        const entry = data[name];
        // entry missing from response = package has no downloads (genuinely 0)
        // entry.error = API couldn't find package (treat as null, not 0)
        if (entry === undefined) {
          result[name] = null; // not in response at all — treat as failed
        } else if (entry?.error) {
          result[name] = null;
        } else {
          result[name] = entry?.downloads ?? 0;
        }
      }
    }
    if (i + 10 < unscoped.length) await sleep(BATCH_DELAY_UNSCOPED + jitter());
  }

  // Scoped — individual (npm downloads API doesn't support batching scoped packages)
  let scopedDone = 0;
  for (const name of scoped) {
    const encoded = encodeURIComponent(name);
    const url = `https://api.npmjs.org/downloads/point/${period}/${encoded}`;
    const data = await fetchJSON(url);
    // null = fetch failed after all retries; mark as null, NOT 0
    result[name] = (data === null || data?.error) ? null : (data.downloads ?? 0);
    scopedDone++;
    if (scopedDone < scoped.length) await sleep(BATCH_DELAY_SCOPED + jitter());
  }

  return result;
}

// ---------------------------------------------------------------------------
// Enrichment helpers — GitHub stars, npms.io quality, growth streak
// ---------------------------------------------------------------------------

/**
 * Extract the GitHub owner/repo slug from a repo URL.
 * Returns null if not a GitHub URL.
 */
function githubSlug(repoUrl) {
  if (!repoUrl) return null;
  const clean = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  const m = clean.match(/github\.com\/([^/]+\/[^/]+)/);
  return m ? m[1] : null;
}

/**
 * Fetch GitHub stars for a list of packages that have GitHub repo URLs.
 * Uses the unauthenticated GitHub API (60 req/min).
 * Enriches in-place: adds `gh_stars` field to each entry.
 * Only fetches for the top MAX_GH_ENRICHMENT packages by download count to
 * stay within rate limits.
 */
async function enrichGitHubStars(entries) {
  // Sort by downloads desc, take top N that have a GitHub repo
  const candidates = [...entries]
    .filter(e => githubSlug(e.repo))
    .sort((a, b) => (b.this_week ?? 0) - (a.this_week ?? 0))
    .slice(0, MAX_GH_ENRICHMENT);

  const slugToStars = {};
  let done = 0;
  for (const entry of candidates) {
    const slug = githubSlug(entry.repo);
    if (!slug || slugToStars[slug] !== undefined) {
      done++;
      continue;
    }
    const url = `https://api.github.com/repos/${slug}`;
    const data = await fetchJSON(url);
    slugToStars[slug] = data?.stargazers_count ?? null;
    done++;
    if (done < candidates.length) await sleep(BATCH_DELAY_GH + jitter());
  }

  // Apply to all entries (not just candidates)
  for (const entry of entries) {
    const slug = githubSlug(entry.repo);
    if (slug && slugToStars[slug] !== undefined) {
      entry.gh_stars = slugToStars[slug];
    } else {
      entry.gh_stars = null;
    }
  }
}

/**
 * Fetch npms.io quality scores for a batch of package names.
 * Uses the bulk POST endpoint (up to 250 packages per request).
 * Returns { [name]: score } where score is 0..1 or null.
 */
async function fetchNpmsScores(names) {
  const result = {};
  // Batch in groups of 100 to be safe
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    let data;
    try {
      const res = await fetch('https://api.npms.io/v2/package/mget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'npm-analytics-ecosystem/1.0' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { data = null; } else { data = await res.json(); }
    } catch { data = null; }

    if (data) {
      for (const name of batch) {
        const entry = data[name];
        result[name] = entry?.score?.final ?? null;
      }
    } else {
      for (const name of batch) result[name] = null;
    }
    if (i + 100 < names.length) await sleep(BATCH_DELAY_NPMS + jitter());
  }
  return result;
}

/**
 * Compute growth streaks from historical JSON files.
 * A streak = number of consecutive prior weeks where growth_pct > 0.
 * Reads YYYY-WW.json files from ECO_DIR, ordered newest-to-oldest.
 * Returns { [packageName]: streakCount }
 */
function computeGrowthStreaks(currentWeek) {
  const streaks = {};

  // Build the list by trying the last 12 weeks
  const weekHistory = [];
  const now = new Date();
  for (let w = 1; w <= 12; w++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - w * 7);
    const wLabel = isoWeek(d);
    if (wLabel === currentWeek) continue;
    const file = join(ECO_DIR, `${wLabel}.json`);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        weekHistory.push(parsed);
      } catch {}
    }
  }
  // weekHistory[0] = most recent prior week

  if (weekHistory.length === 0) return streaks;

  // Build lookup: { weekIdx -> { pkgName -> growth_pct } }
  const weekMaps = weekHistory.map(wdata => {
    const m = {};
    for (const entries of Object.values(wdata.categories || {})) {
      for (const e of entries) {
        m[e.name] = e.growth_pct;
      }
    }
    return m;
  });

  // For each package that appeared in the most recent week, count streak
  const allPkgNames = new Set(Object.keys(weekMaps[0] || {}));
  for (const name of allPkgNames) {
    let streak = 0;
    for (const wmap of weekMaps) {
      const gp = wmap[name];
      if (gp !== null && gp !== undefined && gp > 0) {
        streak++;
      } else {
        break; // streak broken
      }
    }
    streaks[name] = streak;
  }

  return streaks;
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
    await sleep(300 + jitter());
  }
  const totalFound = seen.size;
  console.error(`[ecosystem] ${totalFound} unique packages found`);

  const allNames = [...seen.keys()];
  const thisWeekRange = dateRange(0);   // last complete week
  const prevWeekRange = dateRange(-1);  // week before that
  console.error(`[downloads] this week: ${thisWeekRange}, prev week: ${prevWeekRange}`);

  // 2. Fetch downloads — returns null (not 0) on failure
  console.error(`[downloads] fetching this_week downloads for ${allNames.length} packages...`);
  const thisWeek = await getDownloads(allNames, thisWeekRange);

  console.error(`[downloads] fetching prev_week downloads for ${allNames.length} packages...`);
  const prevWeek = await getDownloads(allNames, prevWeekRange);

  // 3. Build enriched entries — separate qualified vs failed-fetch packages
  const qualifiedEntries = [];   // tw >= MIN_DOWNLOADS
  const fetchFailedEntries = []; // couldn't get downloads at all

  let fetchFailCount = 0;

  for (const [name, info] of seen.entries()) {
    const tw = thisWeek[name] ?? null;
    const pw = prevWeek[name] ?? null;

    if (tw === null) {
      // Download fetch failed — include separately, never filter by MIN_DOWNLOADS
      fetchFailCount++;
      fetchFailedEntries.push({ ...info, this_week: null, prev_week: pw, growth_pct: null, fetch_failed: true,
        gh_stars: null, days_since_publish: info.date ? Math.floor((Date.now() - new Date(info.date).getTime()) / 86400000) : null,
        quality_score: null, growth_streak: 0 });
      continue;
    }

    if (tw < MIN_DOWNLOADS) continue; // genuinely low-download, skip

    const growthPct = (pw !== null && pw > 0) ? Math.round((tw - pw) / pw * 100) : null;
    const daysSincePublish = info.date ? Math.floor((Date.now() - new Date(info.date).getTime()) / 86400000) : null;
    qualifiedEntries.push({ ...info, this_week: tw, prev_week: pw ?? null, growth_pct: growthPct, fetch_failed: false,
      gh_stars: null, days_since_publish: daysSincePublish, quality_score: null, growth_streak: 0 });
  }

  const totalTracked = qualifiedEntries.length;
  console.error(`[ecosystem] ${totalTracked} packages with >=${MIN_DOWNLOADS} downloads this week`);
  console.error(`[ecosystem] ${fetchFailCount} packages with failed download fetches (not filtered, preserved in output)`);

  // 3b. Enrich: GitHub stars (top N by downloads)
  console.error(`[enrichment] Fetching GitHub stars for top ${MAX_GH_ENRICHMENT} packages...`);
  await enrichGitHubStars(qualifiedEntries);

  // 3c. Enrich: npms.io quality scores
  console.error(`[enrichment] Fetching npms.io quality scores...`);
  const qualifiedNames = qualifiedEntries.map(e => e.name);
  const npmsScores = await fetchNpmsScores(qualifiedNames);
  for (const entry of qualifiedEntries) {
    entry.quality_score = npmsScores[entry.name] ?? null;
  }

  // 3d. Compute growth streaks from historical JSON files
  const week = isoWeek();
  console.error(`[enrichment] Computing growth streaks from historical data...`);
  const streaks = computeGrowthStreaks(week);
  for (const entry of qualifiedEntries) {
    entry.growth_streak = streaks[entry.name] ?? 0;
  }

  // 4. Group by category (qualified packages only)
  const categories = {};
  for (const kw of KEYWORDS) {
    const cat = qualifiedEntries.filter(e => e.keyword === kw).sort((a, b) => b.this_week - a.this_week);
    if (cat.length > 0) categories[kw] = cat;
  }

  // 5. Top lists
  const topByDownloads = [...qualifiedEntries]
    .sort((a, b) => b.this_week - a.this_week)
    .slice(0, 25);

  const topByGrowth = [...qualifiedEntries]
    .filter(e => e.growth_pct !== null && e.prev_week !== null && e.prev_week >= 100)
    .sort((a, b) => b.growth_pct - a.growth_pct)
    .slice(0, 25);

  const brandNew = [...qualifiedEntries]
    .filter(e => e.growth_pct === null && e.prev_week === 0)
    .sort((a, b) => b.this_week - a.this_week)
    .slice(0, 15);

  // 6. Build output
  const output = {
    week,
    generated: new Date().toISOString(),
    this_week_range: thisWeekRange,
    prev_week_range: prevWeekRange,
    packages_found: totalFound,
    total_packages_tracked: totalTracked,
    packages_fetch_failed: fetchFailCount,
    categories,
    top_by_downloads: topByDownloads,
    top_by_growth: topByGrowth,
    brand_new: brandNew,
    fetch_failed: fetchFailedEntries.slice(0, 50), // cap to avoid bloating JSON
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
  console.log(`Ecosystem collection complete: ${totalTracked} qualified packages, ${fetchFailCount} fetch-failed, week ${week}`);
  console.log(`Top by downloads: ${topByDownloads.slice(0, 5).map(e => e.name).join(', ')}`);
  console.log(`Top by growth:    ${topByGrowth.slice(0, 5).map(e => `${e.name} (+${e.growth_pct}%)`).join(', ')}`);
  console.log(`Fetch failed:     ${fetchFailedEntries.slice(0, 5).map(e => e.name).join(', ')}`);

  // Exit with non-zero if more than half the packages failed to fetch
  // (indicates a systemic API issue, not just a few missing packages)
  const failRate = totalFound > 0 ? fetchFailCount / totalFound : 0;
  if (failRate > 0.5) {
    console.error(`[ecosystem] WARNING: ${Math.round(failRate * 100)}% fetch failure rate — systemic API issue suspected`);
    // Don't exit 1 — still commit what we have so the dashboard has something
  }
}

main().catch(err => {
  console.error('[ecosystem] Fatal error:', err);
  process.exit(1);
});
