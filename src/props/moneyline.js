// NHL moneyline: your game model's win % (from the 11 AM picks run, data/last-run.json) vs the no-vig
// consensus moneyline. The odds come from the same SportsGameOdds events the props run already downloads,
// so this costs no extra credits.
const nhl = require('../nhl');
const sgo = require('./sgo');
const { devig, probToAmerican } = require('./scoring');
const { FILTERS, ML } = require('./config');

const logo = abbrev => `https://assets.nhle.com/logos/nhl/svg/${abbrev}_dark.svg`;

// Moneyline odds per event: { eventId: { home: {...}, away: {...} } }
function parseMoneylines(events, games, now = Date.now()) {
  const out = [];
  for (const ev of events) {
    const start = Date.parse(ev.status?.startsAt);
    if (ev.status?.started || ev.status?.live || ev.status?.ended || !(start > now)) continue;
    const home = sgo.teamAbbrev(ev.teams?.home, games), away = sgo.teamAbbrev(ev.teams?.away, games);
    if (!home || !away) continue;
    const side = s => ev.odds?.[`points-${s}-game-ml-${s}`];
    const h = side('home'), a = side('away');
    if (!h || !a || h.bookOddsAvailable === false || a.bookOddsAvailable === false) continue;
    const books = o => Object.values(o.byBookmaker || {}).filter(b => b.available !== false).length;
    // No-vig: prefer the feed's fair odds, else remove the vig from the two book prices
    const fair = h.fairOdds != null && a.fairOdds != null && h.fairOddsAvailable !== false;
    const pHome = fair ? devig(h.fairOdds, a.fairOdds) : devig(h.bookOdds, a.bookOdds);
    out.push({ eventId: ev.eventID, startsAt: ev.status.startsAt, home, away,
      homeOdds: Number(h.bookOdds), awayOdds: Number(a.bookOdds), pHome, books: Math.min(books(h), books(a)) });
  }
  return out;
}

function build({ events, games, lastRun, today, now = Date.now() }) {
  const section = { sport: 'NHL_ML', mode: 'odds', warning: null, objects: 0, games: 0, props: [] };
  if (!lastRun || lastRun.date !== today) {
    section.warning = "Waiting for today's game picks (the 11 AM run) — moneylines fill in on the next props run";
    return section;
  }
  const lines = parseMoneylines(events, games, now);
  const byTeams = Object.fromEntries(lines.map(l => [`${l.away}@${l.home}`, l]));
  for (const g of lastRun.games || []) {
    const l = byTeams[`${g.away}@${g.home}`];
    if (!l) continue;
    section.games++;
    for (const [team, opp, home, modelProb, odds, implied] of [
      [g.home, g.away, true, g.winPctHome, l.homeOdds, l.pHome],
      [g.away, g.home, false, g.winPctAway, l.awayOdds, 1 - l.pHome],
    ]) {
      const edge = modelProb - implied;
      const failed = [];
      if (l.books < FILTERS.MIN_BOOKS) failed.push('books');
      if (edge < ML.MIN_EDGE) failed.push('edge');
      if (edge > FILTERS.MAX_EDGE) failed.push('too-good');
      if (odds < ML.MIN_ODDS || odds > ML.MAX_ODDS) failed.push('odds');
      section.props.push({
        eventId: l.eventId, gameId: g.gameId, startsAt: l.startsAt, gameDate: today,
        playerName: team, playerId: team, team, opp, home, logo: logo(team),
        market: 'moneyline', stat: 'win', line: null, side: 'win',
        bookOdds: odds, implied, books: l.books, modelProb, finalProb: modelProb, hitShrunk: null, edge,
        fairOdds: probToAmerican(modelProb), confidence: g.pick === team ? g.confidence : null, modelPick: g.pick === team,
        rates: {}, gp: null, consistent: false, topPick: failed.length === 0, failed,
      });
    }
  }
  section.props.sort((a, b) => (b.topPick - a.topPick) || (b.edge - a.edge));
  if (!section.props.length) section.warning = 'No moneyline odds for tonight’s games yet';
  return section;
}

// Grade logged moneyline picks from final scores
async function grade(tracker, today) {
  const pending = tracker.filter(p => p.sport === 'NHL_ML' && p.result == null && p.date < today);
  const byDate = {};
  for (const d of new Set(pending.map(p => p.date))) {
    try { byDate[d] = await nhl.fetchGamesOn(d); } catch { byDate[d] = null; }
  }
  let graded = 0;
  for (const p of pending) {
    const games = byDate[p.date];
    if (!games) continue;
    const g = games.find(x => x.id === p.gameId) || games.find(x => [x.awayTeam?.abbrev, x.homeTeam?.abbrev].includes(p.team));
    const daysAgo = (Date.parse(today) - Date.parse(p.date)) / 864e5;
    if (!g || ['PPD', 'CNCL'].includes(g.gameScheduleState)) { if (daysAgo >= 3) { p.result = 'void'; graded++; } continue; }
    if (!['OFF', 'FINAL'].includes(g.gameState)) continue;
    const mine = g.homeTeam.abbrev === p.team ? g.homeTeam : g.awayTeam, theirs = mine === g.homeTeam ? g.awayTeam : g.homeTeam;
    p.actual = `${mine.score}-${theirs.score}`;
    p.result = mine.score > theirs.score ? 'hit' : 'miss';
    graded++;
  }
  return graded;
}

module.exports = { build, grade, parseMoneylines };
