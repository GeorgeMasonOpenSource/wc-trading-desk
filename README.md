# WC Trading Desk — FIFA Fantasy 2026 Quant Terminal

Bookmaker-grounded fantasy decision tool for the 2026 FIFA World Cup. Single-file HTML, deployed via Vercel.

**Live**: https://wc-trading-desk.vercel.app

## What it does

- **Squad optimizer** (budget-constrained, country-cap-aware, slot-aware bench weighting for mid-MD pivots)
- **Bookmaker-direct CS / xG / win probability** from ESPN-embedded DraftKings (no paid API)
- **Pivot Strategy** panel showing kickoff timing per player + recommended captain/bench positioning
- **Live Decision Desk** — fetches ESPN scoreboard mid-MD and recommends sub-in/sub-out swaps
- **Match Day Action Plan** — chronological "do this at this kickoff" timeline
- **Automated backup-tier detection** via low-ownership-at-premium-price (no manual overrides for backups)

## Architecture

- Single self-contained `index.html` (~600KB). Embeds everything: data, model, UI, optimizer
- Live data pulled from FIFA Fantasy public JSON + ESPN APIs at page load (no auth)
- Daily-refresh task (separate scheduled job) updates observed lineups + news overrides

## Data sources (all free)

| Layer | Source |
|---|---|
| Player prices / ownership | `play.fifa.com/json/fantasy/players.json` |
| Team clean-sheet odds | DraftKings via `sports.core.api.espn.com/...propBets` |
| Team xG | Poisson-solved from Team Total Goals over-1.5 market |
| Win/draw/loss prob | Devigged 3-way moneyline from ESPN scoreboard |
| Observed start rate | Last 5 internationals per team from `site.api.espn.com` |
| Live match state | ESPN scoreboard during matchday |

## Local dev

This is a single HTML file — open it in a browser to test. To deploy:

```bash
npx vercel deploy --prod
```

The `.vercel/project.json` pins this directory to the canonical Vercel project so deploys land on `wc-trading-desk.vercel.app`.

## Deploy automation

The Vercel project is configured to auto-deploy on push to the `main` branch.
