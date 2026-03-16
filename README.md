# npm-analytics

Daily npm download and GitHub stats tracker with interactive dashboard.

Auto-discovers all [gr3gario](https://www.npmjs.com/~gr3gario) npm packages, collects daily download counts, GitHub stars, and forks. Stores historical data as flat JSON. Renders interactive charts on GitHub Pages.

**[View Dashboard](https://gregario.github.io/npm-analytics/)**

## How it works

- **GitHub Actions** runs daily at 07:00 UTC, collecting stats and committing JSON files
- **Dashboard** at GitHub Pages reads the JSON and renders Chart.js charts
- **No dependencies** -- plain Node.js ESM scripts, static HTML/JS/CSS

## Scripts

```bash
node scripts/collect.mjs    # Collect yesterday's stats
node scripts/backfill.mjs   # Backfill 90 days of download history
```

## License

MIT
