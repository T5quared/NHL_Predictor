// ════════════════════════════════════════════════════════════════════
//  AUTOMATIC INJURY TOGGLE
//  Replaces the daily "ask Claude who's hurt" step. A team's injury toggle
//  is switched on when a player listed as out is one of its:
//    - top 6 forwards by ice time
//    - top 4 defensemen by ice time
//    - starting goalie (the goalie the model is using for that team)
//
//  Injury list: ESPN's public NHL injuries feed (unofficial; the NHL has none).
//  Ice time:    NHL stats API, this season blended with last season so a
//               player who has been out since camp is still ranked.
// ════════════════════════════════════════════════════════════════════
const { API_WEB, API_STATS, fetchJson } = require('./nhl');

const INJURY_RULES = {
  TOP_FORWARDS: 6,
  TOP_DEFENSE: 4,
  // Statuses that count as "not playing". Day-To-Day is left out on purpose.
  OUT_STATUSES: ['out', 'injured reserve', 'long-term injured reserve', 'suspension'],
  // Last season's ice time counts as at most this many games when blending with this season.
  PRIOR_TOI_GAMES: 20,
  // Feed older than this many hours gets a warning in the Discord post.
  STALE_HOURS: 48,
};

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';
// ESPN abbreviations that differ from the NHL's
const ESPN_TO_NHL = { TB: 'TBL', NJ: 'NJD', SJ: 'SJS', LA: 'LAK', UTAH: 'UTA', UTH: 'UTA', MON: 'MTL', WAS: 'WSH', VEG: 'VGK', CLB: 'CBJ', NAS: 'NSH', WIN: 'WPG', CAL: 'CGY', FLO: 'FLA' };

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
// "a j greer" / "aj greer" / "alexander ovechkin" vs "alex ovechkin" -> compare last name + first initial as a fallback
const looseKey = s => { const p = norm(s).split(' '); return p.length ? `${p[0][0] || ''}|${p.slice(1).join('') || p[0]}` : ''; };
const sameName = (a, b) => norm(a).replace(/ /g, '') === norm(b).replace(/ /g, '') || looseKey(a) === looseKey(b);

// ── ESPN feed -> { NHL abbrev: [ {name, pos, status, type, returnDate} ] } ──
async function fetchInjuryFeed(teamNameToAbbrev) {
  const data = await fetchJson(ESPN_URL);
  const byTeam = {};
  for (const team of data.injuries || []) {
    for (const inj of team.injuries || []) {
      const espnAbbr = inj.athlete?.team?.abbreviation || '';
      const abbrev = teamNameToAbbrev[norm(team.displayName)] || teamNameToAbbrev[norm(inj.athlete?.team?.displayName)]
        || ESPN_TO_NHL[espnAbbr.toUpperCase()] || espnAbbr.toUpperCase();
      if (!abbrev) continue;
      (byTeam[abbrev] ||= []).push({
        name: inj.athlete?.displayName || '',
        pos: inj.athlete?.position?.abbreviation || '',
        status: inj.status || '',
        type: inj.details?.type || '',
        returnDate: inj.details?.returnDate || null,
      });
    }
  }
  const ageHours = data.timestamp ? (Date.now() - Date.parse(data.timestamp)) / 36e5 : null;
  return { byTeam, timestamp: data.timestamp || null, ageHours };
}

// ── League-wide skater ice time for one season: playerId -> row ──────
async function fetchSkaterToi(season) {
  const rows = [];
  for (let start = 0; start < 3000; ) {
    const data = await fetchJson(`${API_STATS}/skater/summary?limit=100&start=${start}&cayenneExp=seasonId=${season}%20and%20gameTypeId=2`);
    const page = data.data || [];
    rows.push(...page);
    start += page.length;
    if (!page.length || (data.total != null && start >= data.total)) break;
  }
  const byId = new Map();
  for (const r of rows) {
    const teams = String(r.teamAbbrevs || '');
    byId.set(r.playerId, {
      id: r.playerId, name: r.skaterFullName, pos: r.positionCode === 'D' ? 'D' : 'F',
      gp: r.gamesPlayed || 0, toi: r.timeOnIcePerGame || 0,
      team: teams.includes(',') ? teams.split(',').pop().trim() : teams.trim(),
    });
  }
  return byId;
}

async function fetchRoster(abbrev) {
  const data = await fetchJson(`${API_WEB}/roster/${abbrev}/current`);
  const one = (p, pos) => ({ id: p.id, name: `${p.firstName?.default || ''} ${p.lastName?.default || ''}`.trim(), pos });
  return [
    ...(data.forwards || []).map(p => one(p, 'F')),
    ...(data.defensemen || []).map(p => one(p, 'D')),
    ...(data.goalies || []).map(p => one(p, 'G')),
  ];
}

// Expected ice time per game: this season's games plus up to PRIOR_TOI_GAMES of last season's.
function blendedToi(cur, prior) {
  const cg = cur?.gp || 0;
  const pg = Math.min(prior?.gp || 0, INJURY_RULES.PRIOR_TOI_GAMES);
  if (cg + pg === 0) return 0;
  return (cg * (cur?.toi || 0) + pg * (prior?.toi || 0)) / (cg + pg);
}

// Decide one team. Pure function (no network) so it can be tested.
//   injured  — that team's entries from the feed
//   roster   — [{id, name, pos}] current roster
//   curToi / priorToi — Map(playerId -> {name, pos, gp, toi, team})
//   starterName — the goalie the model is using for this team
function evaluateTeam(abbrev, injured, roster, curToi, priorToi, starterName) {
  const out = (injured || []).filter(i => INJURY_RULES.OUT_STATUSES.includes(norm(i.status)));
  if (!out.length) return { active: false, players: [], outCount: 0 };

  // Ranking pool = current roster + any injured player who is off the roster (e.g. long-term IR)
  const pool = roster.filter(p => p.pos !== 'G').map(p => ({ ...p }));
  const findStat = (name, map) => { for (const r of map.values()) if (r.team === abbrev && sameName(r.name, name)) return r; return null; };
  for (const i of out) {
    if (i.pos === 'G' || roster.some(p => sameName(p.name, i.name))) continue;
    const r = findStat(i.name, curToi) || findStat(i.name, priorToi);
    if (r) pool.push({ id: r.id, name: r.name, pos: r.pos });
  }
  for (const p of pool) p.toi = blendedToi(curToi.get(p.id), priorToi.get(p.id));

  const rank = pos => pool.filter(p => p.pos === pos).sort((a, b) => b.toi - a.toi);
  const fwd = rank('F'), def = rank('D');

  const players = [];
  for (const i of out) {
    if (i.pos === 'G') {
      if (starterName && sameName(i.name, starterName)) players.push({ name: i.name, role: 'starting G', status: i.status });
      continue;
    }
    const fi = fwd.findIndex(p => sameName(p.name, i.name));
    const di = def.findIndex(p => sameName(p.name, i.name));
    if (fi >= 0 && fi < INJURY_RULES.TOP_FORWARDS && fwd[fi].toi > 0) players.push({ name: i.name, role: `F${fi + 1}`, status: i.status });
    else if (di >= 0 && di < INJURY_RULES.TOP_DEFENSE && def[di].toi > 0) players.push({ name: i.name, role: `D${di + 1}`, status: i.status });
  }
  return { active: players.length > 0, players, outCount: out.length };
}

// Everything for today's slate. Never throws: if the feed is down, no toggles are applied.
async function autoInjuries(teams, { season, prior, teamStats, goalies }) {
  const result = { byTeam: {}, warning: null, feedTimestamp: null };
  try {
    const nameToAbbrev = {};
    for (const [abbrev, t] of Object.entries(teamStats)) if (t.name) nameToAbbrev[norm(t.name)] = abbrev;
    const feed = await fetchInjuryFeed(nameToAbbrev);
    result.feedTimestamp = feed.timestamp;
    if (feed.ageHours != null && feed.ageHours > INJURY_RULES.STALE_HOURS)
      result.warning = `injury feed last updated ${Math.round(feed.ageHours / 24)} days ago`;

    const [curToi, priorToi] = await Promise.all([fetchSkaterToi(season), fetchSkaterToi(prior)]);
    for (const abbrev of teams) {
      try {
        const roster = await fetchRoster(abbrev);
        result.byTeam[abbrev] = evaluateTeam(abbrev, feed.byTeam[abbrev], roster, curToi, priorToi, goalies[abbrev]?.name);
      } catch (e) {
        result.byTeam[abbrev] = { active: false, players: [], outCount: 0, error: e.message };
      }
    }
  } catch (e) {
    result.warning = `injury feed unavailable — no injury toggles applied (${e.message})`;
  }
  return result;
}

module.exports = { INJURY_RULES, autoInjuries, evaluateTeam, blendedToi, sameName, norm };
