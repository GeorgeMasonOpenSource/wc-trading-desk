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

// Window spans the whole tournament (group + knockouts). Completed games still appear as events
// (with scores, usually no live odds), so each team's Nth event reliably maps to its Nth match:
// games 1-3 = group MD1-3, 4 = R32, 5 = R16, 6 = QF, 7 = SF, 8 = Final.
// limit=400: ESPN's default scoreboard page is 100 events — the tournament has 104 (72 group + 16
// R32 + 8 R16 + 4 QF + 2 SF + 3rd place + Final), so without the param the SF/3rd/Final events are
// silently truncated from every refresh (kickoffs, odds, and bracket for the last rounds all missing).
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260720&limit=400';
const EVENT_ODDS = id => `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${id}/competitions/${id}/odds?limit=20`;
const ROUND_OF = n => n <= 3 ? String(n) : ({4:'R32',5:'R16',6:'QF',7:'SF',8:'F'}[n] || null);
const IS_KO = md => md != null && !/^[1-3]$/.test(md);

// Unresolved knockout slots appear as events with PLACEHOLDER competitors (abbreviation "RD32",
// "TBD", etc.) — not empty, so they'd otherwise inflate the per-team game ordinal and produce
// bogus matchups. Only count/record games between two REAL teams. The valid set is derived from
// index.html's own KICKOFFS keys ("MEX_1":...) so it stays in sync with the 48-team field.
function validTeamSet(){
  try {
    const h = fs.readFileSync(INDEX, 'utf8');
    const s = new Set([...h.matchAll(/"([A-Z]{3})_[123]":/g)].map(m => m[1]));
    return s.size >= 32 ? s : null;
  } catch { return null; }
}
const VALID_TEAMS = validTeamSet();
const isRealTeam = ab => ab ? (VALID_TEAMS ? VALID_TEAMS.has(ab) : /^[A-Z]{3}$/.test(ab)) : false;

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
function solveLambdas(pHome, pAway, pOver, line){
  // total T from P(NH+NA >= ceil(line)) = pOver, NH+NA ~ Poisson(T).
  // Heavy favorites are priced at 3.5 (or higher) totals, so support any half-goal line.
  const k = Math.ceil(line);   // need at least k goals to clear the line
  const pAtLeastK = T => { let cdf = 0, term = Math.exp(-T); for(let i=0;i<k;i++){ cdf += term; term *= T/(i+1); } return 1 - cdf; };
  let lo = 0.2, hi = 8;
  for(let i=0;i<60;i++){
    const T = (lo+hi)/2;
    if(pAtLeastK(T) < pOver) lo = T; else hi = T;
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
  const events = (sb.events || []).slice().sort((x,y)=>Date.parse(x.date||0)-Date.parse(y.date||0));
  if(!events.length) throw new Error('no events');

  // Replay the ordinal→round mapping so CI logs show whether knockouts are ingested correctly.
  const gameNo = {}; const byRound = {}; const koMatchups = []; const realEvents = [];
  for(const ev of events){
    const c = ev.competitions?.[0]; if(!c) continue;
    const h = c.competitors?.find(x=>x.homeAway==='home')?.team?.abbreviation;
    const a = c.competitors?.find(x=>x.homeAway==='away')?.team?.abbreviation;
    if(!isRealTeam(h) || !isRealTeam(a)) continue;   // skip unresolved placeholder fixtures
    gameNo[h]=(gameNo[h]||0)+1; gameNo[a]=(gameNo[a]||0)+1;
    const round = ROUND_OF(gameNo[h]);
    byRound[round] = (byRound[round]||0)+1;
    realEvents.push(ev);
    if(IS_KO(round)) koMatchups.push(`${round}: ${h} v ${a} @ ${ev.date}`);
  }
  console.log(`[probe] ${events.length} events (${realEvents.length} real-vs-real); games per round:`, JSON.stringify(byRound));
  console.log(`[probe] knockout matchups detected (${koMatchups.length}):`);
  koMatchups.forEach(m=>console.log('   ', m));

  // Dump odds shapes for the LAST real-matchup event (most likely an upcoming/priced KO game).
  const e = realEvents[realEvents.length-1];
  if(!e){ console.log('[probe] no real-team events to sample odds from'); return; }
  console.log(`[probe] sampling odds for event ${e.id}: ${e.name} @ ${e.date}`);
  const base = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${e.id}/competitions/${e.id}`;
  let items = [];
  try { items = await deref((await getJSON(EVENT_ODDS(e.id)))?.items); }
  catch(err){ console.log(`[probe] no odds for this event (${err.message}) — expected for unpriced rounds`); return; }
  const it = items[0];
  console.log(`[probe] provider ${it?.provider?.name} (${it?.provider?.id}); homeTeam $ref: ${it?.homeTeamOdds?.team?.$ref}; awayTeam $ref: ${it?.awayTeamOdds?.team?.$ref}`);
  const pid = it?.provider?.id ?? 100;
  const all = [];
  try {
    for(let page=1; page<=5; page++){
      const pj = await getJSON(`${base}/odds/${pid}/propBets?limit=200&page=${page}`);
      all.push(...(pj.items||[]));
      if(all.length >= (pj.count||0)) break;
    }
  } catch(err){ console.log(`[probe] propBets unavailable (${err.message}) — round likely unpriced`); }
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

// ---------- PROJECTED BRACKET (BRACKET_TREE) ----------
// ESPN encodes the knockout tree in placeholder competitor names ("Round of 32 12 Winner at
// Round of 32 11 Winner"). Those names carry the lineage ONLY while unresolved — once a feeder
// game finishes, ESPN swaps the placeholder for the real team and the slot number vanishes.
// So the tree is built by OBSERVED MERGE: each run parses whatever placeholders remain, binds
// slot→matchup whenever a side has resolved to a real team, and merges with the tree already
// committed in index.html (the page itself is the persistence). Bindings only ever grow; nothing
// is guessed. The app's projectedOpponent() walks exactly as far as bindings allow.
const KO_LEVELS = [
  {key:'r16', slug:'round-of-16',   feeder:/^Round of 32 (\d+) Winner$/,  prev:'slot'},
  {key:'qf',  slug:'quarterfinals', feeder:/^Round of 16 (\d+) Winner$/,  prev:'r16'},
  {key:'sf',  slug:'semifinals',    feeder:/^Quarterfinal (\d+) Winner$/, prev:'qf'},
  {key:'f',   slug:'final',         feeder:/^Semifinal (\d+) Winner$/,    prev:'sf'},
];
function parsePriorTree(html){
  const m = html.match(/const BRACKET_TREE = (\{[\s\S]*?\}); \/\/ END BRACKET_TREE/);
  if(!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function buildBracketTree(events, prior, KO){
  const T = { updated: new Date().toISOString().slice(0,10),
    slots: (prior && prior.slots) || {}, r16: [], qf: [], sf: [], f: [],
    r16ord: (prior && prior.r16ord) || {}, qford: (prior && prior.qford) || {}, sford: (prior && prior.sford) || {} };
  const priorById = {};
  for(const k of ['r16','qf','sf','f']) ((prior && prior[k]) || []).forEach(e => priorById[e.id] = e);
  for(const spec of KO_LEVELS){
    const evs = events.filter(e => (e.season?.slug||'') === spec.slug)
      .sort((x,y)=>Date.parse(x.date||0)-Date.parse(y.date||0));
    for(const ev of evs){
      const comp = ev.competitions?.[0] || {};
      const cs = comp.competitors || [];
      const p = priorById[String(ev.id)] || {};
      const ent = { id:String(ev.id), k:(ev.date||'').slice(0,10),
        f:(p.f || [null,null]).slice(), away:p.away||null, home:p.home||null, w:p.w||null };
      for(const [i, side] of [[0,'away'],[1,'home']]){
        const c = cs.find(x=>x.homeAway===side);
        const dn = c?.team?.displayName || '', ab = c?.team?.abbreviation || '';
        const m = dn.match(spec.feeder);
        if(m){ ent.f[i] = +m[1]; continue; }          // still a placeholder — records the lineage
        if(!isRealTeam(ab)) continue;
        ent[side] = ab;
        const fd = ent.f[i];                          // feeder remembered from a prior run
        if(fd == null) continue;
        if(spec.prev === 'slot'){
          // R32 slot fd has resolved: `ab` won it. Its matchup comes from the KO map.
          const opp = KO?.[ab]?.R32?.opp || ((T.slots[fd]||{}).t||[]).find(t=>t!==ab) || null;
          T.slots[fd] = { t: opp ? [ab, opp] : [ab], w: ab };
        } else {
          // bind prev-level ordinal fd -> the prev-level event that produced `ab`
          const prevList = T[spec.prev].length ? T[spec.prev] : ((prior && prior[spec.prev]) || []);
          const pe = prevList.find(e=>e.away===ab || e.home===ab || e.w===ab);
          if(pe) T[spec.prev + 'ord'][fd] = pe.id;
        }
      }
      if(ent.away && ent.home && comp.status?.type?.state === 'post'){
        const wc = cs.find(x=>x.winner || x.advance);
        const wab = wc?.team?.abbreviation;
        if(isRealTeam(wab)) ent.w = wab;
      }
      T[spec.key].push(ent);
    }
  }
  return T;
}

async function main(){
  const sb = await getJSON(SCOREBOARD);
  const events = sb.events || [];
  if(events.length === 0) throw new Error('scoreboard returned no events — check the dates window');

  const XG = {};      // team -> md -> {teamXG, oppXG, opp, total, home, pWin, pDraw}
  const MKT = {};     // team -> md -> {opp, home, cs, btts, opp_cs, xg, opp_xg}
  const KO = {};      // team -> round -> {opp, home, kickoff} — the resolved knockout bracket
  const teamGameNo = {};   // ESPN scoreboard is date-ordered; a team's Nth event = its Nth match

  // Events must be processed in chronological order for the ordinal→round mapping to hold.
  events.sort((x,y)=>Date.parse(x.date||0) - Date.parse(y.date||0));

  for(const e of events){
    const comp = e.competitions?.[0]; if(!comp) continue;
    const comps = comp.competitors || [];
    const home = comps.find(c=>c.homeAway==='home');
    const away = comps.find(c=>c.homeAway==='away');
    // Skip unresolved knockout slots (placeholder competitors like "RD32"/"TBD") — counting them
    // would corrupt the game ordinal and emit bogus matchups. They resolve in a later refresh.
    const h = home?.team?.abbreviation, a = away?.team?.abbreviation;
    if(!isRealTeam(h) || !isRealTeam(a)) continue;
    teamGameNo[h] = (teamGameNo[h]||0)+1; teamGameNo[a] = (teamGameNo[a]||0)+1;
    const mdH = ROUND_OF(teamGameNo[h]), mdA = ROUND_OF(teamGameNo[a]);
    if(mdH == null || mdA == null) continue;   // beyond the Final / unexpected ordinal

    // Capture the knockout bracket (matchup + kickoff) regardless of whether odds are priced yet —
    // the in-app KNOCKOUTS block drives detection/opponent lookup even before bookies price a round.
    if(IS_KO(mdH)) (KO[h] = KO[h] || {})[mdH] = {opp:a, home:true,  kickoff:e.date};
    if(IS_KO(mdA)) (KO[a] = KO[a] || {})[mdA] = {opp:h, home:false, kickoff:e.date};

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
    const totLine = oddsItem?.overUnder;
    if(pHome != null && typeof oddsItem?.overOdds === 'number' && typeof oddsItem?.underOdds === 'number'
       && typeof totLine === 'number' && totLine >= 1.5 && totLine <= 5.5 && totLine % 1 === 0.5){
      const [pOver] = devig([americanToProb(oddsItem.overOdds), americanToProb(oddsItem.underOdds)]);
      const {lamH, lamA} = solveLambdas(pHome, pAway, pOver, totLine);
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

  const ser = obj => {
    const keys = Object.keys(obj).sort();
    if(keys.length === 0) throw new Error('refusing to serialize empty odds block');
    return '{\n' + keys.map(t=>{
      const mds = obj[t];
      const inner = Object.keys(mds).sort().map(md=>`${md}:${JSON.stringify(mds[md]).replace(/"([a-zA-Z_]+)":/g,'$1:')}`).join(',');
      return `  ${t}:{${inner}}`;
    }).join(',\n') + ',\n};';
  };

  const nXG = Object.keys(XG).length, nMKT = Object.keys(MKT).length, nKO = Object.keys(KO).length;
  console.log(`[refresh-odds] coverage: ${nXG} teams w/ moneyline, ${nMKT} w/ props, ${nKO} w/ knockout bracket`);

  // The knockout BRACKET refreshes independently of the odds gate — matchups + kickoffs are known
  // (and worth committing so the app advances past MD3) even when bookies haven't priced the round.
  const koBlock = nKO > 0 ? `const KNOCKOUTS = ${ser(KO)}` : null;

  // Forward bracket: merge observed lineage into the committed tree (see buildBracketTree).
  const htmlForTree = fs.readFileSync(INDEX, 'utf8');
  const tree = buildBracketTree(events, parsePriorTree(htmlForTree), KO);
  const btBlock = `const BRACKET_TREE = ${JSON.stringify(tree)}; // END BRACKET_TREE`;
  const nSlots = Object.keys(tree.slots).length;
  console.log(`[refresh-odds] bracket: ${nSlots}/16 R32 slots bound, r16ord ${Object.keys(tree.r16ord).length}/8, qford ${Object.keys(tree.qford).length}/4`);

  // SANITY GATE for the ODDS blocks only — never overwrite a good snapshot with thin data. Fewer
  // teams play deep into the knockouts (QF=8, SF=4, F=2), so the floor relaxes once KO games exist.
  const oddsFloor = nKO > 0 ? 2 : 16;
  const oddsThin = nXG < oddsFloor;
  if(oddsThin) console.log(`[refresh-odds] only ${nXG} teams with fresh moneyline (need ≥${oddsFloor}) — keeping the last odds snapshot. (not a failure)`);
  if(oddsThin && !koBlock){
    console.log('[refresh-odds] nothing to update.');
    return;
  }

  const today = new Date().toISOString().slice(0,10);
  const xgBlock  = oddsThin ? null : `const BOOKIE_XG = ${ser(XG)}`;
  const mktBlock = (!oddsThin && nMKT > 0) ? `const BOOKIE_MARKETS = ${ser(MKT)}` : null;

  // self-validate generated JS before touching index.html
  if(xgBlock) new Function(xgBlock);
  if(mktBlock) new Function(mktBlock);
  if(koBlock) new Function(koBlock);
  if(btBlock) new Function(btBlock);

  if(!APPLY){
    console.log(`// generated ${today} — dry run (use --apply to patch index.html)\n`);
    if(xgBlock) console.log(xgBlock + '\n');
    if(mktBlock) console.log(mktBlock + '\n');
    if(koBlock) console.log(koBlock);
    if(btBlock) console.log(btBlock);
    return;
  }

  let html = fs.readFileSync(INDEX, 'utf8');
  const swaps = [[/const BOOKIE_SNAPSHOT_DATE = '[^']*';/, `const BOOKIE_SNAPSHOT_DATE = '${today}';`]];
  if(xgBlock)  swaps.push([/const BOOKIE_XG = \{[\s\S]*?\n\};/, xgBlock]);
  if(mktBlock) swaps.push([/const BOOKIE_MARKETS = \{[\s\S]*?\n\};/, mktBlock]);
  else if(!oddsThin) console.warn('[refresh-odds] no prop markets parsed — keeping existing BOOKIE_MARKETS snapshot');
  if(koBlock)  swaps.push([/const KNOCKOUTS = \{[\s\S]*?\n\};/, koBlock]);
  if(btBlock)  swaps.push([/const BRACKET_TREE = \{[\s\S]*?\}; \/\/ END BRACKET_TREE/, btBlock]);
  for(const [re, repl] of swaps){
    if(!re.test(html)) throw new Error(`marker not found: ${re}`);
    html = html.replace(re, repl);
  }
  fs.writeFileSync(INDEX, html);
  console.log(`[refresh-odds] patched index.html — snapshot ${today}`);
}

// --probe-players: dump the play.fifa.com players.json stats shape so we can see what real
// per-player data (goals/assists/minutes vs just roundPoints) is available before building on it.
async function probePlayers(){
  const data = await getJSON('https://play.fifa.com/json/fantasy/players.json');
  const arr = Array.isArray(data) ? data : (data.players || data.value || data.data || []);
  console.log(`[probe-players] top-level: ${Array.isArray(data)?'array':'object keys='+Object.keys(data).join(',')}; count=${arr.length}`);
  if(!arr.length) return;
  console.log('[probe-players] player[0] keys:', Object.keys(arr[0]).join(', '));
  console.log('[probe-players] player[0]:', JSON.stringify(arr[0]).slice(0, 900));
  // the most-pointed player has definitely played → richest stats sample
  const sumRp = rp => rp ? Object.values(rp).reduce((a,b)=>a+(b||0),0) : 0;   // roundPoints is {round:pts}
  const withTot = arr.map(p => ({p, tot:sumRp(p.stats?.roundPoints)})).sort((a,b)=>b.tot-a.tot);
  const top = withTot[0]?.p;
  if(top){
    console.log('[probe-players] top scorer:', top.knownName || top.lastName, 'tot', withTot[0].tot);
    console.log('[probe-players] top.stats keys:', Object.keys(top.stats||{}).join(', '));
    console.log('[probe-players] top.stats FULL:', JSON.stringify(top.stats).slice(0, 1800));
  }
  const keyHist = {};
  for(const p of arr) for(const k of Object.keys(p.stats||{})) keyHist[k] = (keyHist[k]||0)+1;
  console.log('[probe-players] stats-key histogram:', JSON.stringify(keyHist));
}

// --probe-bracket: dump every knockout event's competitors + name so we can reconstruct the slot
// lineage. Resolved games show real teams; unresolved future games show placeholders whose NAMES
// encode the tree (e.g. "Round of 32 1 Winner at Round of 32 2 Winner") — that's the bracket.
async function probeBracket(){
  const sb = await getJSON(SCOREBOARD);
  const events = (sb.events||[]).slice().sort((x,y)=>Date.parse(x.date||0)-Date.parse(y.date||0));
  for(const ev of events){
    const c = ev.competitions?.[0]; if(!c) continue;
    const h = c.competitors?.find(x=>x.homeAway==='home');
    const a = c.competitors?.find(x=>x.homeAway==='away');
    const round = ev.season?.type?.name || c.notes?.[0]?.headline || ev.name || '';
    const nm = x => x?.team?.abbreviation || x?.team?.displayName || x?.team?.name || '?';
    // only knockout-ish events: skip the 72 group games (both real, early dates)
    const label = `${ev.date?.slice(0,10)} | ${nm(a)} @ ${nm(h)} | "${ev.name||''}" | shortName="${ev.shortName||''}"`;
    if(/Round of|Quarter|Semi|Final|Winner/i.test(ev.name||'') || /Round of|Quarter|Semi|Final|Winner/i.test(JSON.stringify(c.competitors||[]).slice(0,400)))
      console.log('[probe-bracket]', label);
  }
  // also dump one full event object so we can see if slot lineage is structured (not just in the name)
  const ko = events.find(e=>/Round of 16|Quarter/i.test(e.name||''));
  if(ko) console.log('[probe-bracket] sample KO event:', JSON.stringify(ko).slice(0, 1600));
}

// --probe-stats: check whether ESPN exposes per-player stats (goals/assists/shots/SOT/minutes) for a
// completed group game's box score — feasibility for real per-player shares.
async function probeStats(){
  const sb = await getJSON(SCOREBOARD);
  const events = (sb.events||[]).slice().sort((x,y)=>Date.parse(x.date||0)-Date.parse(y.date||0));
  const done = events.find(e => e.competitions?.[0]?.status?.type?.state === 'post');
  if(!done){ console.log('[probe-stats] no completed event found'); return; }
  console.log('[probe-stats] event', done.id, done.name);
  const base = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${done.id}/competitions/${done.id}`;
  // try the competitors → roster / statistics refs
  try {
    const comp = (await getJSON(SCOREBOARD)); // placeholder to keep getJSON warm
  } catch {}
  for(const path of ['/competitors?lang=en','/details?lang=en','/situation?lang=en']){
    try { const j = await getJSON(base+path); console.log(`[probe-stats] ${path} keys:`, Object.keys(j).join(','), '|', JSON.stringify(j).slice(0,500)); }
    catch(e){ console.log(`[probe-stats] ${path} -> ${e.message}`); }
  }
  // boxscore via site API summary
  try {
    const s = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${done.id}`);
    console.log('[probe-stats] summary keys:', Object.keys(s).join(','));
    const ath = s.boxscore?.players || s.rosters || s.boxscore?.form;
    console.log('[probe-stats] boxscore.players present:', !!s.boxscore?.players, '| sample:', JSON.stringify(s.boxscore?.players||s.rosters||'(none)').slice(0,1400));
  } catch(e){ console.log('[probe-stats] summary ->', e.message); }
}

// --probe-lineage: settle the LAST unknown for the projected bracket — which real R32 matchup is
// ESPN's "Round of 32 N" slot N. The R16 event names give the forward tree in slot numbers; this
// dumps (a) every KO event incl. SF/F (limit=400 now), (b) one resolved R32 event's core-API JSON
// and site-summary header, hunting for a structured slot/match-number field so we never guess.
async function probeLineage(){
  const sb = await getJSON(SCOREBOARD);
  const events = (sb.events||[]).slice().sort((x,y)=>Date.parse(x.date||0)-Date.parse(y.date||0));
  console.log('[probe-lineage] total events:', events.length);
  const ko = events.filter(e => (e.season?.slug||'') !== 'group-stage' &&
    !/^(1st|2nd|3rd) /.test(e.season?.slug||'') && Date.parse(e.date) >= Date.parse('2026-06-28'));
  for(const ev of ko){
    const c = ev.competitions?.[0]||{};
    const notes = (c.notes||[]).map(n=>n.headline||n.text).join(';');
    console.log(`[probe-lineage] ${ev.date?.slice(0,10)} id=${ev.id} slug=${ev.season?.slug} | "${ev.name}" | notes="${notes}" | altGameNote="${c.altGameNote||''}"`);
  }
  // Deep-dump one RESOLVED R32 event + one UNRESOLVED R16 event from the core API.
  const r32 = ko.find(e => /R32|Round of 32/i.test(e.season?.slug||'') || (Date.parse(e.date) < Date.parse('2026-07-04T06:00Z')));
  const r16 = ko.find(e => /Round of 32 \d+ Winner/.test(e.name||''));
  for(const [tag, ev] of [['R32-resolved', r32], ['R16-unresolved', r16]]){
    if(!ev) { console.log(`[probe-lineage] no ${tag} event found`); continue; }
    try {
      const core = await getJSON(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${ev.id}?lang=en`);
      console.log(`[probe-lineage] ${tag} ${ev.id} core keys:`, Object.keys(core).join(','));
      console.log(`[probe-lineage] ${tag} core dump:`, JSON.stringify(core).slice(0, 2200));
    } catch(e){ console.log(`[probe-lineage] ${tag} core -> ${e.message}`); }
    try {
      const s = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${ev.id}`);
      const hdr = s.header?.competitions?.[0] || {};
      console.log(`[probe-lineage] ${tag} summary header:`, JSON.stringify({notes: hdr.notes, series: hdr.series, note: s.gameInfo?.note, gameNote: hdr.gameNote, description: hdr.description}).slice(0,800));
    } catch(e){ console.log(`[probe-lineage] ${tag} summary -> ${e.message}`); }
  }
}

// --probe-minutes: fetch the live FIFA fantasy feed (same source the app uses client-side) and dump
// the actual per-round points / status / ownership for a few marquee players. roundPoints is the
// real minutes proxy (≥2 = started 60+, ≥1 = featured, absent/0 = DNP). Confirms whether the live
// site sees a player as benched — i.e. whether the "Saka pinned to 0.92" stale override is wrong.
async function probeMinutes(){
  // Final-round decision: dump the ESP + ARG (finalist) pool + the questioned holdings so we rate
  // minutes off real roundPoints, not stale offline mri. ESP + ARG marquee names + defenders.
  const WANT = [
    // ESP
    'nico williams','williams','pedri','yamal','oyarzabal','olmo','merino','baena','cucurella','cubarsi',
    'le normand','laporte','carvajal','unai simon','simon','raya','ferran',
    // ARG
    'messi','mac allister','lautaro','julian alvarez','alvarez','de paul','enzo','molina','romero','otamendi',
    'tagliafico','lisandro martinez','medina','emiliano martinez','nico paz','almada',
    // questioned 3rd-place / holdings
    'konsa','kane','bellingham','mbappe','dembele','olise','digne','maignan'
  ];
  const norm = s => (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[-'’.]/g,'').toLowerCase().trim();
  let players;
  try { players = await getJSON('https://play.fifa.com/json/fantasy/players.json'); }
  catch(e){ console.log('[probe-minutes] FIFA feed fetch failed:', e.message); return; }
  const arr = Array.isArray(players) ? players : (players.players || players.data || []);
  console.log('[probe-minutes] feed players:', arr.length);
  // Dump the FULL stats object of one marquee player once, to see whether the feed exposes minutes
  // per round (which would let us tell a scoring SUB apart from a starter — the roundPoints heuristic can't).
  const sample = arr.find(p => norm(p.knownName||`${p.firstName} ${p.lastName}`).includes('messi'));
  if(sample) console.log('[probe-minutes] FULL stats keys for Messi:', JSON.stringify(sample.stats));
  for(const p of arr){
    const name = p.knownName || `${p.firstName||''} ${p.lastName||''}`.trim();
    const n = norm(name);
    if(!WANT.some(w => n.includes(w))) continue;
    const rp = p.stats?.roundPoints;
    const vals = rp && typeof rp==='object' ? Object.entries(rp).map(([k,v])=>`${k}:${v}`) : [];
    // surface any minutes-like field if present
    const minsField = ['minutes','minutesPlayed','mins','roundMinutes','appearances'].find(k=>p.stats && p.stats[k]!=null);
    const mins = minsField ? `${minsField}=${JSON.stringify(p.stats[minsField])}` : 'no-minutes-field';
    console.log(`[probe-minutes] ${name} (${p.position} £${p.price} own=${p.percentSelected}% status=${p.status||'-'}) roundPoints={${vals.join(', ')}} avg=${p.stats?.avgPoints ?? '-'} | ${mins}`);
  }
}

const PROBE = process.argv.includes('--probe');
const PROBE_PLAYERS = process.argv.includes('--probe-players');
const PROBE_BRACKET = process.argv.includes('--probe-bracket');
const PROBE_STATS = process.argv.includes('--probe-stats');
const PROBE_MINUTES = process.argv.includes('--probe-minutes');
const PROBE_LINEAGE = process.argv.includes('--probe-lineage');
(PROBE_LINEAGE ? probeLineage() : PROBE_MINUTES ? probeMinutes() : PROBE_BRACKET ? probeBracket() : PROBE_STATS ? probeStats() : PROBE_PLAYERS ? probePlayers() : PROBE ? probe() : main())
  .catch(err => { console.error('[refresh-odds] FAILED:', err.message); process.exit(1); });
