// npm Analytics Dashboard — Me + Market tabs

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#f778ba', '#79c0ff', '#7ee787', '#e3b341', '#ff7b72',
];

// ---------------------------------------------------------------------------
// ME TAB state
// ---------------------------------------------------------------------------

let allData = {};
let allDates = [];
let allPackages = [];
let activeRange = 7;
let activeAgg = 'daily';
let activePackages = new Set();
let showTotal = true;
let interpolatedDates = new Set();

let chartPackages = null;
let chartStars = null;

// ---------------------------------------------------------------------------
// ME TAB — Data loading
// ---------------------------------------------------------------------------

async function loadData() {
  const base = '../data';
  const indexRes = await fetch(`${base}/index.json`);
  const dates = await indexRes.json();

  const batchSize = 20;
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (date) => {
        try {
          const res = await fetch(`${base}/daily/${date}.json`);
          return await res.json();
        } catch {
          return null;
        }
      })
    );
    for (const entry of results) {
      if (!entry) continue;
      allData[entry.date] = entry.packages;
      if (entry._meta?.interpolated) interpolatedDates.add(entry.date);
    }
  }

  allDates = Object.keys(allData).sort();

  if (allDates.length > 0) {
    const lastDate = allDates[allDates.length - 1];
    const pkgs = allData[lastDate];
    const allZero = Object.values(pkgs).every(p => (p.downloads ?? 0) === 0);
    if (allZero) allDates.pop();
  }

  const pkgSet = new Set();
  for (const date of allDates) {
    for (const pkg of Object.keys(allData[date])) pkgSet.add(pkg);
  }
  allPackages = [...pkgSet].sort();
  activePackages = new Set(allPackages);
}

// ---------------------------------------------------------------------------
// ME TAB — Aggregation helpers
// ---------------------------------------------------------------------------

function filterDates(dates, range) {
  if (range === 'all') return dates;
  return dates.slice(-parseInt(range, 10));
}

function aggregateData(dates, agg) {
  if (agg === 'daily') return { labels: dates, groups: dates.map(d => [d]) };

  const groups = {};
  for (const date of dates) {
    let key;
    if (agg === 'weekly') {
      const d = new Date(date + 'T00:00:00Z');
      const day = d.getUTCDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const monday = new Date(d);
      monday.setUTCDate(monday.getUTCDate() + diff);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = date.slice(0, 7);
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(date);
  }

  const labels = Object.keys(groups).sort();
  return { labels, groups: labels.map(k => groups[k]) };
}

function sumDownloads(dates, pkg) {
  let total = 0;
  for (const d of dates) total += allData[d]?.[pkg]?.downloads ?? 0;
  return total;
}

function latestValue(dates, pkg, field) {
  for (let i = dates.length - 1; i >= 0; i--) {
    const val = allData[dates[i]]?.[pkg]?.[field];
    if (val !== undefined) return val;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// ME TAB — Rendering
// ---------------------------------------------------------------------------

function renderCards() {
  const dates = filterDates(allDates, activeRange);
  let totalDownloads = 0, totalStars = 0, totalForks = 0;

  for (const pkg of allPackages) {
    totalDownloads += sumDownloads(dates, pkg);
    totalStars += latestValue(allDates, pkg, 'stars');
    totalForks += latestValue(allDates, pkg, 'forks');
  }

  document.getElementById('total-downloads').textContent = totalDownloads.toLocaleString();
  document.getElementById('total-stars').textContent = totalStars.toLocaleString();
  document.getElementById('total-forks').textContent = totalForks.toLocaleString();
  document.getElementById('package-count').textContent = allPackages.length;
}

function chartDefaults(groupInterpolated = []) {
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        ticks: { color: '#8b949e', maxTicksLimit: 15 },
        grid: { color: '#21262d' },
      },
      y: {
        ticks: { color: '#8b949e' },
        grid: { color: '#21262d' },
        beginAtZero: true,
      },
    },
    plugins: {
      legend: { labels: { color: '#e6edf3', boxWidth: 12 } },
      tooltip: {
        callbacks: {
          title: (items) => {
            const idx = items[0]?.dataIndex;
            const label = items[0]?.label;
            if (idx != null && groupInterpolated[idx]) return `${label} (estimated — npm outage)`;
            return label;
          },
        },
      },
    },
  };
}

function renderPackagesChart() {
  const dates = filterDates(allDates, activeRange);
  const { labels, groups } = aggregateData(dates, activeAgg);
  const activePkgs = allPackages.filter(p => activePackages.has(p));
  const groupInterpolated = groups.map(g => g.some(d => interpolatedDates.has(d)));

  const datasets = activePkgs.map((pkg, i) => {
    const color = COLORS[i % COLORS.length];
    return {
      label: pkg,
      data: groups.map(g => sumDownloads(g, pkg)),
      borderColor: color,
      borderWidth: 2,
      fill: false,
      tension: 0.3,
      pointRadius: 1,
      segment: {
        borderDash: ctx => {
          const ni = ctx.p1DataIndex, pi = ctx.p0DataIndex;
          return (groupInterpolated[pi] || groupInterpolated[ni]) ? [5, 3] : undefined;
        },
        borderColor: ctx => {
          const ni = ctx.p1DataIndex, pi = ctx.p0DataIndex;
          if (groupInterpolated[pi] || groupInterpolated[ni]) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            return `rgba(${r},${g},${b},0.4)`;
          }
          return undefined;
        },
      },
    };
  });

  if (showTotal && activePkgs.length > 0) {
    datasets.unshift({
      label: 'Total',
      data: groups.map(g => {
        let sum = 0;
        for (const pkg of activePkgs) sum += sumDownloads(g, pkg);
        return sum;
      }),
      borderColor: '#ffffff',
      borderWidth: 3,
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      segment: {
        borderDash: ctx => {
          const ni = ctx.p1DataIndex, pi = ctx.p0DataIndex;
          return (groupInterpolated[pi] || groupInterpolated[ni]) ? [5, 3] : undefined;
        },
        borderColor: ctx => {
          const ni = ctx.p1DataIndex, pi = ctx.p0DataIndex;
          return (groupInterpolated[pi] || groupInterpolated[ni]) ? 'rgba(255,255,255,0.4)' : undefined;
        },
      },
    });
  }

  const ctx = document.getElementById('chart-packages');
  if (chartPackages) chartPackages.destroy();
  chartPackages = new Chart(ctx, { type: 'line', data: { labels, datasets }, options: chartDefaults(groupInterpolated) });
}

function renderStarsChart() {
  const dates = filterDates(allDates, activeRange);
  const { labels, groups } = aggregateData(dates, activeAgg);
  const activePkgs = allPackages.filter(p => activePackages.has(p));
  const groupInterpolated = groups.map(g => g.some(d => interpolatedDates.has(d)));

  const starsDatasets = activePkgs.map((pkg, i) => ({
    label: `${pkg} stars`,
    data: groups.map(g => latestValue(g, pkg, 'stars')),
    borderColor: COLORS[i % COLORS.length],
    borderWidth: 2, fill: false, tension: 0.3, pointRadius: 1,
  }));

  const forksDatasets = activePkgs.map((pkg, i) => ({
    label: `${pkg} forks`,
    data: groups.map(g => latestValue(g, pkg, 'forks')),
    borderColor: COLORS[i % COLORS.length],
    borderWidth: 1.5, borderDash: [5, 3], fill: false, tension: 0.3, pointRadius: 1,
  }));

  const ctx = document.getElementById('chart-stars');
  if (chartStars) chartStars.destroy();
  chartStars = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [...starsDatasets, ...forksDatasets] },
    options: chartDefaults(groupInterpolated),
  });
}

function renderAll() {
  renderCards();
  renderPackagesChart();
  renderStarsChart();
}

function setupControls() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range, 10);
      renderAll();
    });
  });

  document.querySelectorAll('.agg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.agg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAgg = btn.dataset.agg;
      renderAll();
    });
  });

  const container = document.getElementById('package-filters');

  const totalLabel = document.createElement('label');
  totalLabel.className = 'pkg-filter pkg-filter-total';
  const totalCb = document.createElement('input');
  totalCb.type = 'checkbox';
  totalCb.checked = true;
  totalCb.addEventListener('change', () => { showTotal = totalCb.checked; renderAll(); });
  totalLabel.appendChild(totalCb);
  totalLabel.appendChild(document.createTextNode('Total'));
  container.appendChild(totalLabel);

  for (const pkg of allPackages) {
    const label = document.createElement('label');
    label.className = 'pkg-filter';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => {
      if (cb.checked) activePackages.add(pkg);
      else activePackages.delete(pkg);
      renderAll();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(pkg));
    container.appendChild(label);
  }
}

// ---------------------------------------------------------------------------
// MARKET TAB — Data loading & rendering
// ---------------------------------------------------------------------------

let ecosystemData = null;

async function loadEcosystem() {
  try {
    const res = await fetch('../data/ecosystem/latest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ecosystemData = await res.json();
    renderMarket();
  } catch (err) {
    document.getElementById('market-meta').textContent =
      'No ecosystem data yet — runs every Sunday via GitHub Actions.';
    console.error('Ecosystem load error:', err);
  }
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toLocaleString();
}

function growthBadge(pct) {
  if (pct === null) return '<span class="badge badge-new">NEW</span>';
  const cls = pct >= 50 ? 'badge-hot' : pct >= 0 ? 'badge-up' : 'badge-down';
  const sign = pct >= 0 ? '+' : '';
  return `<span class="badge ${cls}">${sign}${pct}%</span>`;
}

function pkgLink(name, repo) {
  const npmUrl = `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
  let html = `<a href="${npmUrl}" target="_blank" class="pkg-name">${name}</a>`;
  if (repo) {
    const repoUrl = repo.replace(/^git\+/, '').replace(/\.git$/, '');
    html += ` <a href="${repoUrl}" target="_blank" class="repo-link" title="repo">↗</a>`;
  }
  return html;
}

function renderTable(tableId, rows, columns) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = columns.map(col => `<td>${col(row)}</td>`).join('');
    tbody.appendChild(tr);
  }
}

function renderMarket() {
  const d = ecosystemData;
  const meta = document.getElementById('market-meta');
  const failNote = (d.packages_fetch_failed > 0)
    ? ` · <span class="warn-note" title="API rate limits prevented download counts for these packages">⚠ ${d.packages_fetch_failed} fetch-failed</span>`
    : '';
  meta.innerHTML = `Week <strong>${d.week}</strong> · ${d.packages_found ?? d.total_packages_tracked} found · ${d.total_packages_tracked} qualified${failNote} ·
    window: <code>${d.this_week_range}</code> vs <code>${d.prev_week_range}</code> ·
    generated ${new Date(d.generated).toLocaleDateString()}`;

  // Top by downloads
  renderTable('table-top-downloads', d.top_by_downloads, [
    r => pkgLink(r.name, r.repo),
    r => `<span class="desc">${r.description || ''}</span>`,
    r => `<span class="num">${fmt(r.this_week)}</span>`,
    r => `<span class="num muted">${fmt(r.prev_week)}</span>`,
    r => growthBadge(r.growth_pct),
    r => `<span class="date">${r.date}</span>`,
  ]);

  // Top by growth
  renderTable('table-top-growth', d.top_by_growth, [
    r => pkgLink(r.name, r.repo),
    r => `<span class="desc">${r.description || ''}</span>`,
    r => `<span class="num">${fmt(r.this_week)}</span>`,
    r => growthBadge(r.growth_pct),
    r => `<span class="date">${r.date}</span>`,
  ]);

  // Brand new
  renderTable('table-brand-new', d.brand_new || [], [
    r => pkgLink(r.name, r.repo),
    r => `<span class="desc">${r.description || ''}</span>`,
    r => `<span class="num">${fmt(r.this_week)}</span>`,
    r => `<span class="date">${r.date}</span>`,
    r => `<span class="keyword">${r.keyword}</span>`,
  ]);
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

let marketLoaded = false;

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === `tab-${target}`);
        p.classList.toggle('hidden', p.id !== `tab-${target}`);
      });
      // Lazy-load ecosystem data on first visit to market tab
      if (target === 'market' && !marketLoaded) {
        marketLoaded = true;
        loadEcosystem();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  setupTabs();
  try {
    await loadData();
    setupControls();
    renderAll();
  } catch (err) {
    console.error('Failed to load me data:', err);
    document.getElementById('tab-me').innerHTML +=
      `<p style="color:#f85149;padding:2rem">Failed to load data. Make sure data files exist.</p>`;
  }
}

init();
