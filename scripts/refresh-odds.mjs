#!/usr/bin/env node
// refresh-odds.mjs — regenerates the BOOKIE_XG / BOOKIE_MARKETS snapshot blocks in index.html
// from ESPN's free endpoints (DraftKings odds embedded). Runs via the scheduled GitHub Action
// (.github/workflows/refresh-odds.yml) — fails loudly (exit 1, no patch) on missing data.
//
//   node scripts/refresh-odds.mjs            # dry-run: prints the generated blocks
//   node scripts/refresh-odds.mjs --apply    # patches index.html in place (bumps BOOKIE_SNAPSHOT_DATE)
//
// Pipeline per match (group stage only — knockouts use the Elo fallback in-app):
//   1. Scoreboard (or event odds endpoint, $refs dereferenced) → devigged 3-way moneyline → pWin/pDraw
//   2. Odds item's own propBets link → team total goals over-1.5 (Poisson-solved xG),
//      clean-sheet props (devigged), both-teams-to-score

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const APPLY = process.argv.includes('--apply');

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260627';
const EVENT_ODDS = id => `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${id}/competitions/${id}/odds?limit=20`;

const americanToProb = a => a < 0 ? (-a) / (-a + 100) : 100 / (a + 100);
const devig = probs => { const s = probs.reduce((a,b)=>a+b,0); return probs.map(p=>p/s); };

// Money line values appear as numbers, "+150"-style strings, or nested under current.moneyLine.
function mlValue(side){
  if(side == null) return null;
  const raw = side.moneyLine ?? side.current?.moneyLine?.american ?? side.current?.moneyLine?.value ?? side.value ?? null;
  if(raw == null) return null;
  const n = typeof raw === 'string' ? parseInt(raw.replace('+',''), 10) : raw;
  return Number.isFinite(n) ? n : null;
}

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
  const res = await fetch(url, {headers:{'user-agent':'wc-trading-desk-refresh/1.1'}});
  if(!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Core-API collections return {$ref} stubs — dereference each entry.
async function deref(items){
  const out = [];
  for(const it of items || []){
    if(it && it.$ref){ try { out.push(await getJSON(it.$ref)); } catch(e){ console.warn('[deref]', e.message); } }
    else if(it) out.push(it);
  }
  return out;
}

let _dumpedShapes = false;
function dumpShapeOnce(label, obj){
  if(_dumpedShapes || !obj) return;
  _dumpedShapes = true;
  console.warn(`[debug] ${label} sample shape:`, JSON.stringify(obj).slice(0, 1200));
}

// --probe: dump the raw odds structures for one event so the parser can be matched to
// reality from CI logs (this repo's dev sandbox cannot reach ESPN directly).
async function probe(){
  const sb = await getJSON(SCOREBOARD);
  const e = sb.events?.[2] || sb.events?.[0];
  if(!e) throw new Error('no events');
  console.log(`[probe] event ${e.id}: ${e.name}`);
  const base = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${e.id}/competitions/${e.id}`;
  const items = await deref((await getJSON(EVENT_ODDS(e.id)))?.items);
  const it = items[0];
  console.log(`[probe] provider ${it?.provider?.name} (${it?.provider?.id}); homeTeam $ref: ${it?.homeTeamOdds?.team?.$ref}; awayTeam $ref: ${it?.awayTeamOdds?.team?.$ref}`);
  const pid = it?.provider?.id ?? 100;
  const all = [];
  for(let page=1; page<=5; page++){
    const pj = await getJSON(`${base}/odds/${pid}/propBets?limit=200&page=${page}`);
    all.push(...(pj.items||[]));
    if(all.length >= (pj.count||0)) break;
  }
  console.log(`[probe] fetched ${all.length} props`);
  const byType = {};
  for(const p of all){
    const n = p.type?.name || '?';
    byType[n] = (byType[n]||0)+1;
  }
  console.log('[probe] prop type histogram:', JSON.stringify(byType));
  const want = [/clean sheet/i, /both teams/i, /total goals/i, /to score 2\+|over 1\.5/i];
  const seen = new Set();
  for(const p of all){
    const n = p.type?.name || '';
    for(const re of want){
      if(re.test(n) && !seen.has(n)){
        seen.add(n);
        console.log(`[probe] FULL SAMPLE of "${n}":`, JSON.stringify(p).slice(0, 2000));
      }
    }
  }
}

async function main(){
  const sb = await getJSON(SCOREBOARD);
  const events = sb.events || [];
  if(events.length === 0) throw new Error('scoreboard returned no events — check the dates window');

  const XG = {};      // team -> md -> {teamXG, oppXG, opp, total, home, pWin, pDraw}
  const MKT = {};     // team -> md -> {opp, home, cs, btts, opp_cs, xg, opp_xg}
  const teamGameNo = {};   // ESPN scoreboard is date-ordered; bucket each team's fixtures into MD 1..3

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

    // --- gather odds items: scoreboard inline first, then event odds endpoint (deref'd) ---
    let oddsItems = comp.odds || [];
    let pHome, pDraw, pAway, oddsItem = null;
    const pickItem = items => items.find(it => mlValue(it?.homeTeamOdds) != null && mlValue(it?.drawOdds ?? it?.drawTeamOdds) != null)
                          || items.find(it => mlValue(it?.homeTeamOdds) != null);
    oddsItem = pickItem(oddsItems);
    if(!oddsItem){
      try { oddsItems = await deref((await getJSON(EVENT_ODDS(e.id)))?.items); oddsItem = pickItem(oddsItems); }
      catch(err){ console.warn(`[odds] ${h}v${a}: ${err.message}`); }
    }
    if(oddsItem){
      const mlH = mlValue(oddsItem.homeTeamOdds);
      const mlD = mlValue(oddsItem.drawOdds ?? oddsItem.drawTeamOdds);
      const mlA = mlValue(oddsItem.awayTeamOdds);
      if(mlH != null && mlD != null && mlA != null){
        [pHome, pDraw, pAway] = devig([mlH, mlD, mlA].map(americanToProb));
      }
    } else if(oddsItems.length){
      dumpShapeOnce('odds item (no moneyline recognized)', oddsItems[0]);
    }

    // --- props: follow the odds item's own propBets link (no hardcoded provider path) ---
    let csH, csA, btts, xgH, xgA;
    const propRef = oddsItem?.propBets?.$ref;
    if(propRef){
      try {
        const props = await deref((await getJSON(propRef + (propRef.includes('?') ? '&' : '?') + 'limit=300'))?.items);
        if(props.length) dumpShapeOnce('propBet', props[0]);
        for(const p of props){
          const name = (p.name || p.propBetTypeName || p.type?.name || '').toLowerCase();
          const target = (p.athleteOrTeamName || p.teamName || p.team?.displayName || '').toLowerCase();
          const isHome = target && home.team.displayName.toLowerCase().includes(target.split(' ')[0]);
          const over = mlValue(p.current?.over ?? p.over);
          const yes  = mlValue(p.current?.yes ?? p.yes);
          const no   = mlValue(p.current?.no ?? p.no);
          if(name.includes('total goals') && name.includes('1.5') && over != null){
            const lamb = poissonFromOver15(americanToProb(over));
            if(isHome) xgH = lamb; else xgA = lamb;
          }
          if(name.includes('clean sheet') && yes != null && no != null){
            const [pYes] = devig([americanToProb(yes), americanToProb(no)]);
            if(isHome) csH = pYes; else csA = pYes;
          }
          if((name.includes('both teams to score') || name.includes('btts')) && yes != null && no != null){
            [btts] = devig([americanToProb(yes), americanToProb(no)]);
          }
        }
      } catch(err){ console.warn(`[props] ${h}v${a}: ${err.message}`); }
    }

    const r3 = v => v == null ? undefined : Math.round(v*10000)/10000;
    const set = (obj, team, md, val) => { (obj[team] = obj[team] || {})[md] = val; };
    if(pHome != null){
      set(XG, h, mdH, {teamXG:r3(xgH), oppXG:r3(xgA), opp:a, total:2.5, home:true,  pWin:r3(pHome), pDraw:r3(pDraw)});
      set(XG, a, mdA, {teamXG:r3(xgA), oppXG:r3(xgH), opp:h, total:2.5, home:false, pWin:r3(pAway), pDraw:r3(pDraw)});
    }
    if(csH != null || csA != null || xgH != null || btts != null){
      set(MKT, h, mdH, {opp:a, home:true,  cs:r3(csH), btts:r3(btts), opp_cs:r3(csA), xg:r3(xgH), opp_xg:r3(xgA)});
      set(MKT, a, mdA, {opp:h, home:false, cs:r3(csA), btts:r3(btts), opp_cs:r3(csH), xg:r3(xgA), opp_xg:r3(xgH)});
    }
  }

  // SANITY GATE — never patch with thin data; the baked snapshot stays in place instead.
  const nXG = Object.keys(XG).length, nMKT = Object.keys(MKT).length;
  console.log(`[refresh-odds] coverage: ${nXG} teams with devigged moneyline, ${nMKT} teams with props`);
  if(nXG < 16) throw new Error(`only ${nXG} teams with moneyline data (need ≥16) — refusing to patch`);

  const today = new Date().toISOString().slice(0,10);
  const ser = obj => {
    const keys = Object.keys(obj).sort();
    if(keys.length === 0) throw new Error('refusing to serialize empty odds block');
    return '{\n' + keys.map(t=>{
      const mds = obj[t];
      const inner = Object.keys(mds).sort().map(md=>`${md}:${JSON.stringify(mds[md]).replace(/"([a-zA-Z_]+)":/g,'$1:')}`).join(',');
      return `  ${t}:{${inner}}`;
    }).join(',\n') + ',\n};';
  };

  const xgBlock  = `const BOOKIE_XG = ${ser(XG)}`;
  const mktBlock = nMKT > 0 ? `const BOOKIE_MARKETS = ${ser(MKT)}` : null;

  // self-validate generated JS before touching index.html
  new Function(xgBlock);
  if(mktBlock) new Function(mktBlock);

  if(!APPLY){
    console.log(`// generated ${today} — dry run (use --apply to patch index.html)\n`);
    console.log(xgBlock + '\n');
    if(mktBlock) console.log(mktBlock);
    return;
  }

  let html = fs.readFileSync(INDEX, 'utf8');
  const swaps = [
    [/const BOOKIE_SNAPSHOT_DATE = '[^']*';/, `const BOOKIE_SNAPSHOT_DATE = '${today}';`],
    [/const BOOKIE_XG = \{[\s\S]*?\n\};/, xgBlock],
  ];
  if(mktBlock) swaps.push([/const BOOKIE_MARKETS = \{[\s\S]*?\n\};/, mktBlock]);
  else console.warn('[refresh-odds] no prop markets parsed — keeping existing BOOKIE_MARKETS snapshot');
  for(const [re, repl] of swaps){
    if(!re.test(html)) throw new Error(`marker not found: ${re}`);
    html = html.replace(re, repl);
  }
  fs.writeFileSync(INDEX, html);
  console.log(`[refresh-odds] patched index.html — snapshot ${today}`);
}

const PROBE = process.argv.includes('--probe');
(PROBE ? probe() : main()).catch(err => { console.error('[refresh-odds] FAILED:', err.message); process.exit(1); });
