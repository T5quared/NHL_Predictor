// NFL props: SportsGameOdds prop board (next 7 days) + nflverse weekly player stats (free CSVs on GitHub).
// Yardage props use a normal distribution; receptions and anytime TD use Poisson.
const sgo = require('./sgo');
const { buildMatcher } = require('./nhlPlayers');
const { hitRates, scoreProp, rankProps, poissonSideProb, normalSideProb } = require('./scoring');
const { MARKETS, NFL_RATE } = require('./config');

// nflverse has moved these files between release tags before, so try each known location in turn
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const STATS_URLS = season => [
  `${REL}/stats_player/stats_player_week_${season}.csv`,
  `${REL}/player_stats/stats_player_week_${season}.csv`,
  `${REL}/player_stats/player_stats_${season}.csv`,
  `${REL}/stats_player/stats_player_week_${season}.csv.gz`,
  `${REL}/player_stats/stats_player_week_${season}.csv.gz`,
];
const SCHEDULE_URLS = [
  'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  `${REL}/schedules/games.csv`,
];
const TEAMS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv';
const NFL_MARKETS = Object.fromEntries(MARKETS.NFL.map(m => [m.key, m]));
// SportsGameOdds short names that differ from nflverse abbreviations
const ALIASES = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX', ARZ: 'ARI', LVR: 'LV', OAK: 'LV', SD: 'LAC', STL: 'LA', KCC: 'KC', GNB: 'GB', NWE: 'NE', NOR: 'NO', SFO: 'SF', TAM: 'TB' };

// ── CSV ──────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
async function fetchCsv(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'nhl-predictor (github actions)' }, redirect: 'follow', signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/download/')[1] || url}`);
  let text;
  if (url.endsWith('.gz')) text = require('zlib').gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  else text = await res.text();
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`empty file: ${url}`);
  return rows;
}
async function fetchFirst(urls) {
  const errs = [];
  for (const url of urls) {
    try { const rows = await fetchCsv(url); console.log(`[NFL] loaded ${url} (${rows.length} rows)`); return rows; }
    catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.join(' · '));
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ── Data ─────────────────────────────────────────────────────────────
const nflSeasonFor = date => { const [y, m] = date.split('-').map(Number); return m >= 3 ? y : y - 1; };

async function loadStats(season) {
  const rows = normalizeStats(await fetchFirst(STATS_URLS(season)));
  if (!rows.length) throw new Error(`stats file for ${season} had no usable rows (columns changed?)`);
  return rows;
}
function normalizeStats(rows) {
  return rows.map(r => ({
    id: r.player_id, name: r.player_display_name || r.player_name, pos: r.position_group || r.position,
    team: r.team || r.recent_team, opp: r.opponent_team, season: num(r.season), week: num(r.week), type: r.season_type,
    passing_yards: num(r.passing_yards), rushing_yards: num(r.rushing_yards), receiving_yards: num(r.receiving_yards),
    receptions: num(r.receptions), td: num(r.rushing_tds) + num(r.receiving_tds) + num(r.special_teams_tds),
  })).filter(r => r.id && r.week);
}

// Per player: games newest first, plus position and latest team
function indexPlayers(stats) {
  const by = new Map();
  for (const r of stats) {
    if (!by.has(r.id)) by.set(r.id, { id: r.id, name: r.name, pos: r.pos, games: [] });
    by.get(r.id).games.push(r);
  }
  for (const p of by.values()) {
    p.games.sort((a, b) => b.season - a.season || b.week - a.week);
    p.team = p.games[0].team; p.pos = p.games[0].pos || p.pos;
  }
  return by;
}

// Opponent allowed per game to a position group, vs league average → multiplier
function defenseFactors(stats) {
  const per = {};   // `${opp}|${pos}|${stat}` -> {sum, games:Set}
  const STATS = ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'td'];
  for (const r of stats) {
    if (!r.opp || !r.pos) continue;
    for (const s of STATS) {
      const k = `${r.opp}|${r.pos}|${s}`;
      (per[k] ||= { sum: 0, games: new Set() });
      per[k].sum += r[s]; per[k].games.add(`${r.season}-${r.week}`);
    }
  }
  const avg = {}, league = {};
  for (const [k, v] of Object.entries(per)) {
    avg[k] = v.sum / v.games.size;
    const lk = k.split('|').slice(1).join('|');
    (league[lk] ||= []).push(avg[k]);
  }
  const leagueAvg = Object.fromEntries(Object.entries(league).map(([k, arr]) => [k, arr.reduce((s, x) => s + x, 0) / arr.length]));
  return (opp, pos, stat) => {
    const a = avg[`${opp}|${pos}|${stat}`], l = leagueAvg[`${pos}|${stat}`];
    if (!(a >= 0) || !(l > 0)) return 1;
    const [lo, hi] = stat === 'td' ? [NFL_RATE.TD_DEFENSE_MIN, NFL_RATE.TD_DEFENSE_MAX] : [NFL_RATE.DEFENSE_MIN, NFL_RATE.DEFENSE_MAX];
    return Math.min(hi, Math.max(lo, a / l));
  };
}

// ── Model ────────────────────────────────────────────────────────────
function playerModel({ values, priorValues, stat, pos, factor, dist, line, side }) {
  const n = values.length, K = NFL_RATE.PRIOR_GAMES;
  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const posDefault = (NFL_RATE.POSITION_DEFAULTS[pos] || NFL_RATE.POSITION_DEFAULTS.WR)[stat] ?? 0;
  const priorMean = priorValues.length >= 6 ? avg(priorValues) : posDefault;
  const base = ((n ? avg(values) * n : 0) + K * priorMean) / (n + K);
  let mean = base;
  if (n >= 4) mean = (1 - NFL_RATE.RECENT_WEIGHT) * base + NFL_RATE.RECENT_WEIGHT * avg(values.slice(0, 3));
  mean = Math.max(0.01, mean * factor);
  if (dist === 'poisson') return { mean, sd: Math.sqrt(mean), prob: poissonSideProb(mean, line, side) };
  const m0 = n ? avg(values) : mean;
  const ownVar = n >= 3 ? values.reduce((s, v) => s + (v - m0) ** 2, 0) / (n - 1) : 0;
  const typical = (NFL_RATE.YARDS_CV[stat] || 0.5) * mean;
  const dof = Math.max(n - 1, 0);
  const sd = Math.max(5, Math.sqrt((dof * ownVar + K * typical ** 2) / (dof + K)));
  return { mean, sd, prob: normalSideProb(mean, sd, line, side) };
}

// ── Teams / schedule ─────────────────────────────────────────────────
function teamResolver(teams, current) {
  const norm = sgo.norm;
  const byName = {}, byNick = {};
  for (const t of teams) if (current.has(t.team_abbr)) { byName[norm(t.team_name)] = t.team_abbr; byNick[norm(t.team_nick)] = t.team_abbr; }
  return sgoTeam => {
    const short = String(sgoTeam?.names?.short || '').toUpperCase();
    if (current.has(short)) return short;
    if (current.has(ALIASES[short])) return ALIASES[short];
    return byName[norm(sgoTeam?.names?.long)] || byNick[norm(sgoTeam?.names?.medium)] || null;
  };
}
const etDate = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ── Grading ──────────────────────────────────────────────────────────
function grade(tracker, stats, now) {
  const pending = tracker.filter(p => p.sport === 'NFL' && p.result == null && p.startsAt && Date.parse(p.startsAt) < now - 4 * 3600e3);
  const weeksIn = new Set(stats.map(r => `${r.season}-${r.week}`));
  let graded = 0;
  for (const p of pending) {
    const row = stats.find(r => r.id === p.playerId && r.season === p.season && r.week === p.week);
    const daysAgo = (now - Date.parse(p.startsAt)) / 864e5;
    if (!row) {
      if ((weeksIn.has(`${p.season}-${p.week}`) && daysAgo > 2) || daysAgo > 10) { p.result = 'void'; graded++; }  // inactive / no stats
      continue;
    }
    p.actual = row[p.stat];
    p.result = p.actual === p.line ? 'push' : (p.side === 'over' ? p.actual > p.line : p.actual < p.line) ? 'hit' : 'miss';
    graded++;
  }
  return graded;
}

// ── Main ─────────────────────────────────────────────────────────────
async function run({ today, tracker, sgoKey, now = Date.now() }) {
  const season = nflSeasonFor(today);
  let statsError = null;
  const [stats, priorStats, schedule, teams] = await Promise.all([
    loadStats(season).catch(e => { statsError = e.message; console.error('[NFL] stats:', e.message); return []; }),
    loadStats(season - 1).catch(e => { console.error('[NFL] last season stats:', e.message); return []; }),
    fetchFirst(SCHEDULE_URLS).catch(e => { console.error('[NFL] schedule:', e.message); return []; }),
    fetchCsv(TEAMS_URL).catch(() => []),
  ]);
  console.log(`[NFL] graded ${grade(tracker, stats, now)} earlier pick(s)`);

  const empty = (warning = null, mode = 'none') => ({ sport: 'NFL', mode, warning, objects: 0, games: 0, props: [] });
  if (!sgoKey) return empty('NFL props need the SportsGameOdds key (lines are player-specific)', 'no-key');
  if (!stats.length) return empty(`nflverse player stats unavailable: ${statsError || 'no rows'}`);

  const curGames = schedule.filter(g => num(g.season) === season);
  const current = new Set(curGames.flatMap(g => [g.away_team, g.home_team]));
  const resolve = teamResolver(teams, current);
  const logoOf = Object.fromEntries(teams.map(t => [t.team_abbr, t.team_logo_espn]));

  let events;
  try {
    events = await sgo.fetchEvents({ apiKey: sgoKey, leagueID: 'NFL', startsAfter: new Date(now).toISOString(), startsBefore: new Date(now + 7 * 864e5).toISOString() });
  } catch (e) { return empty(`Odds feed failed (${e.message})`); }
  let rows = sgo.parseProps(events, 'NFL', resolve);

  // Week number for each game (for grading)
  const weekOf = {};
  for (const ev of events) {
    const h = resolve(ev.teams?.home), a = resolve(ev.teams?.away);
    const g = curGames.find(x => x.home_team === h && x.away_team === a && x.gameday === etDate(ev.status?.startsAt))
      || curGames.find(x => x.home_team === h && x.away_team === a && !x.home_score);
    if (g) weekOf[ev.eventID] = num(g.week);
  }

  const cur = indexPlayers(stats), prior = indexPlayers(priorStats);
  const match = buildMatcher([...cur.values()].map(p => ({ id: p.id, name: p.name, team: p.team })));
  const defense = defenseFactors(stats);
  let unmatched = 0;
  const scored = [];
  for (const r of rows) {
    const m = match(r.playerName, r.team);
    if (!m) { unmatched++; continue; }
    const pl = cur.get(m.id), market = NFL_MARKETS[r.market];
    const values = pl.games.map(g => g[r.stat]);
    const priorValues = (prior.get(m.id)?.games || []).map(g => g[r.stat]);
    const factor = defense(r.opp, pl.pos, r.stat);
    const model = playerModel({ values, priorValues, stat: r.stat, pos: pl.pos, factor, dist: market.dist, line: r.line, side: r.side });
    const rates = hitRates(values, r.line, r.side, 'NFL');
    const s = scoreProp({ modelProb: model.prob, rates, implied: r.implied, bookOdds: r.bookOdds, gamesPlayed: values.length, books: r.books, sport: 'NFL', projection: model.mean, line: r.line });
    scored.push({ ...r, playerId: m.id, pos: pl.pos, gp: values.length, logo: logoOf[r.team] || null,
      season, week: weekOf[r.eventId] ?? null, gameDate: r.startsAt ? etDate(r.startsAt) : null,
      projection: +model.mean.toFixed(1), modelProb: model.prob, rates, ...s });
  }
  if (unmatched) console.log(`[NFL] skipped ${unmatched} prop row(s) with no player match`);
  return { sport: 'NFL', mode: 'odds', warning: null, objects: events.length, games: events.length, props: rankProps(scored) };
}

module.exports = { run, parseCsv, normalizeStats, playerModel, defenseFactors, teamResolver, grade, nflSeasonFor };
