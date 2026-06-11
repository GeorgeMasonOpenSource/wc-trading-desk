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

// ---- Poisson match model: solve (lamHome, lamAway) from devigged 3-way moneyline +
// devigged match-total over/under 2.5 (both fully two-sided markets on the DK odds item).
const poissonPmf = (k, lam) => Math.exp(-lam) * Math.pow(lam, k) / [1,1,2,6,24,120,720,5040,40320,362880,3628800,39916800,479001600][k];
function matchProbs(lamH, lamA){
  let pH = 0, pD = 0;
  for(let h=0; h<=12; h++) for(let a=0; a<=12; a++){
    const p = poissonPmf(h, lamH) * poissonPmf(a, lamA);
    if(h > a) pH += p; else if(h === a) pD += p;
  }
  return {pH, pD};
}
function solveLambdas(pHome, pAway, pOver25){
  // total T from P(NH+NA >= 3) = pOver25, NH+NA ~ Poisson(T)
  let lo = 0.2, hi = 7;
  for(let i=0;i<60;i++){
    const T = (lo+hi)/2;
    const p = 1 - Math.exp(-T)*(1 + T + T*T/2);
    if(p < pOver25) lo = T; else hi = T;
  }
  const T = (lo+hi)/2;
  // split T so the model's home-win share matches the devigged moneyline
  const targetRatio = pHome / (pHome + pAway);
  let sLo = 0.05, sHi = 0.95;
  for(let i=0;i<50;i++){
    const s = (sLo+sHi)/2;
    const {pH, pD} = matchProbs(T*s, T*(1-s));
    const ratio = pH / Math.max(1e-9, 1 - pD);
    if(ratio < targetRatio) sLo = s; else sHi = s;
  }
  const s = (sLo+sHi)/2;
  return {lamH: T*s, lamA: T*(1-s)};
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

    // --- odds item: core endpoint (carries team $refs, two-sided totals, propBets) ---
    let pHome, pDraw, pAway, oddsItem = null;
    try {
      const items = await deref((await getJSON(EVENT_ODDS(e.id)))?.items);
      oddsItem = items.find(it => String(it?.provider?.id) === '100') || items[0];   // DraftKings = 100
    } catch(err){ console.warn(`[odds] ${h}v${a}: ${err.message}`); }
    const mlSrc = oddsItem || (comp.odds || [])[0];
    if(mlSrc){
      const mlH = mlValue(mlSrc.homeTeamOdds);
      const mlD = mlValue(mlSrc.drawOdds ?? mlSrc.drawTeamOdds);
      const mlA = mlValue(mlSrc.awayTeamOdds);
      if(mlH != null && mlD != null && mlA != null){
        [pHome, pDraw, pAway] = devig([mlH, mlD, mlA].map(americanToProb));
      }
    }

    // --- team xG from fully two-sided markets: 3-way moneyline + match total O/U 2.5.
    // (DK team-level props list Yes/No as separate items both priced under current.over,
    // with no side label — orientation is ambiguous, so we do NOT trust them blindly.)
    let csH, csA, btts, xgH, xgA;
    if(pHome != null && typeof oddsItem?.overOdds === 'number' && typeof oddsItem?.underOdds === 'number' && oddsItem?.overUnder === 2.5){
      const [pOver25] = devig([americanToProb(oddsItem.overOdds), americanToProb(oddsItem.underOdds)]);
      const {lamH, lamA} = solveLambdas(pHome, pAway, pOver25);
      if(lamH > 0.15 && lamH < 4.5 && lamA > 0.15 && lamA < 4.5){ xgH = lamH; xgA = lamA; }
    }

    // --- CS / BTTS from prop PAIRS, orientation resolved against the Poisson anchor.
    // Each market's Yes and No arrive as two same-type items; devig the pair, then pick
    // the side closest to the model anchor (cs ≈ e^-lamOpp, btts ≈ (1-e^-lamH)(1-e^-lamA)).
    const teamIdOf = ref => (ref || '').match(/teams\/(\d+)/)?.[1];
    const homeId = teamIdOf(oddsItem?.homeTeamOdds?.team?.$ref);
    const awayId = teamIdOf(oddsItem?.awayTeamOdds?.team?.$ref);
    const probFromPrice = o => {
      if(!o) return null;
      if(typeof o.american === 'string' || typeof o.american === 'number'){
        const n = typeof o.american === 'string' ? parseInt(o.american.replace('+',''), 10) : o.american;
        if(Number.isFinite(n)) return americanToProb(n);
      }
      if(typeof o.value === 'number' && o.value > 1) return 1 / o.value;   // decimal odds
      return null;
    };
    // devig a yes/no pair and return the side nearest the anchor; single price → trim vig,
    // accept only if within 0.22 of the anchor (otherwise it may be the wrong side).
    const resolvePair = (prices, anchor) => {
      if(anchor == null) return null;
      if(prices.length >= 2){
        const [q1] = devig([prices[0], prices[1]]);
        return Math.abs(q1 - anchor) <= Math.abs((1 - q1) - anchor) ? q1 : 1 - q1;
      }
      if(prices.length === 1){
        const q = prices[0] * 0.96;
        return Math.abs(q - anchor) <= 0.22 ? q : null;
      }
      return null;
    };
    if(oddsItem && homeId && awayId && xgH != null){
      try {
        const pid = oddsItem.provider?.id ?? 100;
        const propBase = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${e.id}/competitions/${e.id}/odds/${pid}/propBets`;
        const props = [];
        for(let page=1; page<=5; page++){
          const pj = await getJSON(`${propBase}?limit=200&page=${page}`);
          props.push(...(pj.items||[]));
          if(props.length >= (pj.count||0)) break;
        }
        const csPrices = {[homeId]:[], [awayId]:[]};
        const bttsPrices = [];
        for(const p of props){
          const prob = probFromPrice(p.current?.over);
          if(prob == null) continue;
          if(p.type?.name === 'Team Clean Sheet'){
            const tid = teamIdOf(p.team?.$ref);
            if(csPrices[tid]) csPrices[tid].push(prob);
          } else if(p.type?.name === 'Both Teams To Score'){
            bttsPrices.push(prob);
          }
        }
        csH  = resolvePair(csPrices[homeId], Math.exp(-xgA));
        csA  = resolvePair(csPrices[awayId], Math.exp(-xgH));
        btts = resolvePair(bttsPrices, (1 - Math.exp(-xgH)) * (1 - Math.exp(-xgA)));
      } catch(err){ console.warn(`[props] ${h}v${a}: ${err.message}`); }
      // Poisson fallback keeps CS coverage complete even when prop pairs are unusable
      if(csH == null) csH = Math.exp(-xgA);
      if(csA == null) csA = Math.exp(-xgH);
      const clamp = v => v == null ? v : Math.min(0.90, Math.max(0.03, v));
      csH = clamp(csH); csA = clamp(csA); btts = clamp(btts);
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
