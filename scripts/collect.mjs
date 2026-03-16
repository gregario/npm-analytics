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

function yesterday() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
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
  if (existsSync(PACKAGES_FILE)) {
    const cached = JSON.parse(readFileSync(PACKAGES_FILE, 'utf-8'));
    const age = (Date.now() - new Date(cached.last_discovered).getTime()) / (1000 * 60 * 60 * 24);
    if (age < 7) {
      console.error(`[packages] Using cached list (${cached.packages.length} packages, ${age.toFixed(1)} days old)`);
      return cached.packages;
    }
    console.error('[packages] Cache older than 7 days, re-discovering...');
  }

  const packages = await discoverPackages();
  if (!packages || packages.length === 0) {
    if (existsSync(PACKAGES_FILE)) {
      console.error('[packages] Discovery failed, falling back to cache');
      return JSON.parse(readFileSync(PACKAGES_FILE, 'utf-8')).packages;
    }
    throw new Error('No packages found and no cache available');
  }

  writeFileSync(PACKAGES_FILE, JSON.stringify({ last_discovered: today(), packages }, null, 2) + '\n');
  return packages;
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

// --- Main ---

async function main() {
  const date = yesterday();
  const dailyFile = join(DAILY_DIR, `${date}.json`);

  if (existsSync(dailyFile)) {
    console.error(`[collect] ${date}.json already exists, skipping`);
    regenerateIndex();
    return;
  }

  mkdirSync(DAILY_DIR, { recursive: true });

  const packages = await getPackages();
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

  writeFileSync(dailyFile, JSON.stringify(result, null, 2) + '\n');
  console.error(`[collect] Wrote ${dailyFile}`);

  regenerateIndex();
}

main().catch(err => {
  console.error(`[collect] FATAL: ${err.message}`);
  process.exit(1);
});
