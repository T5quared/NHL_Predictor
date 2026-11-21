#!/usr/bin/env node
// Daily run: grade yesterday's picks, predict today's games, post to Discord, save to data/tracker.json
//   DISCORD_WEBHOOK_URL  — where to post (if missing, the message is only printed)
//   DRY_RUN=1            — print and write data/last-run.json, but don't post or touch the tracker
//   FORCE=1              — post even if today's picks were already sent
//   DATE=YYYY-MM-DD      — run for a specific date (testing)
const fs = require('fs');
const path = require('path');
const model = require('./model');
const nhl = require('./nhl');
const { autoInjuries } = require('./injuries');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRACKER_FILE = path.join(DATA_DIR, 'tracker.json');
const LAST_RUN_FILE = path.join(DATA_DIR, 'last-run.json');
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const ASKED_DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
// No webhook = nothing can be posted, so behave like a dry run (and fail the run so it's noticed)
const DRY_RUN = ASKED_DRY || !WEBHOOK;

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');

// ── Grade earlier picks that have no result yet ──────────────────────
async function gradePending(tracker, today) {
  const pending = tracker.filter(e => !e.saved && e.date < today);
  const graded = [];
  for (const date of [...new Set(pending.map(e => e.date))]) {
    let games;
    try { games = await nhl.fetchGamesOn(date); } catch { continue; }
    for (const e of pending.filter(p => p.date === date)) {
      const g = games.find(x => x.id === e.gameId);
      if (!g || !['OFF', 'FINAL'].includes(g.gameState)) continue;
      const ag = g.awayTeam?.score, hg = g.homeTeam?.score;
      if (ag == null || hg == null || ag === hg) continue;
      e.actualGoalsAway = ag;
      e.actualGoalsHome = hg;
      e.actualWinner = ag > hg ? e.away : e.home;
      e.hit = e.predWinner === e.actualWinner;
      e.mae = (Math.abs(e.predGoalsAway - ag) + Math.abs(e.predGoalsHome - hg)) / 2;
      e.saved = true;
      graded.push(e);
    }
  }
  return graded;
}

// ── Discord ──────────────────────────────────────────────────────────
const TIER_ICON = { 'HIGH CONFIDENCE': '🟢', 'MEDIUM CONFIDENCE': '🟡', 'LOW CONFIDENCE': '⚪' };
const TIER_SHORT = { 'HIGH CONFIDENCE': 'HIGH', 'MEDIUM CONFIDENCE': 'MED', 'LOW CONFIDENCE': 'LOW' };

function buildMessage(today, picks, injuries, graded, tracker) {
  const lines = [];
  if (picks.length) {
    const dateStr = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    lines.push(`🏒 **NHL Picks — ${dateStr}** (${picks.length} game${picks.length === 1 ? '' : 's'})`);
    for (const p of picks) {
      const inj = [p.injAway && p.away, p.injHome && p.home].filter(Boolean);
      lines.push(`${TIER_ICON[p.confidence] || '⚪'} ${p.away} @ ${p.home} → **${p.pick}** ${p.pct}% · ${TIER_SHORT[p.confidence] || p.confidence}`
        + (inj.length ? ` · 🏥 ${inj.join(', ')}` : '')
        + (p.time ? ` · ${p.time}` : ''));
    }
    // Who triggered each injury toggle
    const who = [];
    for (const [abbrev, r] of Object.entries(injuries.byTeam)) {
      if (r.active) who.push(`${abbrev}: ${r.players.map(x => `${x.name.split(' ').slice(1).join(' ') || x.name} (${x.role})`).join(', ')}`);
    }
    if (who.length) lines.push(`-# 🏥 ${who.join(' · ')}`);
    if (injuries.warning) lines.push(`-# ⚠️ ${injuries.warning}`);
  }
  if (graded.length) {
    const hits = graded.filter(e => e.hit).length;
    const all = tracker.filter(e => e.saved && e.auto);
    const allHits = all.filter(e => e.hit).length;
    lines.push(`-# 📊 Last results: ${hits}/${graded.length} · Auto-run record: ${allHits}/${all.length} (${Math.round(100 * allHits / all.length)}%)`);
  }
  return lines.join('\n');
}

async function postToDiscord(content) {
  // Discord caps a message at 2000 characters — split on line breaks if needed
  const chunks = [];
  let cur = '';
  for (const line of content.split('\n')) {
    if ((cur + '\n' + line).length > 1900) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) chunks.push(cur);
  for (const chunk of chunks) {
    const res = await fetch(WEBHOOK + (WEBHOOK.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const today = process.env.DATE || nhl.etDate();
  const { season, prior } = nhl.seasonFor(today);
  console.log(`NHL predictor ${model.MODEL_VERSION} — ${today} (season ${season})${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const tracker = readJson(TRACKER_FILE, []);
  const graded = await gradePending(tracker, today);
  console.log(`Graded ${graded.length} earlier pick(s)`);

  const alreadySent = tracker.some(e => e.date === today && e.auto);
  let games = (await nhl.fetchGamesOn(today)).filter(g => !['PPD', 'CNCL'].includes(g.gameScheduleState));
  // GitHub runs this late some days — never post a pick for a game that has already started
  if (!process.env.DATE) {
    const started = games.filter(g => !['FUT', 'PRE'].includes(g.gameState) || Date.parse(g.startTimeUTC) <= Date.now());
    if (started.length) console.log(`Skipping ${started.length} game(s) already started: ${started.map(g => `${g.awayTeam.abbrev}@${g.homeTeam.abbrev}`).join(', ')}`);
    games = games.filter(g => !started.includes(g));
  }
  if (alreadySent && !FORCE) { console.log('Picks for today were already sent — skipping (set FORCE=1 to resend)'); games = []; }

  const picks = [];
  let injuries = { byTeam: {}, warning: null };
  const debug = { date: today, modelVer: model.MODEL_VERSION, weights: model.W, games: [] };

  if (games.length) {
    const [teamStats, goalies, recentGames] = await Promise.all([
      nhl.fetchTeamStats(season), nhl.fetchGoalies(season, prior), nhl.fetchRecentGames(today),
    ]);
    const form = nhl.recentFormFrom(recentGames);
    for (const [abbrev, t] of Object.entries(teamStats)) {
      t.recentGF = form[abbrev]?.gfPG ?? null;
      t.recentN = form[abbrev]?.n ?? 0;
    }
    const playedYesterday = nhl.teamsPlayedOn(recentGames, nhl.addDays(today, -1));
    const teams = [...new Set(games.flatMap(g => [g.awayTeam?.abbrev, g.homeTeam?.abbrev]).filter(Boolean))];
    injuries = await autoInjuries(teams, { season, prior, teamStats, goalies });
    debug.injuries = injuries;

    games.sort((a, b) => String(a.startTimeUTC).localeCompare(String(b.startTimeUTC)));
    for (const g of games) {
      const away = g.awayTeam?.abbrev, home = g.homeTeam?.abbrev;
      const game = { ...g, awayB2B: playedYesterday.has(away), homeB2B: playedYesterday.has(home) };
      const inj = { away: !!injuries.byTeam[away]?.active, home: !!injuries.byTeam[home]?.active };
      const pred = model.buildPrediction(game, teamStats, goalies, inj);
      const conf = model.confidenceLabel(pred.winPctAway);
      const pick = pred.winPctAway > pred.winPctHome ? away : home;
      picks.push({
        gameId: g.id, away, home, pick,
        pct: Math.round(Math.max(pred.winPctAway, pred.winPctHome) * 100),
        confidence: conf.label, confidenceCls: conf.cls, pred,
        injAway: inj.away, injHome: inj.home, awayB2B: game.awayB2B, homeB2B: game.homeB2B,
        gpAway: teamStats[away]?.gp ?? null, gpHome: teamStats[home]?.gp ?? null,
        time: g.startTimeUTC ? new Date(g.startTimeUTC).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: nhl.TZ }) : '',
      });
      debug.games.push({
        gameId: g.id, away, home, pick, winPctAway: pred.winPctAway, winPctHome: pred.winPctHome,
        lambdaAway: pred.lambdaAway, lambdaHome: pred.lambdaHome, confidence: conf.label,
        awayB2B: game.awayB2B, homeB2B: game.homeB2B, injAway: inj.away, injHome: inj.home,
        awayStats: teamStats[away], homeStats: teamStats[home], awayGoalie: pred.awayGoalie, homeGoalie: pred.homeGoalie,
      });
    }
  }

  // Tracker entries use the same fields as the dashboard's tracker, plus the auto-injury details
  if (!DRY_RUN) {
    for (const p of picks) {
      if (tracker.some(e => e.gameId === p.gameId)) continue;
      tracker.push({
        gameId: p.gameId, date: today, away: p.away, home: p.home, predWinner: p.pick,
        predGoalsAway: p.pred.predGoalsAway, predGoalsHome: p.pred.predGoalsHome,
        winPctAway: Math.round(p.pred.winPctAway * 100), winPctHome: Math.round(p.pred.winPctHome * 100),
        confidence: p.confidence, confidenceCls: p.confidenceCls, modelVer: model.MODEL_VERSION,
        gpAway: p.gpAway, gpHome: p.gpHome, injAway: p.injAway, injHome: p.injHome,
        auto: true, injuryMode: 'auto', awayB2B: p.awayB2B, homeB2B: p.homeB2B,
        injPlayersAway: injuries.byTeam[p.away]?.players || [], injPlayersHome: injuries.byTeam[p.home]?.players || [],
        injSkippedAway: injuries.byTeam[p.away]?.skipped || [], injSkippedHome: injuries.byTeam[p.home]?.skipped || [],
        actualGoalsAway: null, actualGoalsHome: null, actualWinner: null, hit: null, mae: null, saved: false,
      });
    }
  }

  const message = buildMessage(today, picks, injuries, graded, tracker);
  debug.message = message;
  console.log('\n' + (message || '(nothing to post — no games today and no new results)') + '\n');

  if (message && !DRY_RUN) { await postToDiscord(message); console.log('Posted to Discord'); }
  if (!DRY_RUN) writeJson(TRACKER_FILE, tracker);
  if (picks.length || DRY_RUN) writeJson(LAST_RUN_FILE, debug);
  if (!ASKED_DRY && !WEBHOOK) {
    console.error('DISCORD_WEBHOOK_URL secret is not set — nothing was posted or saved. Add it under Settings > Secrets and variables > Actions.');
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildMessage, gradePending };
