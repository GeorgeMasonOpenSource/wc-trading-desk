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
- `scripts/refresh-odds.mjs` regenerates the embedded `BOOKIE_XG` / `BOOKIE_MARKETS`
  bookmaker snapshot from ESPN/DraftKings (`--apply` patches `index.html` and bumps
  `BOOKIE_SNAPSHOT_DATE`, surfaced in the header freshness badge). Run it daily during
  the group stage from any machine with open egress, then deploy.
- Observed lineups + news overrides are hand-curated blocks in `index.html`

## Scoring model (official FIFA Fantasy 2026 rules)

Projections encode the official scoring: goals GK/DEF **6** / MID **5** / FWD **4**,
assist 3, clean sheet 5 (DEF/GK) / 1 (MID), −1 per goal conceded after the first,
MID tackles (+1/3) and chances created (+1/2), FWD shots on target (+1/2), penalty won +2,
direct free-kick +1, outside-the-box +1, **scouting bonus +2** (sub-5%-owned player scoring
4+ pts), red card −3, penalty save +5. Squad 2 GK/5 DEF/5 MID/3 FWD @ $100m (+$5m at
knockouts); country caps 3/3/4/5/6/8 by stage. Self-tests in the page assert the key values.

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
