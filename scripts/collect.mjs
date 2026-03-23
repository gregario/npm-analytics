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

// --- Helpers ---

function twoDaysAgo() {
  return new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

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

// --- Package Discovery ---

async function discoverPackages() {
  console.error('[discover] Searching npm for maintainer:gregario...');
  const url = 'https://registry.npmjs.org/-/v1/search?text=maintainer:gr3gario&size=100';
  const data = await fetchJSON(url);
  if (!data || !data.objects) {
    console.error('[discover] Failed to fetch npm registry');
    return null;
  }
  const packages = data.objects.map(o => o.package.name);
  console.error(`[discover] Found ${packages.length} packages: ${packages.join(', ')}`);
  return packages;
}

async function getPackages() {
  const previousPackages = existsSync(PACKAGES_FILE)
    ? JSON.parse(readFileSync(PACKAGES_FILE, 'utf-8')).packages
    : [];

  const packages = await discoverPackages();
  if (!packages || packages.length === 0) {
    if (previousPackages.length > 0) {
      console.error('[packages] Discovery failed, falling back to cache');
      return { packages: previousPackages, newPackages: [] };
    }
    throw new Error('No packages found and no cache available');
  }

  const newPackages = packages.filter(p => !previousPackages.includes(p));
  if (newPackages.length > 0) {
    console.error(`[packages] New packages detected: ${newPackages.join(', ')}`);
  }

  writeFileSync(PACKAGES_FILE, JSON.stringify({ last_discovered: today(), packages }, null, 2) + '\n');
  return { packages, newPackages };
}

// --- Data Fetching ---

async function fetchDownloads(pkg, date) {
  const url = `https://api.npmjs.org/downloads/point/${date}/${pkg}`;
  const data = await fetchJSON(url);
  return data?.downloads ?? 0;
}

async function fetchGitHubStats(pkg) {
  const url = `https://api.github.com/repos/gregario/${pkg}`;
  const data = await fetchJSON(url, githubHeaders());
  if (!data) return { stars: 0, forks: 0 };
  return { stars: data.stargazers_count ?? 0, forks: data.forks_count ?? 0 };
}

const CANARY_PACKAGE = 'express';

async function isNpmOutage(date) {
  const downloads = await fetchDownloads(CANARY_PACKAGE, date);
  const isOutage = downloads === 0;
  if (isOutage) {
    console.error(`[outage] Canary package '${CANARY_PACKAGE}' returned 0 for ${date} — npm outage detected`);
  }
  return isOutage;
}

function interpolateDay(date, packages) {
  const dailyFiles = readdirSync(DAILY_DIR).filter(f => f.endsWith('.json')).sort();
  const dateStrs = dailyFiles.map(f => f.replace('.json', ''));

  // Find nearest real day before
  let beforeDate = null;
  let beforeData = null;
  for (let i = dateStrs.length - 1; i >= 0; i--) {
    if (dateStrs[i] >= date) continue;
    const file = join(DAILY_DIR, `${dateStrs[i]}.json`);
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (!data._meta?.interpolated) {
      beforeDate = dateStrs[i];
      beforeData = data;
      break;
    }
  }

  // Find nearest real day after
  let afterDate = null;
  let afterData = null;
  for (let i = 0; i < dateStrs.length; i++) {
    if (dateStrs[i] <= date) continue;
    const file = join(DAILY_DIR, `${dateStrs[i]}.json`);
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (!data._meta?.interpolated) {
      afterDate = dateStrs[i];
      afterData = data;
      break;
    }
  }

  const result = { date, _meta: {
    interpolated: true,
    reason: 'npm_outage',
    detected: today(),
    lastChecked: today(),
    checkCount: 0,
  }, packages: {} };

  for (const pkg of packages) {
    const beforeDl = beforeData?.packages?.[pkg]?.downloads ?? 0;
    const afterDl = afterData?.packages?.[pkg]?.downloads ?? beforeDl;

    let downloads;
    if (beforeDate && afterDate) {
      // Linear interpolation
      const totalDays = (new Date(afterDate) - new Date(beforeDate)) / 86400000;
      const elapsed = (new Date(date) - new Date(beforeDate)) / 86400000;
      const ratio = totalDays > 0 ? elapsed / totalDays : 0.5;
      downloads = Math.round(beforeDl + (afterDl - beforeDl) * ratio);
    } else {
      // Edge case: use whichever boundary exists
      downloads = beforeData ? beforeDl : afterDl;
    }

    // Stars/forks: use latest known values (not interpolated)
    const stars = beforeData?.packages?.[pkg]?.stars ?? afterData?.packages?.[pkg]?.stars ?? 0;
    const forks = beforeData?.packages?.[pkg]?.forks ?? afterData?.packages?.[pkg]?.forks ?? 0;

    result.packages[pkg] = { downloads, stars, forks };
  }

  return result;
}

function isRecheckDue(meta) {
  const now = new Date(today());
  const last = new Date(meta.lastChecked);
  const count = meta.checkCount;
  const daysSinceLastCheck = (now - last) / 86400000;

  if (count < 7) return daysSinceLastCheck >= 1;       // Daily for first week
  if (count < 11) return daysSinceLastCheck >= 7;      // Weekly for weeks 2-5
  if (count < 17) return daysSinceLastCheck >= 30;     // Monthly for months 2-6
  return false;                                         // Stop after ~6 months
}

async function recheckInterpolatedDays(packages) {
  const dailyFiles = readdirSync(DAILY_DIR).filter(f => f.endsWith('.json')).sort();

  for (const file of dailyFiles) {
    const dailyFile = join(DAILY_DIR, file);
    const data = JSON.parse(readFileSync(dailyFile, 'utf-8'));
    if (!data._meta?.interpolated) continue;

    if (!isRecheckDue(data._meta)) continue;

    const date = data.date;
    console.error(`[recheck] Checking if npm backfilled ${date} (check #${data._meta.checkCount + 1})...`);

    const outageStillPresent = await isNpmOutage(date);

    if (!outageStillPresent) {
      // npm backfilled! Fetch real data
      console.error(`[recheck] npm backfilled ${date} — fetching real data`);
      const result = { date, packages: {} };
      for (const pkg of packages) {
        const downloads = await fetchDownloads(pkg, date);
        const { stars, forks } = await fetchGitHubStats(pkg);
        result.packages[pkg] = { downloads, stars, forks };
      }
      writeFileSync(dailyFile, JSON.stringify(result, null, 2) + '\n');
      console.error(`[recheck] Replaced interpolated data for ${date} with real data`);
    } else {
      // Still an outage — update check metadata, re-interpolate with latest boundaries
      const reinterpolated = interpolateDay(date, packages);
      reinterpolated._meta.checkCount = data._meta.checkCount + 1;
      reinterpolated._meta.detected = data._meta.detected;
      writeFileSync(dailyFile, JSON.stringify(reinterpolated, null, 2) + '\n');
      console.error(`[recheck] ${date} still not backfilled (check #${reinterpolated._meta.checkCount})`);
    }
  }
}

// --- Index Regeneration ---

function regenerateIndex() {
  if (!existsSync(DAILY_DIR)) return;
  const files = readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
  writeFileSync(INDEX_FILE, JSON.stringify(files, null, 2) + '\n');
  console.error(`[index] Wrote ${files.length} dates to index.json`);
}

// --- Repair zeros ---

async function repairZeroDay(date, packages) {
  const dailyFile = join(DAILY_DIR, `${date}.json`);
  if (!existsSync(dailyFile)) return;

  const existing = JSON.parse(readFileSync(dailyFile, 'utf-8'));
  const allZero = Object.values(existing.packages).every(p => (p.downloads ?? 0) === 0);
  if (!allZero) return;

  console.error(`[repair] ${date} has all-zero downloads, re-fetching...`);
  let repaired = false;
  for (const pkg of packages) {
    const downloads = await fetchDownloads(pkg, date);
    if (downloads > 0) {
      existing.packages[pkg].downloads = downloads;
      repaired = true;
    }
  }

  if (repaired) {
    writeFileSync(dailyFile, JSON.stringify(existing, null, 2) + '\n');
    console.error(`[repair] Updated ${date} with corrected download counts`);
  } else {
    console.error(`[repair] ${date} still has zero downloads (may be genuine)`);
  }
}

// --- Backfill new packages ---

async function backfillNewPackages(newPackages) {
  const existingFiles = readdirSync(DAILY_DIR).filter(f => f.endsWith('.json')).sort();
  if (existingFiles.length === 0) return;

  const firstDate = existingFiles[0].replace('.json', '');
  const lastDate = existingFiles[existingFiles.length - 1].replace('.json', '');
  console.error(`[backfill] Backfilling ${newPackages.length} new packages across ${existingFiles.length} days (${firstDate} to ${lastDate})`);

  // Fetch download ranges for new packages
  const downloadsByPkg = {};
  for (const pkg of newPackages) {
    console.error(`[backfill] Fetching download range for ${pkg}...`);
    const url = `https://api.npmjs.org/downloads/range/${firstDate}:${lastDate}/${pkg}`;
    const data = await fetchJSON(url);
    downloadsByPkg[pkg] = {};
    if (data && data.downloads) {
      for (const entry of data.downloads) {
        downloadsByPkg[pkg][entry.day] = entry.downloads;
      }
    }
  }

  // Fetch GitHub stats for new packages
  const statsByPkg = {};
  for (const pkg of newPackages) {
    const { stars, forks } = await fetchGitHubStats(pkg);
    statsByPkg[pkg] = { stars, forks };
  }

  // Merge into existing daily files
  for (const file of existingFiles) {
    const dailyFile = join(DAILY_DIR, file);
    const date = file.replace('.json', '');
    const existing = JSON.parse(readFileSync(dailyFile, 'utf-8'));
    for (const pkg of newPackages) {
      if (!existing.packages[pkg]) {
        existing.packages[pkg] = {
          downloads: downloadsByPkg[pkg][date] ?? 0,
          stars: statsByPkg[pkg].stars,
          forks: statsByPkg[pkg].forks,
        };
      }
    }
    writeFileSync(dailyFile, JSON.stringify(existing, null, 2) + '\n');
  }

  console.error(`[backfill] Merged new packages into ${existingFiles.length} daily files`);
}

// --- Main ---

async function main() {
  const date = twoDaysAgo();
  const dailyFile = join(DAILY_DIR, `${date}.json`);

  mkdirSync(DAILY_DIR, { recursive: true });

  const { packages, newPackages } = await getPackages();

  // Backfill new packages into all existing daily files
  if (newPackages.length > 0) {
    await backfillNewPackages(newPackages);
  }

  // Repair recent zero days (NPM API lag safety net)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  await repairZeroDay(yesterday, packages);
  await repairZeroDay(threeDaysAgo, packages);

  // Progressive recheck of interpolated days
  await recheckInterpolatedDays(packages);

  if (existsSync(dailyFile)) {
    console.error(`[collect] ${date}.json already exists, skipping`);
    regenerateIndex();
    return;
  }

  const result = { date, packages: {} };

  for (const pkg of packages) {
    try {
      console.error(`[collect] Fetching ${pkg}...`);
      const downloads = await fetchDownloads(pkg, date);
      const { stars, forks } = await fetchGitHubStats(pkg);
      result.packages[pkg] = { downloads, stars, forks };
      console.error(`[collect]   ${pkg}: ${downloads} downloads, ${stars} stars, ${forks} forks`);
    } catch (err) {
      console.error(`[collect] WARNING: Failed to fetch ${pkg}: ${err.message}`);
    }
  }

  // Check for npm outage: all downloads zero + canary confirms
  const allZero = Object.values(result.packages).every(p => (p.downloads ?? 0) === 0);
  if (allZero && await isNpmOutage(date)) {
    console.error(`[outage] Interpolating data for ${date}`);
    const interpolated = interpolateDay(date, packages);
    writeFileSync(dailyFile, JSON.stringify(interpolated, null, 2) + '\n');
    console.error(`[collect] Wrote interpolated ${dailyFile}`);
  } else {
    writeFileSync(dailyFile, JSON.stringify(result, null, 2) + '\n');
    console.error(`[collect] Wrote ${dailyFile}`);
  }

  regenerateIndex();
}

main().catch(err => {
  console.error(`[collect] FATAL: ${err.message}`);
  process.exit(1);
});
