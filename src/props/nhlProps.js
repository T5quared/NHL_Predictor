// NHL props: prop board → match players → game logs → score. Returns one sport section for the dashboard.
const fs = require('fs');
const path = require('path');
const nhl = require('../nhl');
const sgo = require('./sgo');
const players = require('./nhlPlayers');
const { playerRate, matchupFactor } = require('./rate');
const { hitRates, scoreProp, rankProps, poissonSideProb } = require('./scoring');
const { MARKETS, FALLBACK } = require('./config');

const LAST_RUN_FILE = path.join(__dirname, '..', '..', 'data', 'last-run.json');
const NHL_MARKETS = Object.fromEntries(MARKETS.NHL.map(m => [m.key, m]));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const logo = abbrev => `https://assets.nhle.com/logos/nhl/svg/${abbrev}_dark.svg`;

// Grade earlier NHL picks from each player's game log
async function grade(tracker, today, season) {
  const pending = tracker.filter(p => (p.sport || 'NHL') === 'NHL' && p.result == null && p.date < today);
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
            rows.push({ eventId: String(g.id), startsAt: g.startTimeUTC, playerName: s.name, playerId: s.id, team, opp, home,
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

async function run({ today, tracker, sgoKey, now = Date.now() }) {
  const { season, prior } = nhl.seasonFor(today);
  const graded = await grade(tracker, today, season);
  console.log(`[NHL] graded ${graded} earlier pick(s)`);

  const games = (await nhl.fetchGamesOn(today)).filter(g => !['PPD', 'CNCL'].includes(g.gameScheduleState));
  if (!games.length) return { sport: 'NHL', mode: 'none', warning: null, objects: 0, games: 0, props: [], events: [], nhlGames: [] };

  const [skaters, priorSkaters, teamStats] = await Promise.all([
    players.fetchSkaters(season), players.fetchSkaters(prior).catch(() => []), nhl.fetchTeamStats(season),
  ]);
  const shotsAgainst = await players.fetchShotsAgainst(season, teamStats).catch(() => ({ byTeam: {}, leagueAvg: null }));
  const lambdas = teamLambdas(today);
  const priorById = Object.fromEntries(priorSkaters.map(s => [s.id, s]));
  const skaterById = Object.fromEntries(skaters.map(s => [s.id, s]));

  let rows = [], mode = 'odds', objects = 0, warning = null, events = [];
  if (sgoKey) {
    try {
      events = await sgo.fetchEvents({ apiKey: sgoKey, leagueID: 'NHL', startsAfter: `${today}T09:00:00Z`, startsBefore: `${nhl.addDays(today, 1)}T09:00:00Z` });
      objects = events.length;
      rows = sgo.parseProps(events, 'NHL', t => sgo.teamAbbrev(t, games), now);
    } catch (e) { warning = `Odds feed failed (${e.message}) — fell back to standard lines`; console.error(warning); }
    if (!rows.length && !warning) warning = 'Odds feed returned no NHL props yet — fell back to standard lines';
  }
  if (!rows.length) { mode = 'standard-lines'; rows = boardFromStandardLines(games.filter(g => Date.parse(g.startTimeUTC) > now), skaters); }

  // Match sportsbook names to NHL players
  const match = players.buildMatcher(skaters);
  let unmatched = 0;
  for (const r of rows) {
    if (r.playerId) continue;
    const s = match(r.playerName, r.team);
    if (s) { r.playerId = s.id; if (!r.team) r.team = s.team; } else unmatched++;
  }
  rows = rows.filter(r => r.playerId);
  if (unmatched) console.log(`[NHL] skipped ${unmatched} prop row(s) with no player match`);

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
    const rates = hitRates(log.map(g => g[r.stat]), r.line, r.side, 'NHL');
    const s = scoreProp({ modelProb, rates, implied: r.implied, bookOdds: r.bookOdds, gamesPlayed: log.length, books: r.books, sport: 'NHL', projection: rate, line: r.line });
    scored.push({ ...r, pos: sk?.pos || null, gp: log.length, logo: logo(r.team), gameDate: today, projection: +rate.toFixed(2), modelProb, rates, ...s });
  }
  return { sport: 'NHL', mode, warning, objects, games: games.length, props: rankProps(scored), events, nhlGames: games };
}

module.exports = { run, grade, boardFromStandardLines };
