// NHL player data for props: skater lookups, game logs, opponent shots against. All free NHL API.
const nhl = require('../nhl');
const { norm } = require('./sgo');

const lastTeam = t => String(t || '').split(',').pop().trim();

// One call per season: every skater's totals
async function fetchSkaters(season) {
  const url = `${nhl.API_STATS}/skater/summary?isAggregate=false&isGame=false&sort=playerId&start=0&limit=-1`
    + `&cayenneExp=seasonId=${season}%20and%20gameTypeId=2`;
  const data = await nhl.fetchJson(url);
  return (data.data || []).map(s => ({
    id: s.playerId, name: s.skaterFullName, team: lastTeam(s.teamAbbrevs), pos: s.positionCode === 'D' ? 'D' : 'F',
    gp: s.gamesPlayed || 0, goals: s.goals || 0, assists: s.assists || 0, points: s.points || 0, shots: s.shots || 0,
    toi: s.timeOnIcePerGame || 0,
  }));
}

// Find an NHL player id for a sportsbook name (+ team when known)
function buildMatcher(skaters) {
  const byName = new Map();
  for (const s of skaters) {
    const k = norm(s.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }
  return (name, team) => {
    const k = norm(name);
    let hits = byName.get(k) || [];
    if (!hits.length) {                       // "J.T. Miller" vs "JT Miller", "Mitch" vs "Mitchell"
      const parts = k.split(' ');
      const last = parts.slice(1).join(' '), initial = parts[0]?.[0];
      hits = skaters.filter(s => {
        const p = norm(s.name).split(' ');
        return p.slice(1).join(' ') === last && p[0]?.[0] === initial && (!team || s.team === team);
      });
    }
    if (hits.length > 1 && team) hits = hits.filter(s => s.team === team);
    return hits.length === 1 ? hits[0] : null;
  };
}

// This season's game log, newest first
async function fetchGameLog(playerId, season) {
  const data = await nhl.fetchJson(`${nhl.API_WEB}/player/${playerId}/game-log/${season}/2`);
  return (data.gameLog || [])
    .map(g => ({ date: g.gameDate, opp: g.opponentAbbrev, goals: g.goals || 0, assists: g.assists || 0, points: g.points || 0, shots: g.shots || 0 }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Shots against per game by team abbrev (team summary only has full names, so map through standings names)
async function fetchShotsAgainst(season, teamStats) {
  const url = `${nhl.API_STATS}/team/summary?isAggregate=false&isGame=false&sort=teamId&start=0&limit=50`
    + `&cayenneExp=seasonId=${season}%20and%20gameTypeId=2`;
  const data = await nhl.fetchJson(url);
  const byName = {};
  for (const [abbrev, t] of Object.entries(teamStats)) byName[norm(t.name)] = abbrev;
  const out = {};
  let sum = 0, n = 0;
  for (const t of data.data || []) {
    const abbrev = byName[norm(t.teamFullName)];
    if (!abbrev || !t.shotsAgainstPerGame) continue;
    out[abbrev] = t.shotsAgainstPerGame; sum += t.shotsAgainstPerGame; n++;
  }
  return { byTeam: out, leagueAvg: n ? sum / n : null };
}

// Run `fn` over items with at most `limit` in flight
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { results[idx] = await fn(items[idx]); } catch (e) { results[idx] = { error: e.message }; } }
  }));
  return results;
}

module.exports = { fetchSkaters, buildMatcher, fetchGameLog, fetchShotsAgainst, pool };
