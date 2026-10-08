// Checks that src/model.js gives the same numbers as the dashboard HTML,
// and that the injury rule and Discord format behave as intended.
// Run: node --test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const model = require('../src/model');
const { evaluateTeam } = require('../src/injuries');
const { buildMessage } = require('../src/run');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'nhl-dashboard-v8.1.html'), 'utf8');
function extract(startMarker) {           // pull one top-level declaration out of the dashboard by brace matching
  const i = html.indexOf(startMarker);
  assert.ok(i >= 0, 'not found in dashboard: ' + startMarker);
  let depth = 0, j = startMarker.startsWith('function') ? html.indexOf(') {', i) + 2 : html.indexOf('{', i);
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) break;
  }
  return html.slice(i, j + 1);
}
const src = [
  extract('const MODEL_WEIGHTS = {') + ';', 'let W = { ...MODEL_WEIGHTS };', 'const RECENT_FORM_FULL_GAMES = 10;',
  ...['poissonPMF', 'runMonteCarlo', 'calcLambda', 'confidenceLabel', 'shrunkRatings', 'buildPrediction'].map(f => extract(`function ${f}(`)),
  'let teamStatLookup = {}, goalieLookup = {}, _inj = {};',
  'function getInjuryState(id, abbrev) { return !!_inj[abbrev]; }',
  'function dash(game, ts, gl, inj) { teamStatLookup = ts; goalieLookup = gl; _inj = inj; return { pred: buildPrediction(game), conf: confidenceLabel(buildPrediction(game).winPctAway).label }; }',
  'this.dash = dash; this.MODEL_WEIGHTS = MODEL_WEIGHTS;',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);

test('weights match the dashboard', () => {
  assert.deepStrictEqual({ ...model.MODEL_WEIGHTS }, { ...ctx.MODEL_WEIGHTS });
});

test('predictions match the dashboard on 2,000 random games', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const team = () => { const gp = Math.floor(rnd() * 40); return {
    gf: Math.round(gp * (2 + rnd() * 2.5)), ga: Math.round(gp * (2 + rnd() * 2.5)), gp,
    ppPct: 0.1 + rnd() * 0.2, pkPct: 0.7 + rnd() * 0.2, pim: 8.5,
    recentGF: rnd() < 0.1 ? null : 1 + rnd() * 4, recentN: Math.min(10, gp) }; };
  for (let i = 0; i < 2000; i++) {
    const ts = { AAA: team(), HHH: team() };
    const gl = { AAA: rnd() < 0.1 ? undefined : { savePct: 0.87 + rnd() * 0.06 }, HHH: { savePct: 0.87 + rnd() * 0.06 } };
    const game = { id: i, awayTeam: { abbrev: 'AAA' }, homeTeam: { abbrev: 'HHH' }, awayB2B: rnd() < 0.2, homeB2B: rnd() < 0.2 };
    const inj = { AAA: rnd() < 0.3, HHH: rnd() < 0.3 };
    const d = ctx.dash(game, ts, gl, inj);
    const m = model.buildPrediction(game, ts, gl, { away: inj.AAA, home: inj.HHH });
    for (const k of ['lambdaAway', 'lambdaHome', 'winPctAway', 'winPctHome', 'predGoalsAway', 'predGoalsHome'])
      assert.ok(Math.abs(d.pred[k] - m[k]) < 1e-12, `${k} differs on game ${i}`);
    assert.strictEqual(model.confidenceLabel(m.winPctAway).label, d.conf);
  }
});

test('injury rule: top-6 F / top-4 D / starting goalie only', () => {
  const roster = [], cur = new Map(), prior = new Map();
  const L = n => 'abcdefghijklmnop'[n];   // names must differ by letters (digits are stripped when matching)
  for (let i = 1; i <= 12; i++) { roster.push({ id: i, name: `Fwd Number${L(i)}`, pos: 'F' }); cur.set(i, { name: `Fwd Number${L(i)}`, pos: 'F', gp: 5, toi: 1300 - i * 50, team: 'BOS' }); }
  for (let i = 1; i <= 6; i++) { roster.push({ id: 100 + i, name: `Def Number${L(i)}`, pos: 'D' }); cur.set(100 + i, { name: `Def Number${L(i)}`, pos: 'D', gp: 5, toi: 1500 - i * 60, team: 'BOS' }); }
  roster.push({ id: 200, name: 'Jeremy Swayman', pos: 'G' }, { id: 201, name: 'Backup Guy', pos: 'G' });
  // Long-term IR star: not on the roster, no games this season, big minutes last season
  prior.set(999, { id: 999, name: 'Tróy Star', pos: 'F', gp: 80, toi: 1250, team: 'BOS' });
  const ev = inj => evaluateTeam('BOS', inj, roster, cur, prior, 'Jeremy Swayman');

  assert.strictEqual(ev([{ name: 'Fwd Numberj', pos: 'LW', status: 'Out' }]).active, false, 'bottom-6 forward');
  assert.strictEqual(ev([{ name: 'Fwd Numberc', pos: 'C', status: 'Day-To-Day' }]).active, false, 'day-to-day ignored');
  assert.strictEqual(ev([{ name: 'Fwd Numberc', pos: 'C', status: 'Out' }]).players[0].role, 'F2');
  assert.strictEqual(ev([{ name: 'Def Numbere', pos: 'D', status: 'Injured Reserve' }]).players[0].role, 'D4');
  assert.strictEqual(ev([{ name: 'Def Numberf', pos: 'D', status: 'Out' }]).active, false, '5th D');
  assert.strictEqual(ev([{ name: 'Backup Guy', pos: 'G', status: 'Out' }]).active, false, 'backup goalie');
  assert.strictEqual(ev([{ name: 'Jeremy Swayman', pos: 'G', status: 'Out' }]).players[0].role, 'starting G');
  assert.strictEqual(ev([{ name: 'Troy Star', pos: 'RW', status: 'Out' }]).players[0].role, 'F2', 'off-roster star ranked from last season');
  assert.strictEqual(ev([]).active, false);
});

test('Discord message format', () => {
  const picks = [{ away: 'OTT', home: 'BOS', pick: 'BOS', pct: 52, confidence: 'LOW CONFIDENCE', injAway: true, injHome: true, time: '7:30 PM' },
                 { away: 'PHI', home: 'TBL', pick: 'TBL', pct: 61, confidence: 'MEDIUM CONFIDENCE', injAway: false, injHome: false, time: '7:00 PM' }];
  const msg = buildMessage('2026-10-05', picks, { byTeam: {}, warning: null }, [], []).split('\n');
  assert.strictEqual(msg[0], '🏒 **NHL Picks — Mon, Oct 5** (2 games)');
  assert.strictEqual(msg[1], '⚪ OTT @ BOS → **BOS** 52% · LOW · 🏥 OTT, BOS · 7:30 PM');
  assert.strictEqual(msg[2], '🟡 PHI @ TBL → **TBL** 61% · MED · 7:00 PM');
});
