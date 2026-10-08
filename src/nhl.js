// NHL API fetchers. Same endpoints and field mapping as the dashboard, minus the proxy/cache.
const { W, priorShare } = require('./model');

const API_WEB = 'https://api-web.nhle.com/v1';
const API_STATS = 'https://api.nhle.com/stats/rest/en';
const TZ = 'America/New_York';

// ── Dates (all "today"/"yesterday" logic is in Eastern time) ─────────
const etDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function seasonFor(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = m >= 9 ? y : y - 1;
  return { startYear: start, season: `${start}${start + 1}`, prior: `${start - 1}${start}` };
}

async function fetchJson(url, { tries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'nhl-predictor (github actions)', Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url} -> ${lastErr.message}`);
}

const isRealGame = g => g.gameType === 2 || g.gameType === 3;

// ── Today's games ────────────────────────────────────────────────────
async function fetchGamesOn(dateStr) {
  const data = await fetchJson(`${API_WEB}/schedule/${dateStr}`);
  const day = (data.gameWeek || []).find(e => e.date === dateStr);
  return (day?.games || []).filter(isRealGame);
}

// ── Standings ────────────────────────────────────────────────────────
async function fetchTeamStats(season) {
  const data = await fetchJson(`${API_WEB}/standings/now`);
  const lookup = {};
  for (const t of data.standings || []) {
    const abbrev = t.teamAbbrev?.default || '';
    if (!abbrev) continue;
    const curGP = (t.seasonId != null && String(t.seasonId) !== season) ? 0 : (t.gamesPlayed || 0);
    const live = curGP > 0;
    lookup[abbrev] = {
      name: t.teamName?.default || '',
      gfPG: t.goalFor / (t.gamesPlayed || 1),
      gaPG: t.goalAgainst / (t.gamesPlayed || 1),
      gf: live ? (t.goalFor || 0) : 0,
      ga: live ? (t.goalAgainst || 0) : 0,
      gp: curGP,
      ppPct: (t.powerPlayPct || 0) / 100,
      pkPct: (t.penaltyKillPct || 0) / 100,
      pim: W.LEAGUE_AVG_PIM,
      recentGF: null,
    };
  }
  return lookup;
}

// ── Goalies (starter = most games started; SV% blended with last season early on) ──
async function fetchGoalies(season, prior) {
  const [cur, pri] = await Promise.all([
    fetchJson(`${API_STATS}/goalie/summary?cayenneExp=seasonId=${season}&sort=gamesStarted&dir=DESC&limit=100`).catch(() => null),
    fetchJson(`${API_STATS}/goalie/summary?cayenneExp=seasonId=${prior}%20and%20gameTypeId=2&sort=gamesStarted&dir=DESC&limit=100`).catch(() => null),
  ]);
  if (!cur && !pri) throw new Error('goalie stats unavailable');
  const lookup = {};
  const nameStr = val => (val && typeof val === 'object') ? (val.default || '') : (val || '');
  const teamOf = g => {
    const raw = nameStr(g.teamAbbrevs) || g.teamAbbrevs || '';
    return raw.includes(',') ? raw.split(',').pop().trim() : raw.trim();
  };
  const fullName = g => {
    const first = nameStr(g.firstName) || nameStr(g.goalieFullName || g.skaterFullName || '').split(' ')[0] || '';
    const last  = nameStr(g.lastName)  || nameStr(g.goalieFullName || g.skaterFullName || '').split(' ').slice(1).join(' ') || '';
    return `${first} ${last}`.trim() || 'Unknown Goalie';
  };
  const MIN_PRIOR_STARTS = 10;
  const priorById = {}, priorStarter = {};
  (pri?.data || []).forEach(g => {
    const gs = g.gamesStarted || 0;
    if (g.playerId != null) priorById[g.playerId] = { savePct: g.savePct, gs };
    const abbrev = teamOf(g);
    if (abbrev && (!priorStarter[abbrev] || gs > priorStarter[abbrev].gs)) priorStarter[abbrev] = { g, gs };
  });
  const priorSv = g => {
    const p = priorById[g.playerId];
    return (p && p.gs >= MIN_PRIOR_STARTS && p.savePct) ? p.savePct : W.LEAGUE_AVG_SAVE_PCT;
  };
  (cur?.data || []).forEach(g => {
    const abbrev = teamOf(g);
    if (!abbrev) return;
    if (!lookup[abbrev] || (g.gamesStarted || 0) > (lookup[abbrev]?.gs || 0)) {
      const gs = g.gamesStarted || 0;
      const rawSv = g.savePct || W.LEAGUE_AVG_SAVE_PCT;
      const w = priorShare(gs, W.PRIOR_GOALIE_FADE_STARTS);
      lookup[abbrev] = { name: fullName(g), savePct: w * priorSv(g) + (1 - w) * rawSv, rawSavePct: rawSv, priorWt: w, gs };
    }
  });
  if (W.PRIOR_GOALIE_FADE_STARTS > 0) {
    Object.entries(priorStarter).forEach(([abbrev, { g }]) => {
      if (lookup[abbrev]) return;
      lookup[abbrev] = { name: fullName(g), savePct: priorSv(g), rawSavePct: null, priorWt: 1, gs: 0 };
    });
  }
  return lookup;
}

// ── Completed games for the 45 days before `today` (newest first) ────
// One schedule call returns a full week, so this is 7 calls rather than 45.
async function fetchRecentGames(today, days = 45) {
  const first = addDays(today, -days), last = addDays(today, -1);
  const byId = new Map();
  for (let start = first; start <= last; start = addDays(start, 7)) {
    let data;
    try { data = await fetchJson(`${API_WEB}/schedule/${start}`); } catch { continue; }
    for (const day of data.gameWeek || []) {
      if (day.date < first || day.date > last) continue;
      for (const g of day.games || []) {
        if (!isRealGame(g) || g.homeTeam?.score == null || g.awayTeam?.score == null) continue;
        byId.set(g.id, { ...g, date: day.date });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// L10 goals-for per game, from completed (state OFF) games — same rule as the dashboard.
function recentFormFrom(games) {
  const goals = {};
  for (const g of games) {
    if (g.gameState !== 'OFF') continue;
    for (const side of [g.awayTeam, g.homeTeam]) {
      const a = side?.abbrev;
      if (!a) continue;
      (goals[a] ||= []);
      if (goals[a].length < 10) goals[a].push(side.score);
    }
  }
  const out = {};
  for (const [a, arr] of Object.entries(goals)) {
    if (arr.length) out[a] = { gfPG: arr.reduce((s, x) => s + x, 0) / arr.length, n: arr.length };
  }
  return out;
}

// Teams that played yesterday.
function teamsPlayedOn(games, dateStr) {
  const s = new Set();
  for (const g of games) {
    if (g.date !== dateStr) continue;
    if (g.awayTeam?.abbrev) s.add(g.awayTeam.abbrev);
    if (g.homeTeam?.abbrev) s.add(g.homeTeam.abbrev);
  }
  return s;
}

module.exports = {
  API_WEB, API_STATS, TZ, etDate, addDays, seasonFor, fetchJson,
  fetchGamesOn, fetchTeamStats, fetchGoalies, fetchRecentGames, recentFormFrom, teamsPlayedOn,
};
