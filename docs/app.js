// npm Analytics Dashboard

const COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#f778ba', '#79c0ff', '#7ee787', '#e3b341', '#ff7b72',
];

let allData = {};       // { date -> { pkg -> { downloads, stars, forks } } }
let allDates = [];      // sorted date strings
let allPackages = [];   // package names
let activeRange = 90;
let activeAgg = 'daily';
let activePackages = new Set();
let showTotal = true;

let chartPackages = null;
let chartStars = null;

// --- Data Loading ---

async function loadData() {
  const base = '../data';
  const indexRes = await fetch(`${base}/index.json`);
  const dates = await indexRes.json();

  // Fetch all daily files in parallel (batch of 20)
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
    }
  }

  allDates = Object.keys(allData).sort();

  // Discover all packages
  const pkgSet = new Set();
  for (const date of allDates) {
    for (const pkg of Object.keys(allData[date])) {
      pkgSet.add(pkg);
    }
  }
  allPackages = [...pkgSet].sort();
  activePackages = new Set(allPackages);
}

// --- Aggregation ---

function filterDates(dates, range) {
  if (range === 'all') return dates;
  const n = parseInt(range, 10);
  return dates.slice(-n);
}

function aggregateData(dates, agg) {
  if (agg === 'daily') {
    return { labels: dates, groups: dates.map(d => [d]) };
  }

  const groups = {};
  for (const date of dates) {
    let key;
    if (agg === 'weekly') {
      // ISO week: find Monday of the week
      const d = new Date(date + 'T00:00:00Z');
      const day = d.getUTCDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const monday = new Date(d);
      monday.setUTCDate(monday.getUTCDate() + diff);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = date.slice(0, 7); // YYYY-MM
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(date);
  }

  const labels = Object.keys(groups).sort();
  return { labels, groups: labels.map(k => groups[k]) };
}

function sumDownloads(dates, pkg) {
  let total = 0;
  for (const d of dates) {
    total += allData[d]?.[pkg]?.downloads ?? 0;
  }
  return total;
}

function latestValue(dates, pkg, field) {
  for (let i = dates.length - 1; i >= 0; i--) {
    const val = allData[dates[i]]?.[pkg]?.[field];
    if (val !== undefined) return val;
  }
  return 0;
}

// --- Summary Cards ---

function renderCards() {
  const dates = filterDates(allDates, activeRange);
  let totalDownloads = 0;
  let totalStars = 0;
  let totalForks = 0;

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

// --- Charts ---

function chartDefaults() {
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
    },
  };
}

function renderPackagesChart() {
  const dates = filterDates(allDates, activeRange);
  const { labels, groups } = aggregateData(dates, activeAgg);
  const activePkgs = allPackages.filter(p => activePackages.has(p));

  const datasets = activePkgs.map((pkg, i) => ({
    label: pkg,
    data: groups.map(g => sumDownloads(g, pkg)),
    borderColor: COLORS[i % COLORS.length],
    borderWidth: 2,
    fill: false,
    tension: 0.3,
    pointRadius: 1,
  }));

  // Total line: sum of all active packages per period
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
      borderDash: [],
    });
  }

  const ctx = document.getElementById('chart-packages');
  if (chartPackages) chartPackages.destroy();
  chartPackages = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: chartDefaults(),
  });
}

function renderStarsChart() {
  const dates = filterDates(allDates, activeRange);
  const { labels, groups } = aggregateData(dates, activeAgg);
  const activePkgs = allPackages.filter(p => activePackages.has(p));

  const starsDatasets = activePkgs.map((pkg, i) => ({
    label: `${pkg} stars`,
    data: groups.map(g => latestValue(g, pkg, 'stars')),
    borderColor: COLORS[i % COLORS.length],
    borderWidth: 2,
    fill: false,
    tension: 0.3,
    pointRadius: 1,
  }));

  const forksDatasets = activePkgs.map((pkg, i) => ({
    label: `${pkg} forks`,
    data: groups.map(g => latestValue(g, pkg, 'forks')),
    borderColor: COLORS[i % COLORS.length],
    borderWidth: 1.5,
    borderDash: [5, 3],
    fill: false,
    tension: 0.3,
    pointRadius: 1,
  }));

  const ctx = document.getElementById('chart-stars');
  if (chartStars) chartStars.destroy();
  chartStars = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [...starsDatasets, ...forksDatasets] },
    options: chartDefaults(),
  });
}

function renderAll() {
  renderCards();
  renderPackagesChart();
  renderStarsChart();
}

// --- Controls ---

function setupControls() {
  // Range buttons
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range, 10);
      renderAll();
    });
  });

  // Aggregation buttons
  document.querySelectorAll('.agg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.agg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAgg = btn.dataset.agg;
      renderAll();
    });
  });

  // Package filter checkboxes
  const container = document.getElementById('package-filters');

  // Total toggle
  const totalLabel = document.createElement('label');
  totalLabel.className = 'pkg-filter pkg-filter-total';
  const totalCb = document.createElement('input');
  totalCb.type = 'checkbox';
  totalCb.checked = true;
  totalCb.addEventListener('change', () => {
    showTotal = totalCb.checked;
    renderAll();
  });
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
      if (cb.checked) {
        activePackages.add(pkg);
      } else {
        activePackages.delete(pkg);
      }
      renderAll();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(pkg));
    container.appendChild(label);
  }
}

// --- Init ---

async function init() {
  try {
    await loadData();
    setupControls();
    renderAll();
  } catch (err) {
    console.error('Failed to load data:', err);
    document.body.innerHTML += `<p style="color:#f85149;padding:2rem">Failed to load data. Make sure data files exist.</p>`;
  }
}

init();
