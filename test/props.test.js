// Props maths and odds parsing. Run: node --test
const test = require('node:test');
const assert = require('node:assert');
const sc = require('../src/props/scoring');
const { parseProps, teamAbbrev } = require('../src/props/sgo');
const { playerRate } = require('../src/props/rate');
const { buildMatcher } = require('../src/props/nhlPlayers');

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('odds conversions', () => {
  near(sc.americanToProb(-174), 0.635, 1e-3);
  near(sc.americanToProb(150), 0.4);
  assert.equal(sc.probToAmerican(0.7), -233);
  near(sc.devig(-110, -110), 0.5);
});

test('poisson side probabilities add to 1 on half lines', () => {
  for (const l of [0.5, 1.5, 2.5]) near(sc.poissonSideProb(1.3, l, 'over') + sc.poissonSideProb(1.3, l, 'under'), 1, 1e-9);
  near(sc.poissonSideProb(1, 0.5, 'over'), 1 - Math.exp(-1), 1e-9);
});

test('hit windows: newest first, pushes skipped', () => {
  const v = [1, 0, 2, 1, 1, 0, 3];
  const r = sc.hitRates(v, 0.5, 'over');
  assert.deepEqual([r.l5.hits, r.l5.n], [4, 5]);
  assert.deepEqual([r.season.hits, r.season.n], [5, 7]);
  const push = sc.hitWindow([2, 2, 3], 2, 'over', null);
  assert.deepEqual([push.hits, push.n], [1, 1]);
});

test('small samples are pulled toward the market price', () => {
  const tiny = sc.hitRates([1], 0.5, 'over');               // 1/1 = 100%
  const b = sc.blendedHitRate(tiny, 0.55);
  assert.equal(b.raw, 1);
  near(b.shrunk, (1 * 1 + 0.55 * 8) / 9);                    // ~60%, not 100%
});

test('worked example ranks as a top pick with the consistent badge', () => {
  // Hughes-style: 9/10 L10, 19/22 season, -174 (≈61% no-vig)
  const log = [1,1,1,1,1,1,1,1,0,1, 1,1,0,1,1,1,1,1,1,0, 1,1];
  const rates = sc.hitRates(log, 0.5, 'over');
  const s = sc.scoreProp({ modelProb: 0.68, rates, implied: 0.61, bookOdds: -174, gamesPlayed: log.length });
  assert.ok(s.topPick, 'should pass filters: ' + s.failed);
  assert.ok(s.consistent);
  assert.ok(s.edge > 0.08 && s.edge < 0.16, 'edge ' + s.edge);
});

test('filters reject short samples and long prices', () => {
  const rates = sc.hitRates([1, 1, 1], 0.5, 'over');
  const s = sc.scoreProp({ modelProb: 0.9, rates, implied: 0.75, bookOdds: -300, gamesPlayed: 3 });
  assert.ok(!s.topPick);
  assert.ok(s.failed.includes('games') && s.failed.includes('odds'));
});

test('player rate blends season, last season and L10', () => {
  const log = Array.from({ length: 10 }, () => ({ points: 1 }));
  const r = playerRate({ log, stat: 'points', pos: 'F', prior: { gp: 82, points: 41 } });
  // base = (10 + 10*0.5)/20 = 0.75, recent = 1 → 0.7*0.75 + 0.3*1 = 0.825
  near(r, 0.825);
});

test('SportsGameOdds events parse into props, with team aliases and devig', () => {
  const games = [{ awayTeam: { abbrev: 'LAK', commonName: { default: 'Kings' } }, homeTeam: { abbrev: 'BOS', commonName: { default: 'Bruins' } } }];
  const ev = {
    eventID: 'E1', status: { startsAt: '2026-11-19T00:00:00Z' },
    teams: { home: { teamID: 'BOSTON_BRUINS_NHL', names: { short: 'BOS', long: 'Boston Bruins' } },
             away: { teamID: 'LOS_ANGELES_KINGS_NHL', names: { short: 'LA', long: 'Los Angeles Kings' } } },
    players: { KEVIN_FIALA_1_NHL: { playerID: 'KEVIN_FIALA_1_NHL', teamID: 'LOS_ANGELES_KINGS_NHL', name: 'Kevin Fiala' } },
    odds: {
      'shots_onGoal-KEVIN_FIALA_1_NHL-game-ou-under': { oddID: 'shots_onGoal-KEVIN_FIALA_1_NHL-game-ou-under', statID: 'shots_onGoal', statEntityID: 'KEVIN_FIALA_1_NHL', playerID: 'KEVIN_FIALA_1_NHL', periodID: 'game', betTypeID: 'ou', sideID: 'under', bookOdds: '-125', bookOverUnder: '2.5', fairOddsAvailable: false, byBookmaker: { a: {}, b: {} } },
      'shots_onGoal-KEVIN_FIALA_1_NHL-game-ou-over':  { oddID: 'shots_onGoal-KEVIN_FIALA_1_NHL-game-ou-over',  statID: 'shots_onGoal', statEntityID: 'KEVIN_FIALA_1_NHL', playerID: 'KEVIN_FIALA_1_NHL', periodID: 'game', betTypeID: 'ou', sideID: 'over',  bookOdds: '-105', bookOverUnder: '2.5', fairOddsAvailable: false, byBookmaker: { a: {}, c: {} } },
      'points-KEVIN_FIALA_1_NHL-game-ou-over': { oddID: 'points-KEVIN_FIALA_1_NHL-game-ou-over', statID: 'points', statEntityID: 'KEVIN_FIALA_1_NHL', playerID: 'KEVIN_FIALA_1_NHL', periodID: 'game', betTypeID: 'ou', sideID: 'over', bookOdds: '-155', bookOverUnder: '5.5', byBookmaker: { a: { available: false } } },
      'points-home-game-ml-home': { oddID: 'points-home-game-ml-home', statID: 'points', statEntityID: 'home', periodID: 'game', betTypeID: 'ml', sideID: 'home', bookOdds: '-150' },
    },
  };
  assert.equal(teamAbbrev(ev.teams.away, games), 'LAK');
  const rows = parseProps([ev], 'NHL', t => teamAbbrev(t, games), 0);
  assert.equal(rows.length, 2);                              // stale line with no open book is dropped
  const u = rows.find(r => r.side === 'under');
  assert.equal(u.team, 'LAK'); assert.equal(u.opp, 'BOS'); assert.equal(u.market, 'shots'); assert.equal(u.line, 2.5);
  near(u.implied + rows.find(r => r.side === 'over').implied, 1, 1e-9);
  assert.equal(u.books, 2);
});

test('player name matching handles accents and initials', () => {
  const m = buildMatcher([
    { id: 1, name: 'Tim Stützle', team: 'OTT' }, { id: 2, name: 'J.T. Miller', team: 'NYR' }, { id: 3, name: 'Sebastian Aho', team: 'CAR' }, { id: 4, name: 'Sebastian Aho', team: 'NYI' },
  ]);
  assert.equal(m('Tim Stutzle', 'OTT').id, 1);
  assert.equal(m('JT Miller', 'NYR').id, 2);
  assert.equal(m('Sebastian Aho', 'NYI').id, 4);
});

// ── NFL ──────────────────────────────────────────────────────────────
const nfl = require('../src/props/nfl');
const { logPicks } = require('../src/props/run-props');

test('NFL: csv parser handles quotes and old/new column names', () => {
  const rows = nfl.normalizeStats(nfl.parseCsv('player_id,player_display_name,position_group,recent_team,opponent_team,season,week,season_type,receiving_yards,receptions,rushing_tds,receiving_tds\n'
    + '00-1,"Ja\'Marr Chase, Jr.",WR,CIN,BAL,2026,3,REG,112,9,0,2\r\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ja'Marr Chase, Jr."); assert.equal(rows[0].team, 'CIN'); assert.equal(rows[0].td, 2); assert.equal(rows[0].receptions, 9);
});

test('NFL: yardage model centres on the shrunk average and respects the line', () => {
  const values = [80, 95, 70, 110, 60, 90, 85, 75];
  const over = nfl.playerModel({ values, priorValues: Array(12).fill(80), stat: 'receiving_yards', pos: 'WR', factor: 1, dist: 'normal', line: 64.5, side: 'over' });
  assert.ok(over.mean > 78 && over.mean < 90, 'mean ' + over.mean);
  assert.ok(over.prob > 0.7 && over.prob < 0.95, 'prob ' + over.prob);
  const under = nfl.playerModel({ values, priorValues: Array(12).fill(80), stat: 'receiving_yards', pos: 'WR', factor: 1, dist: 'normal', line: 64.5, side: 'under' });
  near(over.prob + under.prob, 1, 1e-9);
  const td = nfl.playerModel({ values: [1, 0, 0, 1, 0, 0], priorValues: [], stat: 'td', pos: 'RB', factor: 1, dist: 'poisson', line: 0.5, side: 'over' });
  assert.ok(td.prob > 0.25 && td.prob < 0.45, 'td ' + td.prob);
});

test('NFL: anytime TD yes/no parses as over/under 0.5 and devigs', () => {
  const ev = { eventID: 'N1', status: { startsAt: '2026-11-22T18:00:00Z' },
    teams: { home: { teamID: 'KC', names: { short: 'KC' } }, away: { teamID: 'LAR', names: { short: 'LAR' } } },
    players: { P: { playerID: 'P', teamID: 'KC', name: 'Isiah Pacheco' } },
    odds: {
      'touchdowns-P-game-yn-yes': { oddID: 'touchdowns-P-game-yn-yes', statID: 'touchdowns', playerID: 'P', periodID: 'game', betTypeID: 'yn', sideID: 'yes', bookOdds: '+110', byBookmaker: { a: {}, b: {} } },
      'touchdowns-P-game-yn-no':  { oddID: 'touchdowns-P-game-yn-no',  statID: 'touchdowns', playerID: 'P', periodID: 'game', betTypeID: 'yn', sideID: 'no',  bookOdds: '-150', byBookmaker: { a: {} } },
    } };
  const resolve = nfl.teamResolver([], new Set(['KC', 'LA']));
  const rows = parseProps([ev], 'NFL', resolve, 0);
  const yes = rows.find(r => r.side === 'over');
  assert.equal(rows.length, 2); assert.equal(yes.market, 'anytime_td'); assert.equal(yes.line, 0.5); assert.equal(yes.opp, 'LA');
  near(yes.implied + rows.find(r => r.side === 'under').implied, 1, 1e-9);
});

test('NFL: the last run before kickoff replaces earlier ungraded picks', () => {
  const now = Date.parse('2026-11-21T18:00:00Z');
  const mk = (id, line) => ({ eventId: 'E', startsAt: '2026-11-22T18:00:00Z', playerId: id, market: 'receiving_yards', stat: 'receiving_yards', line, side: 'over', topPick: true, rates: {} });
  let t = [{ sport: 'NFL', eventId: 'E', playerId: 'old', result: null }, { sport: 'NFL', eventId: 'E', playerId: 'done', result: 'hit' }];
  t = logPicks(t, { sport: 'NFL', mode: 'odds', props: [mk('a', 60.5), mk('b', 45.5)] }, '2026-11-21', now);
  assert.deepEqual(t.map(x => x.playerId).sort(), ['a', 'b', 'done']);
  const far = logPicks([], { sport: 'NFL', mode: 'odds', props: [{ ...mk('c', 50.5), startsAt: '2026-11-27T18:00:00Z' }] }, '2026-11-21', now);
  assert.equal(far.length, 0, 'games more than 48h out are not logged yet');
});

test('NFL: grading finds the week row, voids inactive players', () => {
  const stats = [{ id: 'a', season: 2026, week: 12, receiving_yards: 71 }, { id: 'z', season: 2026, week: 12, receiving_yards: 5 }];
  const t = [
    { sport: 'NFL', playerId: 'a', season: 2026, week: 12, stat: 'receiving_yards', line: 60.5, side: 'over', startsAt: '2026-11-22T18:00:00Z', result: null },
    { sport: 'NFL', playerId: 'b', season: 2026, week: 12, stat: 'receiving_yards', line: 40.5, side: 'over', startsAt: '2026-11-22T18:00:00Z', result: null },
  ];
  nfl.grade(t, stats, Date.parse('2026-11-25T12:00:00Z'));
  assert.equal(t[0].result, 'hit'); assert.equal(t[0].actual, 71); assert.equal(t[1].result, 'void');
});

test('guards: huge edges and lines far from history are never top picks', () => {
  const rates = sc.hitRates([0, 0, 1, 0, 0, 0, 1, 0], 1.5, 'under', 'NFL');
  const s = sc.scoreProp({ modelProb: 0.97, rates, implied: 0.55, bookOdds: -130, gamesPlayed: 8, books: 5, sport: 'NFL', projection: 0.3, line: 1.5 });
  assert.ok(!s.topPick); assert.ok(s.failed.includes('too-good'));
  const r = sc.scoreProp({ modelProb: 0.62, rates: sc.hitRates([30, 20, 25, 35, 40], 23.5, 'under', 'NFL'), implied: 0.55, bookOdds: -120, gamesPlayed: 5, books: 4, sport: 'NFL', projection: 9, line: 23.5 });
  assert.ok(r.failed.includes('role'));
});

test('games that have started are dropped (no live-odds props)', () => {
  const ev = { eventID: 'L', status: { startsAt: '2026-11-19T00:30:00Z', started: true },
    teams: { home: { teamID: 'H', names: { short: 'BOS' } }, away: { teamID: 'A', names: { short: 'LAK' } } }, players: {}, odds: {} };
  const games = [{ awayTeam: { abbrev: 'LAK' }, homeTeam: { abbrev: 'BOS' } }];
  const resolve = t => teamAbbrev(t, games);
  // started flag, or start time already passed
  assert.equal(parseProps([ev], 'NHL', resolve, 0).length, 0);
  const ev2 = { ...ev, status: { startsAt: '2026-11-19T00:30:00Z' } };
  const p = { ...ev2, players: { X: { playerID: 'X', teamID: 'H', name: 'X Y' } }, odds: { 'shots_onGoal-X-game-ou-over': { oddID: 'shots_onGoal-X-game-ou-over', statID: 'shots_onGoal', playerID: 'X', periodID: 'game', betTypeID: 'ou', sideID: 'over', bookOdds: '-110', bookOverUnder: '2.5', byBookmaker: { a: {}, b: {} } } } };
  assert.equal(parseProps([p], 'NHL', resolve, Date.parse('2026-11-19T00:00:00Z')).length, 1);
  assert.equal(parseProps([p], 'NHL', resolve, Date.parse('2026-11-19T00:34:00Z')).length, 0);
});
