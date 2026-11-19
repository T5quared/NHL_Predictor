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
      'shots_onGoal-KEVIN_FIALA_1_NHL-game-ou-over':  { oddID: 'shots_onGoal-KEVIN_FIALA_1_NHL-game-ou-over',  statID: 'shots_onGoal', statEntityID: 'KEVIN_FIALA_1_NHL', playerID: 'KEVIN_FIALA_1_NHL', periodID: 'game', betTypeID: 'ou', sideID: 'over',  bookOdds: '-105', bookOverUnder: '2.5', fairOddsAvailable: false },
      'points-home-game-ml-home': { oddID: 'points-home-game-ml-home', statID: 'points', statEntityID: 'home', periodID: 'game', betTypeID: 'ml', sideID: 'home', bookOdds: '-150' },
    },
  };
  assert.equal(teamAbbrev(ev.teams.away, games), 'LAK');
  const rows = parseProps([ev], 'NHL', games);
  assert.equal(rows.length, 2);
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
