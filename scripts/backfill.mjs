import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const DAILY_DIR = join(DATA_DIR, 'daily');
const PACKAGES_FILE = join(DATA_DIR, 'packages.json');
const INDEX_FILE = join(DATA_DIR, 'index.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || '90', 10);

// --- Helpers ---

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

function githubHeaders() {
  const h = { 'User-Agent': 'npm-analytics' };
  if (GITHUB_TOKEN) h['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function regenerateIndex() {
  if (!existsSync(DAILY_DIR)) return;
  const files = readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
  writeFileSync(INDEX_FILE, JSON.stringify(files, null, 2) + '\n');
  console.error(`[index] Wrote ${files.length} dates to index.json`);
}

// --- Main ---

async function main() {
  if (!existsSync(PACKAGES_FILE)) {
    console.error('[backfill] No packages.json found. Run collect.mjs first.');
    process.exit(1);
  }

  const { packages } = JSON.parse(readFileSync(PACKAGES_FILE, 'utf-8'));
  mkdirSync(DAILY_DIR, { recursive: true });

  // Calculate date range
  const end = new Date(Date.now() - 86400000); // yesterday
  const start = new Date(end.getTime() - (BACKFILL_DAYS - 1) * 86400000);
  const startStr = formatDate(start);
  const endStr = formatDate(end);

  console.error(`[backfill] Backfilling ${BACKFILL_DAYS} days (${startStr} to ${endStr}) for ${packages.length} packages`);

  // Fetch download ranges for all packages
  const downloadsByPkg = {};
  for (const pkg of packages) {
    console.error(`[backfill] Fetching download range for ${pkg}...`);
    const url = `https://api.npmjs.org/downloads/range/${startStr}:${endStr}/${pkg}`;
    const data = await fetchJSON(url);
    if (data && data.downloads) {
      downloadsByPkg[pkg] = {};
      for (const entry of data.downloads) {
        downloadsByPkg[pkg][entry.day] = entry.downloads;
      }
    } else {
      console.error(`[backfill] WARNING: No download data for ${pkg}`);
      downloadsByPkg[pkg] = {};
    }
  }

  // Fetch current GitHub stats (no historical API)
  const statsByPkg = {};
  for (const pkg of packages) {
    console.error(`[backfill] Fetching GitHub stats for ${pkg}...`);
    const url = `https://api.github.com/repos/gregario/${pkg}`;
    const data = await fetchJSON(url, githubHeaders());
    if (data) {
      statsByPkg[pkg] = { stars: data.stargazers_count ?? 0, forks: data.forks_count ?? 0 };
    } else {
      statsByPkg[pkg] = { stars: 0, forks: 0 };
    }
  }

  // Write daily files
  let created = 0;
  let merged = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const date = formatDate(cursor);
    const dailyFile = join(DAILY_DIR, `${date}.json`);

    // Build package data for this day
    const pkgData = {};
    for (const pkg of packages) {
      pkgData[pkg] = {
        downloads: downloadsByPkg[pkg][date] ?? 0,
        stars: statsByPkg[pkg].stars,
        forks: statsByPkg[pkg].forks,
      };
    }

    if (existsSync(dailyFile)) {
      // Merge: keep existing data, fill in missing packages
      const existing = JSON.parse(readFileSync(dailyFile, 'utf-8'));
      for (const pkg of packages) {
        if (!existing.packages[pkg]) {
          existing.packages[pkg] = pkgData[pkg];
        } else {
          // Update downloads if we have backfill data and existing is 0
          if (existing.packages[pkg].downloads === 0 && pkgData[pkg].downloads > 0) {
            existing.packages[pkg].downloads = pkgData[pkg].downloads;
          }
        }
      }
      writeFileSync(dailyFile, JSON.stringify(existing, null, 2) + '\n');
      merged++;
    } else {
      const result = { date, packages: pkgData };
      writeFileSync(dailyFile, JSON.stringify(result, null, 2) + '\n');
      created++;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  console.error(`[backfill] Created ${created} files, merged ${merged} existing files`);
  regenerateIndex();
}

main().catch(err => {
  console.error(`[backfill] FATAL: ${err.message}`);
  process.exit(1);
});
