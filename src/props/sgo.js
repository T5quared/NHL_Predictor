// SportsGameOdds — tonight's player prop board with consensus odds.
// Free Amateur plan: 2,500 objects/month, and one game = one object no matter how many props.
// Docs: https://sportsgameodds.com/docs/endpoints/getEvents
const { fetchJson } = require('../nhl');
const { MARKETS } = require('./config');
const { devig } = require('./scoring');

const BASE = 'https://api.sportsgameodds.com/v2/events';

// SportsGameOdds short names that differ from NHL API abbreviations
const NHL_ALIASES = {
  LA: 'LAK', NJ: 'NJD', TB: 'TBL', SJ: 'SJS', MON: 'MTL', WAS: 'WSH', CLB: 'CBJ', CLS: 'CBJ',
  NAS: 'NSH', CAL: 'CGY', WIN: 'WPG', LV: 'VGK', VEG: 'VGK', UTAH: 'UTA', ARI: 'UTA', ANA: 'ANA',
};

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// Match an SGO team to an NHL abbrev using today's NHL schedule
function teamAbbrev(sgoTeam, nhlGames) {
  const short = String(sgoTeam?.names?.short || '').toUpperCase();
  const known = new Set(nhlGames.flatMap(g => [g.awayTeam?.abbrev, g.homeTeam?.abbrev]));
  if (known.has(short)) return short;
  if (known.has(NHL_ALIASES[short])) return NHL_ALIASES[short];
  const long = norm(sgoTeam?.names?.long);
  for (const g of nhlGames) for (const t of [g.awayTeam, g.homeTeam]) {
    if (long && norm(t?.commonName?.default) && long.includes(norm(t.commonName.default))) return t.abbrev;
  }
  return null;
}

async function fetchEvents({ apiKey, leagueID, startsAfter, startsBefore }) {
  const events = [];
  let cursor = null, pages = 0;
  do {
    const q = new URLSearchParams({ leagueID, oddsAvailable: 'true', startsAfter, startsBefore, limit: '50' });
    if (cursor) q.set('cursor', cursor);
    const res = await fetchWithKey(`${BASE}?${q}`, apiKey);
    events.push(...(res.data || []));
    cursor = res.nextCursor || null;
  } while (cursor && ++pages < 5);
  return events;
}

async function fetchWithKey(url, apiKey) {
  const res = await fetch(url, { headers: { 'x-api-key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`SportsGameOdds HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Turn SGO events into one row per player / market / side.
// resolveTeam(sgoTeam) -> the abbreviation our stats source uses (or null to skip the game).
function parseProps(events, sport, resolveTeam, now = Date.now()) {
  const markets = MARKETS[sport];
  const out = [];
  for (const ev of events) {
    // The feed keeps returning games after the start with live in-game odds — pregame props only
    const start = Date.parse(ev.status?.startsAt);
    if (ev.status?.started || ev.status?.live || ev.status?.ended || !(start > now)) continue;
    const home = resolveTeam(ev.teams?.home), away = resolveTeam(ev.teams?.away);
    if (!home || !away) continue;
    const sideOfTeam = { [ev.teams.home.teamID]: home, [ev.teams.away.teamID]: away };
    const odds = ev.odds || {};
    for (const o of Object.values(odds)) {
      if (o.periodID !== 'game') continue;
      const market = markets.find(m => m.match(o.statID));
      if (!market) continue;
      const yn = !!market.yn;
      if (yn ? (o.betTypeID !== 'yn' || !['yes', 'no'].includes(o.sideID)) : (o.betTypeID !== 'ou' || !['over', 'under'].includes(o.sideID))) continue;
      const player = ev.players?.[o.playerID || o.statEntityID];
      if (!player) continue;
      const line = yn ? 0.5 : Number(o.bookOverUnder ?? o.fairOverUnder);
      if (!Number.isFinite(line) || o.bookOddsAvailable === false) continue;
      const books = Object.values(o.byBookmaker || {}).filter(b => b.available !== false).length;
      if (!books) continue;                    // no book offering it right now = stale price, not a real bet
      // Opposite side, for removing the vig
      const flip = { over: 'under', under: 'over', yes: 'no', no: 'yes' }[o.sideID];
      const opp = odds[o.oddID.replace(/-(over|under|yes|no)$/, '-' + flip)];
      const sameLine = x => yn || Number(x) === line;
      let implied = null;
      if (o.fairOddsAvailable !== false && o.fairOdds != null && sameLine(o.fairOverUnder)) implied = devig(o.fairOdds, null);
      else if (opp && opp.bookOddsAvailable !== false && sameLine(opp.bookOverUnder)) implied = devig(o.bookOdds, opp.bookOdds);
      else implied = devig(o.bookOdds, null);
      const team = sideOfTeam[player.teamID] || null;
      out.push({
        eventId: ev.eventID, startsAt: ev.status?.startsAt || null,
        playerName: player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim(),
        team, opp: team === home ? away : team === away ? home : null, home: team ? team === home : null,
        market: market.key, marketLabel: market.label, stat: market.stat, line,
        side: yn ? (o.sideID === 'yes' ? 'over' : 'under') : o.sideID,
        bookOdds: o.bookOdds != null ? Number(o.bookOdds) : null, implied, books,
      });
    }
  }
  return out;
}

module.exports = { fetchEvents, parseProps, teamAbbrev, norm, NHL_ALIASES };
