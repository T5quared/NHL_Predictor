#!/usr/bin/env node
// Daily props run: grade yesterday's prop picks, scan tonight's prop board, score and rank every prop,
// build the Props dashboard, post the top picks to Discord.
//   SPORTSGAMEODDS_API_KEY — prop board + consensus odds (free plan). Without it: standard lines, no edge.
//   DISCORD_WEBHOOK_URL    — where to post (skipped if missing)
//   DASHBOARD_URL          — optional link added to the Discord post
//   DRY_RUN=1              — don't post or touch the tracker
//   DATE=YYYY-MM-DD        — run for a specific date (testing)
const fs = require('fs');
const path = require('path');
const nhl = require('../nhl');
const sgo = require('./sgo');
const players = require('./nhlPlayers');
const { playerRate, matchupFactor } = require('./rate');
const { hitRates, scoreProp, rankProps, poissonSideProb, probToAmerican } = require('./scoring');
const { MARKETS, FALLBACK, TOP_N_DISCORD, BLEND, FILTERS } = require('./config');
const nfl = require('./nfl');

const ROOT = path.join(__dirname, '..', '..');
const PROPS_FILE = path.join(ROOT, 'data', 'props.json');
const TRACKER_FILE = path.join(ROOT, 'data', 'props-tracker.json');
const LAST_RUN_FILE = path.join(ROOT, 'data', 'last-run.json');
const TEMPLATE = path.join(ROOT, 'dashboard', 'props-template.html');
const DASHBOARD = path.join(ROOT, 'dashboard', 'props.html');

const env = k => (process.env[k] || '').trim();
const DRY_RUN = ['1', 'true'].includes(env('DRY_RUN'));
const SGO_KEY = env('SPORTSGAMEODDS_API_KEY');
const WEBHOOK = env('DISCORD_WEBHOOK_URL');

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1) + '\n');
const NHL_MARKETS = Object.fromEntries(MARKETS.NHL.map(m => [m.key, m]));

// ── Grade earlier picks from each player's game log ──────────────────
async function gradePending(tracker, today, season) {
  const pending = tracker.filter(p => p.result == null && p.date < today);
  const ids = [...new Set(pending.map(p => p.playerId))];
  const logs = {};
  await players.pool(ids, 6, async id => { logs[id] = await players.fetchGameLog(id, season); });
  let graded = 0;
  for (const p of pending) {
    const log = logs[p.playerId];
    if (!Array.isArray(log)) continue;
    const g = log.find(x => x.date === p.date);
    const daysAgo = (Date.parse(today) - Date.parse(p.date)) / 864e5;
    if (!g) { if (daysAgo >= 3) { p.result = 'void'; graded++; } continue; }   // didn't play
    p.actual = g[p.stat];
    p.result = p.actual === p.line ? 'push' : (p.side === 'over' ? p.actual > p.line : p.actual < p.line) ? 'hit' : 'miss';
    graded++;
  }
  return graded;
}

// ── Prop board ───────────────────────────────────────────────────────
async function boardFromOdds(today, games) {
  const events = await sgo.fetchEvents({
    apiKey: SGO_KEY, leagueID: 'NHL',
    startsAfter: `${today}T09:00:00Z`, startsBefore: `${nhl.addDays(today, 1)}T09:00:00Z`,
  });
  return { rows: sgo.parseProps(events, 'NHL', games), objects: events.length };
}

// No odds key: top skaters by ice time on standard lines
function boardFromStandardLines(games, skaters) {
  const rows = [];
  for (const g of games) {
    for (const [team, opp, home] of [[g.awayTeam.abbrev, g.homeTeam.abbrev, false], [g.homeTeam.abbrev, g.awayTeam.abbrev, true]]) {
      const top = skaters.filter(s => s.team === team && s.gp > 0).sort((a, b) => b.toi - a.toi).slice(0, FALLBACK.SKATERS_PER_TEAM);
      for (const s of top) {
        for (const m of MARKETS.NHL) {
          let lines = FALLBACK.LINES[m.key];
          if (m.key === 'shots') {                       // the half line closest to his average
            const avg = s.shots / s.gp;
            lines = [lines.reduce((best, l) => Math.abs(l - avg) < Math.abs(best - avg) ? l : best)];
          }
          // Under 0.5 is priced around -300 to -500 at the books, so it's never a real bet here
          for (const line of lines) for (const side of line < 1 ? ['over'] : ['over', 'under']) {
            rows.push({ eventId: g.id, startsAt: g.startTimeUTC, playerName: s.name, playerId: s.id, team, opp, home,
              market: m.key, marketLabel: m.label, stat: m.stat, line, side, bookOdds: null, implied: null, books: 0 });
          }
        }
      }
    }
  }
  return rows;
}

// Tonight's team goal projections from the 11 AM picks run
function teamLambdas(today) {
  const last = readJson(LAST_RUN_FILE, null);
  const out = {};
  if (last?.date !== today) return out;
  for (const g of last.games || []) {
    out[g.away] = { lambda: g.lambdaAway, gfPG: g.awayStats?.gfPG };
    out[g.home] = { lambda: g.lambdaHome, gfPG: g.homeStats?.gfPG };
  }
  return out;
}

// ── Discord ──────────────────────────────────────────────────────────
const SHORT = { points: 'PTS', assists: 'AST', goals: 'G', shots: 'SOG' };
const fmtOdds = o => o == null ? '' : o > 0 ? `+${o}` : `${o}`;
const pct = x => `${Math.round(x * 100)}%`;
function buildMessage(today, out) {
  const picks = out.props.filter(p => p.topPick).slice(0, TOP_N_DISCORD);
  const dateStr = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const lines = [`🎯 **NHL Props — ${dateStr}** (top ${picks.length} of ${out.counts.topPicks} picks)`];
  if (!picks.length) lines.push('No props passed the filters today.');
  picks.forEach((p, i) => lines.push(
    `${i + 1}. **${p.playerName}** ${p.side === 'over' ? 'O' : 'U'} ${p.line} ${SHORT[p.market]}`
    + (p.bookOdds != null ? ` (${fmtOdds(p.bookOdds)})` : '')
    + ` · ${pct(p.finalProb)}` + (p.edge != null ? ` · edge +${(p.edge * 100).toFixed(1)}%` : '')
    + ` · L10 ${p.rates.l10.hits}/${p.rates.l10.n}` + (p.consistent ? ' ✅' : '')));
  if (out.mode === 'standard-lines') lines.push('-# ⚠️ No odds feed: standard lines, ranked by probability (no edge)');
  if (out.record.n) lines.push(`-# 📊 Prop record: ${out.record.hits}/${out.record.n} (${pct(out.record.hits / out.record.n)})`);
  if (env('DASHBOARD_URL')) lines.push(`-# 📋 Full table: <${env('DASHBOARD_URL')}>`);
  return lines.join('\n');
}
async function postToDiscord(content) {
  const res = await fetch(WEBHOOK + (WEBHOOK.includes('?') ? '&' : '?') + 'wait=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1990) }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}`);
}

// ── Dashboard: the data goes inside the HTML so the page works opened straight from a file ──
function writeDashboard(out) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const json = JSON.stringify(out).replace(/</g, '\\u003c');
  fs.writeFileSync(DASHBOARD, tpl.replace('/*__PROPS_DATA__*/null', json));
}

function recordOf(tracker) {
  const done = tracker.filter(p => p.result === 'hit' || p.result === 'miss');
  const byMarket = {};
  for (const p of done) {
    const m = (byMarket[p.market] ||= { hits: 0, n: 0 });
    m.n++; if (p.result === 'hit') m.hits++;
  }
  // Which half of the blend has been more accurate (lower Brier = better) — for the 2-week review
  const brier = key => done.length ? done.reduce((s, p) => s + ((p[key] ?? 0.5) - (p.result === 'hit' ? 1 : 0)) ** 2, 0) / done.length : null;
  return { hits: done.filter(p => p.result === 'hit').length, n: done.length, byMarket,
    brier: { model: brier('modelProb'), hitRate: brier('hitShrunk'), final: brier('finalProb'), market: brier('implied') } };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const today = env('DATE') || nhl.etDate();
  const { season, prior } = nhl.seasonFor(today);
  console.log(`NHL props — ${today} (season ${season})${DRY_RUN ? ' [DRY RUN]' : ''}${SGO_KEY ? '' : ' [no odds key: standard lines]'}`);

  const tracker = readJson(TRACKER_FILE, []);
  const graded = await gradePending(tracker, today, season);
  console.log(`Graded ${graded} earlier prop pick(s)`);

  const games = (await nhl.fetchGamesOn(today)).filter(g => !['PPD', 'CNCL'].includes(g.gameScheduleState));
  const [skaters, priorSkaters, teamStats] = await Promise.all([
    players.fetchSkaters(season), players.fetchSkaters(prior).catch(() => []), nhl.fetchTeamStats(season),
  ]);
  const shotsAgainst = await players.fetchShotsAgainst(season, teamStats).catch(() => ({ byTeam: {}, leagueAvg: null }));
  const lambdas = teamLambdas(today);
  const priorById = Object.fromEntries(priorSkaters.map(s => [s.id, s]));
  const skaterById = Object.fromEntries(skaters.map(s => [s.id, s]));

  let rows = [], mode = 'odds', objects = 0, warning = null;
  if (games.length) {
    if (SGO_KEY) {
      try { ({ rows, objects } = await boardFromOdds(today, games)); }
      catch (e) { warning = `Odds feed failed (${e.message}) — fell back to standard lines`; console.error(warning); }
      if (!rows.length && !warning) warning = 'Odds feed returned no NHL props yet — fell back to standard lines';
    }
    if (!rows.length) { mode = 'standard-lines'; rows = boardFromStandardLines(games, skaters); }
  }

  // Match sportsbook names to NHL players
  const match = players.buildMatcher(skaters);
  let unmatched = 0;
  for (const r of rows) {
    if (r.playerId) continue;
    const s = match(r.playerName, r.team);
    if (s) { r.playerId = s.id; if (!r.team) { r.team = s.team; } }
    else unmatched++;
  }
  rows = rows.filter(r => r.playerId);
  if (unmatched) console.log(`Skipped ${unmatched} prop row(s) with no NHL player match`);

  // Game logs (one call per player)
  const ids = [...new Set(rows.map(r => r.playerId))];
  const logs = {};
  await players.pool(ids, 6, async id => { logs[id] = await players.fetchGameLog(id, season); });

  const scored = [];
  for (const r of rows) {
    const log = logs[r.playerId];
    if (!Array.isArray(log)) continue;
    const market = NHL_MARKETS[r.market];
    const sk = skaterById[r.playerId];
    const factor = matchupFactor({
      market, teamLambda: lambdas[r.team]?.lambda, teamGfPG: lambdas[r.team]?.gfPG,
      oppShotsAgainst: shotsAgainst.byTeam[r.opp], leagueShotsAgainst: shotsAgainst.leagueAvg,
    });
    const rate = playerRate({ log, stat: r.stat, pos: sk?.pos, prior: priorById[r.playerId], factor });
    const modelProb = poissonSideProb(rate, r.line, r.side);
    const rates = hitRates(log.map(g => g[r.stat]), r.line, r.side);
    const s = scoreProp({ modelProb, rates, implied: r.implied, bookOdds: r.bookOdds, gamesPlayed: log.length });
    scored.push({ ...r, pos: sk?.pos || null, gp: log.length, rate, factor, modelProb, rates, ...s });
  }
  const ranked = rankProps(scored);

  // Log today's Top picks for grading (once per day)
  const already = new Set(tracker.filter(p => p.date === today).map(p => `${p.playerId}|${p.market}|${p.side}`));
  if (!DRY_RUN) {
    for (const p of ranked.filter(x => x.topPick)) {
      const k = `${p.playerId}|${p.market}|${p.side}`;
      if (already.has(k)) continue;
      tracker.push({ date: today, sport: 'NHL', mode, playerId: p.playerId, playerName: p.playerName, team: p.team, opp: p.opp,
        market: p.market, stat: p.stat, line: p.line, side: p.side, bookOdds: p.bookOdds, implied: p.implied,
        modelProb: +p.modelProb.toFixed(4), hitShrunk: +p.hitShrunk.toFixed(4), finalProb: +p.finalProb.toFixed(4),
        edge: p.edge == null ? null : +p.edge.toFixed(4), consistent: p.consistent, actual: null, result: null });
    }
  }

  const out = {
    sport: 'NHL', date: today, generatedAt: new Date().toISOString(), mode, warning,
    settings: { BLEND, FILTERS }, objectsUsed: objects,
    counts: { scanned: ranked.length, topPicks: ranked.filter(p => p.topPick).length, games: games.length },
    record: recordOf(tracker),
    nfl: nfl.status(),
    props: ranked.map(p => ({
      playerName: p.playerName, playerId: p.playerId, team: p.team, opp: p.opp, home: p.home, pos: p.pos, startsAt: p.startsAt,
      market: p.market, marketLabel: p.marketLabel, line: p.line, side: p.side, bookOdds: p.bookOdds,
      implied: p.implied, books: p.books, gp: p.gp, rates: p.rates,
      modelProb: +p.modelProb.toFixed(4), hitShrunk: +p.hitShrunk.toFixed(4), finalProb: +p.finalProb.toFixed(4),
      edge: p.edge == null ? null : +p.edge.toFixed(4), fairOdds: probToAmerican(p.finalProb),
      consistent: p.consistent, topPick: p.topPick, failed: p.failed,
    })),
    recentResults: tracker.filter(p => p.result).slice(-60).reverse(),
  };

  writeJson(PROPS_FILE, out);
  writeDashboard(out);
  console.log(`Scanned ${out.counts.scanned} props · ${out.counts.topPicks} top picks · mode ${mode}${objects ? ` · ${objects} odds objects used` : ''}`);

  const message = games.length ? buildMessage(today, out) : null;
  if (message) console.log('\n' + message + '\n');
  if (!DRY_RUN) {
    writeJson(TRACKER_FILE, tracker);
    if (message && WEBHOOK) { await postToDiscord(message); console.log('Posted to Discord'); }
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildMessage, gradePending, boardFromStandardLines, recordOf };
