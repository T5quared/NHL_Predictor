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

// Turn SGO events into one row per player / market / side
function parseProps(events, sport, nhlGames) {
  const markets = MARKETS[sport];
  const out = [];
  for (const ev of events) {
    const home = teamAbbrev(ev.teams?.home, nhlGames), away = teamAbbrev(ev.teams?.away, nhlGames);
    if (!home || !away) continue;
    const sideOfTeam = { [ev.teams.home.teamID]: home, [ev.teams.away.teamID]: away };
    const odds = ev.odds || {};
    for (const o of Object.values(odds)) {
      if (o.periodID !== 'game' || o.betTypeID !== 'ou' || !['over', 'under'].includes(o.sideID)) continue;
      const player = ev.players?.[o.playerID || o.statEntityID];
      if (!player) continue;
      const market = markets.find(m => m.match(o.statID));
      if (!market) continue;
      const line = Number(o.bookOverUnder ?? o.fairOverUnder);
      if (!Number.isFinite(line) || o.bookOddsAvailable === false) continue;
      // Opposite side, for removing the vig
      const oppID = o.oddID.replace(/-(over|under)$/, o.sideID === 'over' ? '-under' : '-over');
      const opp = odds[oppID];
      let implied = null;
      if (o.fairOddsAvailable !== false && o.fairOdds != null && Number(o.fairOverUnder) === line) implied = devig(o.fairOdds, null);
      else if (opp && Number(opp.bookOverUnder) === line) implied = devig(o.bookOdds, opp.bookOdds);
      else implied = devig(o.bookOdds, null);
      const team = sideOfTeam[player.teamID] || null;
      out.push({
        eventId: ev.eventID, startsAt: ev.status?.startsAt || null,
        playerName: player.name || `${player.firstName || ''} ${player.lastName || ''}`.trim(),
        team, opp: team === home ? away : team === away ? home : null, home: team ? team === home : null,
        market: market.key, marketLabel: market.label, stat: market.stat, line, side: o.sideID,
        bookOdds: o.bookOdds != null ? Number(o.bookOdds) : null, implied,
        books: Object.values(o.byBookmaker || {}).filter(b => b.available !== false).length,
      });
    }
  }
  return out;
}

module.exports = { fetchEvents, parseProps, teamAbbrev, norm, NHL_ALIASES };
