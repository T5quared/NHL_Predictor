#!/usr/bin/env node
// Daily props run (NHL + NFL): grade earlier picks, scan the prop boards, score and rank every prop,
// build the Props dashboard, post the top picks to Discord.
//   SPORTSGAMEODDS_API_KEY — prop boards + consensus odds (free plan). Without it: NHL on standard lines, no NFL.
//   SPORTS                 — which sports to run (default "NHL,NFL"); the other sport's last section is kept
//   DISCORD_WEBHOOK_URL    — where to post (skipped if missing)
//   DASHBOARD_URL          — optional link added to the Discord post
//   DRY_RUN=1              — don't post or touch the tracker
//   DATE=YYYY-MM-DD        — run for a specific date (testing)
const fs = require('fs');
const path = require('path');
const nhl = require('../nhl');
const nhlProps = require('./nhlProps');
const nflProps = require('./nfl');
const { probToAmerican } = require('./scoring');
const { MARKETS, SPORTS, TOP_N_DISCORD, BLEND, FILTERS, NFL_RATE, MAX_TOP_PICKS } = require('./config');

const ROOT = path.join(__dirname, '..', '..');
const PROPS_FILE = path.join(ROOT, 'data', 'props.json');
const TRACKER_FILE = path.join(ROOT, 'data', 'props-tracker.json');
const TEMPLATE = path.join(ROOT, 'dashboard', 'props-template.html');
const DASHBOARD = path.join(ROOT, 'dashboard', 'props.html');

const env = k => (process.env[k] || '').trim();
const DRY_RUN = ['1', 'true'].includes(env('DRY_RUN'));
const SGO_KEY = env('SPORTSGAMEODDS_API_KEY');
const WEBHOOK = env('DISCORD_WEBHOOK_URL');
const RUN_SPORTS = (env('SPORTS') || 'NHL,NFL').split(',').map(s => s.trim().toUpperCase()).filter(s => SPORTS[s]);

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1) + '\n');
const SHORT = Object.fromEntries(Object.values(MARKETS).flat().map(m => [m.key, m.short]));
const r4 = x => x == null ? null : +x.toFixed(4);
const keyOf = p => `${p.playerId}|${p.market}|${p.side}|${p.line}`;

// ── Pick logging (graded later) ──────────────────────────────────────
function logPicks(tracker, section, today, now) {
  const entry = p => ({
    date: p.gameDate || today, sport: section.sport, mode: section.mode, eventId: p.eventId, startsAt: p.startsAt,
    season: p.season ?? null, week: p.week ?? null, playerId: p.playerId, playerName: p.playerName, team: p.team, opp: p.opp,
    market: p.market, stat: p.stat, line: p.line, side: p.side, bookOdds: p.bookOdds, implied: r4(p.implied),
    modelProb: r4(p.modelProb), hitShrunk: r4(p.hitShrunk), finalProb: r4(p.finalProb), edge: r4(p.edge),
    consistent: p.consistent, actual: null, result: null,
  });
  if (section.sport === 'NHL') {           // once per day, at the daily run
    const have = new Set(tracker.filter(p => (p.sport || 'NHL') === 'NHL' && p.date === today).map(keyOf));
    for (const p of section.props.filter(x => x.topPick)) if (!have.has(keyOf(p))) tracker.push(entry(p));
    return tracker;
  }
  // NFL: lines move all week, so the last run before kickoff wins. Replace ungraded picks for games still on the board.
  const live = new Set(section.props.map(p => p.eventId));
  const kept = tracker.filter(p => !(p.sport === 'NFL' && p.result == null && live.has(p.eventId)));
  const soon = p => p.startsAt && Date.parse(p.startsAt) - now < NFL_RATE.LOG_WITHIN_HOURS * 3600e3;
  for (const p of section.props.filter(x => x.topPick && soon(x))) kept.push(entry(p));
  return kept;
}

function recordOf(tracker, sport) {
  const done = tracker.filter(p => (p.sport || 'NHL') === sport && (p.result === 'hit' || p.result === 'miss'));
  const byMarket = {};
  for (const p of done) { const m = (byMarket[p.market] ||= { hits: 0, n: 0 }); m.n++; if (p.result === 'hit') m.hits++; }
  // Which half of the blend has been more accurate (lower Brier = better) — for the 2-week review
  const brier = key => done.length ? done.reduce((s, p) => s + ((p[key] ?? 0.5) - (p.result === 'hit' ? 1 : 0)) ** 2, 0) / done.length : null;
  return { hits: done.filter(p => p.result === 'hit').length, n: done.length, byMarket,
    brier: { model: brier('modelProb'), hitRate: brier('hitShrunk'), final: brier('finalProb'), market: brier('implied') } };
}

// Trim each prop to what the dashboard needs
function forDashboard(section, tracker) {
  return {
    sport: section.sport, mode: section.mode, warning: section.warning, objectsUsed: section.objects,
    generatedAt: new Date().toISOString(), windows: SPORTS[section.sport].windows,
    counts: { scanned: section.props.length, topPicks: section.props.filter(p => p.topPick).length, games: section.games },
    record: recordOf(tracker, section.sport),
    recentResults: tracker.filter(p => (p.sport || 'NHL') === section.sport && p.result).slice(-60).reverse(),
    props: section.props.map(p => ({
      playerName: p.playerName, playerId: p.playerId, team: p.team, opp: p.opp, home: p.home, pos: p.pos, logo: p.logo,
      startsAt: p.startsAt, market: p.market, line: p.line, side: p.side, bookOdds: p.bookOdds,
      implied: r4(p.implied), books: p.books, gp: p.gp, rates: p.rates, projection: p.projection ?? null,
      modelProb: r4(p.modelProb), hitShrunk: r4(p.hitShrunk), finalProb: r4(p.finalProb), edge: r4(p.edge),
      fairOdds: probToAmerican(p.finalProb), consistent: p.consistent, topPick: p.topPick, failed: p.failed,
    })),
  };
}

// ── Discord ──────────────────────────────────────────────────────────
const fmtOdds = o => o == null ? '' : o > 0 ? `+${o}` : `${o}`;
const pct = x => `${Math.round(x * 100)}%`;
function propText(p) {
  if (p.market === 'anytime_td') return `ATD ${p.side === 'over' ? 'Yes' : 'No'}`;
  return `${p.side === 'over' ? 'O' : 'U'} ${p.line} ${SHORT[p.market] || p.market}`;
}
function sectionLines(title, picks, total, sec) {
  const lines = [`${title} (top ${picks.length} of ${total})`];
  picks.forEach((p, i) => lines.push(
    `${i + 1}. **${p.playerName}** ${propText(p)}` + (p.bookOdds != null ? ` (${fmtOdds(p.bookOdds)})` : '')
    + ` · ${pct(p.finalProb)}` + (p.edge != null ? ` · edge +${(p.edge * 100).toFixed(1)}%` : '')
    + ` · L${SPORTS[sec.sport].windows[1]} ${p.rates[`l${SPORTS[sec.sport].windows[1]}`].hits}/${p.rates[`l${SPORTS[sec.sport].windows[1]}`].n}`
    + (p.consistent ? ' ✅' : '')));
  if (sec.record.n) lines.push(`-# 📊 ${sec.sport} prop record: ${sec.record.hits}/${sec.record.n} (${pct(sec.record.hits / sec.record.n)})`);
  return lines;
}
function buildMessage(today, ran, now) {
  const dateStr = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const lines = [];
  const n = ran.NHL;
  if (n && n.counts.games) {
    const top = n.props.filter(p => p.topPick);
    lines.push(...sectionLines(`🏒 **NHL Props — ${dateStr}**`, top.slice(0, TOP_N_DISCORD), top.length, n));
    if (n.mode === 'standard-lines') lines.push('-# ⚠️ No odds feed: standard lines, ranked by probability (no edge)');
  }
  const f = ran.NFL;
  if (f) {
    const soon = f.props.filter(p => p.topPick && p.startsAt && Date.parse(p.startsAt) - now < NFL_RATE.DISCORD_WITHIN_HOURS * 3600e3);
    if (soon.length) { if (lines.length) lines.push(''); lines.push(...sectionLines(`🏈 **NFL Props — next ${NFL_RATE.DISCORD_WITHIN_HOURS}h**`, soon.slice(0, TOP_N_DISCORD), soon.length, f)); }
  }
  if (lines.length && env('DASHBOARD_URL')) lines.push(`-# 📋 Full table: <${env('DASHBOARD_URL')}>`);
  return lines.join('\n');
}
async function postToDiscord(content) {
  const res = await fetch(WEBHOOK + (WEBHOOK.includes('?') ? '&' : '?') + 'wait=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1990) }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}`);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const today = env('DATE') || nhl.etDate();
  const now = env('DATE') ? Date.parse(`${today}T18:00:00Z`) : Date.now();
  console.log(`Props — ${today} · ${RUN_SPORTS.join('+')}${DRY_RUN ? ' [DRY RUN]' : ''}${SGO_KEY ? '' : ' [no odds key]'}`);

  let tracker = readJson(TRACKER_FILE, []);
  const prev = readJson(PROPS_FILE, {});
  const sports = prev.sports || {};
  const ran = {};

  for (const sport of RUN_SPORTS) {
    try {
      const section = sport === 'NHL'
        ? await nhlProps.run({ today, tracker, sgoKey: SGO_KEY })
        : await nflProps.run({ today, tracker, sgoKey: SGO_KEY, now });
      if (!DRY_RUN && section.props.length) tracker = logPicks(tracker, section, today, now);
      ran[sport] = sports[sport] = forDashboard(section, tracker);
      console.log(`[${sport}] ${section.props.length} props · ${ran[sport].counts.topPicks} top picks · mode ${section.mode}`
        + (section.objects ? ` · ${section.objects} odds objects` : '') + (section.warning ? ` · ⚠️ ${section.warning}` : ''));
    } catch (e) {
      console.error(`[${sport}] failed:`, e);
      sports[sport] = { ...(sports[sport] || { sport, props: [], counts: { scanned: 0, topPicks: 0, games: 0 }, windows: SPORTS[sport].windows, record: recordOf(tracker, sport) }),
        warning: `Today's ${sport} run failed (${e.message}) — showing the last good data` };
      process.exitCode = 1;
    }
  }

  const out = { date: today, generatedAt: new Date().toISOString(), settings: { BLEND, FILTERS, SPORTS, MAX_TOP_PICKS }, sports };
  writeJson(PROPS_FILE, out);
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  fs.writeFileSync(DASHBOARD, tpl.replace('/*__PROPS_DATA__*/null', JSON.stringify(out).replace(/</g, '\\u003c')));

  const message = buildMessage(today, ran, now);
  if (message) console.log('\n' + message + '\n');
  if (!DRY_RUN) {
    writeJson(TRACKER_FILE, tracker);
    if (message && WEBHOOK) { await postToDiscord(message); console.log('Posted to Discord'); }
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildMessage, logPicks, recordOf };
