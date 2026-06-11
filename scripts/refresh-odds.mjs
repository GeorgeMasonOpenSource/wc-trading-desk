#!/usr/bin/env node
// refresh-odds.mjs — regenerates the BOOKIE_XG / BOOKIE_MARKETS snapshot blocks in index.html
// from ESPN's free endpoints (DraftKings odds embedded). This is the "daily-refresh task"
// referenced in the README; run it locally/CI wherever ESPN is reachable, then deploy.
//
//   node scripts/refresh-odds.mjs            # dry-run: prints the generated blocks
//   node scripts/refresh-odds.mjs --apply    # patches index.html in place (also bumps BOOKIE_SNAPSHOT_DATE)
//
// Pipeline per match (group stage only — knockouts use the Elo fallback in-app):
//   1. ESPN scoreboard (with odds) → devigged 3-way moneyline → pWin / pDraw
//   2. Event odds endpoint (sports.core.api.espn.com …/odds + propBets) →
//        - team total goals over-1.5 price → Poisson-solved team xG
//        - clean-sheet prop (devigged two-way) → cs / opp_cs
//        - both-teams-to-score → btts
//
// NOTE: the WC Trading Desk sandboxed dev environment cannot reach ESPN (network policy);
// this script must run somewhere with open egress.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const APPLY = process.argv.includes('--apply');

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260627';
const EVENT_ODDS = id => `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${id}/competitions/${id}/odds`;
const PROP_BETS  = id => `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${id}/competitions/${id}/odds/1003/propBets?limit=300`;

const americanToProb = a => a < 0 ? (-a) / (-a + 100) : 100 / (a + 100);
const devig = probs => { const s = probs.reduce((a,b)=>a+b,0); return probs.map(p=>p/s); };

// Solve lambda such that P(Poisson(lambda) >= 2) = pOver15  →  1 - e^-l (1 + l) = p
function poissonFromOver15(pOver15){
  let lo = 0.01, hi = 6;
  for(let i=0;i<60;i++){
    const mid = (lo+hi)/2;
    const p = 1 - Math.exp(-mid)*(1+mid);
    if(p < pOver15) lo = mid; else hi = mid;
  }
  return (lo+hi)/2;
}

async function getJSON(url){
  const res = await fetch(url, {headers:{'user-agent':'wc-trading-desk-refresh/1.0'}});
  if(!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main(){
  const sb = await getJSON(SCOREBOARD);
  const events = sb.events || [];
  if(events.length === 0) throw new Error('scoreboard returned no events — check the dates window');

  const XG = {};      // team -> md -> {teamXG, oppXG, opp, total, home, pWin, pDraw}
  const MKT = {};     // team -> md -> {opp, home, cs, btts, opp_cs, xg, opp_xg}
  // Matchday inference: ESPN doesn't label group MDs; bucket each team's group fixtures by date order.
  const teamGameNo = {};

  for(const e of events){
    const comp = e.competitions?.[0]; if(!comp) continue;
    const comps = comp.competitors || [];
    const home = comps.find(c=>c.homeAway==='home');
    const away = comps.find(c=>c.homeAway==='away');
    if(!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
    const h = home.team.abbreviation, a = away.team.abbreviation;
    teamGameNo[h] = (teamGameNo[h]||0)+1; teamGameNo[a] = (teamGameNo[a]||0)+1;
    const mdH = teamGameNo[h], mdA = teamGameNo[a];
    if(mdH > 3 || mdA > 3) continue;   // group stage only

    // --- 3-way moneyline (scoreboard odds or event odds endpoint) ---
    let pHome, pDraw, pAway;
    try {
      const odds = (comp.odds && comp.odds[0]) || (await getJSON(EVENT_ODDS(e.id)))?.items?.[0];
      const ml = [odds?.homeTeamOdds?.moneyLine, odds?.drawOdds?.moneyLine, odds?.awayTeamOdds?.moneyLine];
      if(ml.every(v=>typeof v === 'number')){
        [pHome, pDraw, pAway] = devig(ml.map(americanToProb));
      }
    } catch(err){ console.warn(`[ml] ${h}v${a}: ${err.message}`); }

    // --- props: team totals, clean sheets, btts ---
    let csH, csA, btts, xgH, xgA;
    try {
      const props = (await getJSON(PROP_BETS(e.id)))?.items || [];
      for(const p of props){
        const name = (p.name || p.propBetTypeName || '').toLowerCase();
        const target = (p.athleteOrTeamName || p.teamName || '').toLowerCase();
        const isHome = target && home.team.displayName.toLowerCase().includes(target.split(' ')[0]);
        const over = p.current?.over?.american ?? p.over?.american;
        const yes  = p.current?.yes?.american ?? p.yes?.american;
        const no   = p.current?.no?.american ?? p.no?.american;
        if(name.includes('total goals') && name.includes('1.5') && typeof over === 'number'){
          const lamb = poissonFromOver15(americanToProb(over));   // single-sided; vig ≈ split
          if(isHome) xgH = lamb; else xgA = lamb;
        }
        if(name.includes('clean sheet') && typeof yes === 'number' && typeof no === 'number'){
          const [pYes] = devig([americanToProb(yes), americanToProb(no)]);
          if(isHome) csH = pYes; else csA = pYes;
        }
        if((name.includes('both teams to score') || name.includes('btts')) && typeof yes === 'number' && typeof no === 'number'){
          [btts] = devig([americanToProb(yes), americanToProb(no)]);
        }
      }
    } catch(err){ console.warn(`[props] ${h}v${a}: ${err.message}`); }

    const r3 = v => v == null ? undefined : Math.round(v*10000)/10000;
    const set = (obj, team, md, val) => { (obj[team] = obj[team] || {})[md] = val; };
    if(pHome != null){
      set(XG, h, mdH, {teamXG:r3(xgH), oppXG:r3(xgA), opp:a, total:2.5, home:true,  pWin:r3(pHome), pDraw:r3(pDraw)});
      set(XG, a, mdA, {teamXG:r3(xgA), oppXG:r3(xgH), opp:h, total:2.5, home:false, pWin:r3(pAway), pDraw:r3(pDraw)});
    }
    set(MKT, h, mdH, {opp:a, home:true,  cs:r3(csH), btts:r3(btts), opp_cs:r3(csA), xg:r3(xgH), opp_xg:r3(xgA)});
    set(MKT, a, mdA, {opp:h, home:false, cs:r3(csA), btts:r3(btts), opp_cs:r3(csH), xg:r3(xgA), opp_xg:r3(xgH)});
  }

  const today = new Date().toISOString().slice(0,10);
  const ser = obj => '{\n' + Object.keys(obj).sort().map(t=>{
    const mds = obj[t];
    const inner = Object.keys(mds).sort().map(md=>`${md}:${JSON.stringify(mds[md]).replace(/"([a-z_A-Z]+)":/g,'$1:').replace(/undefined,?/g,'')}`).join(',');
    return `  ${t}:{${inner}}`;
  }).join(',\n') + ',\n};';

  const xgBlock  = `const BOOKIE_XG = ${ser(XG)}`;
  const mktBlock = `const BOOKIE_MARKETS = ${ser(MKT)}`;

  if(!APPLY){
    console.log(`// generated ${today} — dry run (use --apply to patch index.html)\n`);
    console.log(xgBlock + '\n');
    console.log(mktBlock);
    return;
  }

  let html = fs.readFileSync(INDEX, 'utf8');
  const swaps = [
    [/const BOOKIE_SNAPSHOT_DATE = '[^']*';/, `const BOOKIE_SNAPSHOT_DATE = '${today}';`],
    [/const BOOKIE_XG = \{[\s\S]*?\n\};/, xgBlock],
    [/const BOOKIE_MARKETS = \{[\s\S]*?\n\};/, mktBlock],
  ];
  for(const [re, repl] of swaps){
    if(!re.test(html)) throw new Error(`marker not found: ${re}`);
    html = html.replace(re, repl);
  }
  fs.writeFileSync(INDEX, html);
  console.log(`[refresh-odds] patched index.html — ${Object.keys(XG).length} teams with moneyline, ${Object.keys(MKT).length} with props, snapshot ${today}`);
}

main().catch(err => { console.error('[refresh-odds] FAILED:', err.message); process.exit(1); });
