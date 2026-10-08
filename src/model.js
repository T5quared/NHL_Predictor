// ════════════════════════════════════════════════════════════════════
//  NHL prediction model — v8.1
//  Copied from dashboard/nhl-dashboard-v8.1.html. The maths here must stay
//  identical to the dashboard; test/parity.test.js checks that it does.
//  To tune the model, edit MODEL_WEIGHTS (and the dashboard to match).
// ════════════════════════════════════════════════════════════════════
const MODEL_VERSION = 'v8.1';

const MODEL_WEIGHTS = {
  BASE_GOALS: 3.35,
  LEAGUE_AVG_GOALS: 3.12,
  SHRINK_GAMES: 20,
  DEFENSE_WEIGHT: 1.0,
  SEASON_AVG_WEIGHT: 0.55,
  RECENT_FORM_WEIGHT: 0.45,
  HOME_ICE_BONUS: 0.10,
  CONF_HIGH_THRESHOLD: 0.35,
  CONF_MED_THRESHOLD: 0.20,
  LEAGUE_AVG_SAVE_PCT: 0.901,
  GOALIE_SENSITIVITY: 3.0,
  LEAGUE_AVG_PP_PCT: 0.197,
  LEAGUE_AVG_PK_PCT: 0.798,
  LEAGUE_AVG_PIM: 8.5,
  PP_SENSITIVITY: 3.5,
  PK_SENSITIVITY: 1.5,
  PIM_SENSITIVITY: 0.02,
  BACK_TO_BACK_PENALTY: 0.20,
  INJURY_PENALTY: 0.30,
  PRIOR_GOALIE_FADE_STARTS: 15,
};

const W = { ...MODEL_WEIGHTS };
const RECENT_FORM_FULL_GAMES = 10;

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// Exact win probability (name kept from the dashboard). Regulation tie = 50/50.
function runMonteCarlo(lambdaA, lambdaB) {
  const MAX_GOALS = 25;
  const la = Math.max(0.1, lambdaA);   // away
  const lb = Math.max(0.1, lambdaB);   // home
  let homeWin = 0, tie = 0, awayBelow = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const pAway = poissonPMF(h, la);
    const pHome = poissonPMF(h, lb);
    homeWin += pHome * awayBelow;
    tie += pAway * pHome;
    awayBelow += pAway;
  }
  const winPctHome = homeWin + 0.5 * tie;
  return {
    winPctAway: 1 - winPctHome,
    winPctHome,
    predGoalsAway: Math.round(la * 10) / 10,
    predGoalsHome: Math.round(lb * 10) / 10,
  };
}

function calcLambda(team, isHome, opponentGoalie, opts = {}) {
  const { injuryActive = false, isB2B = false, opponentGA = null } = opts;

  const base = W.BASE_GOALS;
  const seasonGF = team.seasonGF || W.BASE_GOALS;
  const seasonComponent = (seasonGF / W.BASE_GOALS);

  // v8.1: recent form trusted in proportion to its sample size
  const recentRaw = team.recentGF || seasonGF;
  const recentN = Math.max(0, Math.min(RECENT_FORM_FULL_GAMES, team.recentN ?? RECENT_FORM_FULL_GAMES));
  const recentTrust = recentN / RECENT_FORM_FULL_GAMES;
  const recentGF = recentTrust * recentRaw + (1 - recentTrust) * seasonGF;
  const recentComponent = (recentGF / W.BASE_GOALS);

  let lambda = base * (W.SEASON_AVG_WEIGHT * seasonComponent + W.RECENT_FORM_WEIGHT * recentComponent);

  // v8: opponent defense
  if (opponentGA != null && isFinite(opponentGA) && W.LEAGUE_AVG_GOALS > 0) {
    lambda *= (1 - W.DEFENSE_WEIGHT) + W.DEFENSE_WEIGHT * (opponentGA / W.LEAGUE_AVG_GOALS);
  }

  // Opponent goalie
  let goalieAdj = 1.0;
  if (opponentGoalie && opponentGoalie.savePct != null) {
    goalieAdj = 1 - (opponentGoalie.savePct - W.LEAGUE_AVG_SAVE_PCT) * W.GOALIE_SENSITIVITY;
  }
  lambda *= goalieAdj;

  // PP / PK
  const ppPct = team.ppPct || W.LEAGUE_AVG_PP_PCT;
  const pkPct = team.pkPct || W.LEAGUE_AVG_PK_PCT;
  const pim = team.pim || W.LEAGUE_AVG_PIM;
  const ppMod = 1 + (ppPct - W.LEAGUE_AVG_PP_PCT) * W.PP_SENSITIVITY;
  const pkMod = 1 + (pkPct - W.LEAGUE_AVG_PK_PCT) * W.PK_SENSITIVITY;
  const pimMod = 1 - (pim - W.LEAGUE_AVG_PIM) * W.PIM_SENSITIVITY;
  lambda *= ppMod * pkMod * pimMod;

  if (isHome) lambda += W.HOME_ICE_BONUS;
  if (isB2B) lambda -= W.BACK_TO_BACK_PENALTY;
  if (injuryActive) lambda -= W.INJURY_PENALTY;

  return { lambda: Math.max(0.3, lambda) };
}

function confidenceLabel(winPct) {
  const spread = Math.abs(winPct - 0.5) * 2;
  if (spread > W.CONF_HIGH_THRESHOLD) return { label: 'HIGH CONFIDENCE', cls: 'conf-high' };
  if (spread > W.CONF_MED_THRESHOLD)  return { label: 'MEDIUM CONFIDENCE', cls: 'conf-med' };
  return { label: 'LOW CONFIDENCE', cls: 'conf-low' };
}

function shrunkRatings(stats) {
  if (!stats) return { gf: null, ga: null };
  if (stats.gf == null || stats.gp == null) return { gf: stats.gfPG ?? null, ga: stats.gaPG ?? null };
  const n = Math.max(0, W.SHRINK_GAMES), avg = W.LEAGUE_AVG_GOALS;
  const denom = stats.gp + n;
  if (!(denom > 0)) return { gf: null, ga: null };
  return { gf: (stats.gf + n * avg) / denom, ga: (stats.ga + n * avg) / denom };
}

function priorShare(played, fadeOver) {
  if (!(fadeOver > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - (played || 0) / fadeOver));
}

// One game. `game` = { awayTeam:{abbrev}, homeTeam:{abbrev}, awayB2B, homeB2B }
// `inj` = { away: bool, home: bool }
function buildPrediction(game, teamStatLookup, goalieLookup, inj = {}) {
  const away = game.awayTeam?.abbrev;
  const home = game.homeTeam?.abbrev;
  const awayStats = teamStatLookup[away] || {};
  const homeStats = teamStatLookup[home] || {};
  const awayGoalie = goalieLookup[away] || null;
  const homeGoalie = goalieLookup[home] || null;
  const awayR = shrunkRatings(awayStats);
  const homeR = shrunkRatings(homeStats);

  const { lambda: lambdaAway } = calcLambda(
    { seasonGF: awayR.gf, recentGF: awayStats.recentGF ?? awayR.gf, recentN: awayStats.recentN, ppPct: awayStats.ppPct, pkPct: awayStats.pkPct, pim: awayStats.pim },
    false, homeGoalie,
    { injuryActive: !!inj.away, isB2B: game.awayB2B, opponentGA: homeR.ga }
  );
  const { lambda: lambdaHome } = calcLambda(
    { seasonGF: homeR.gf, recentGF: homeStats.recentGF ?? homeR.gf, recentN: homeStats.recentN, ppPct: homeStats.ppPct, pkPct: homeStats.pkPct, pim: homeStats.pim },
    true, awayGoalie,
    { injuryActive: !!inj.home, isB2B: game.homeB2B, opponentGA: awayR.ga }
  );
  return { lambdaAway, lambdaHome, ...runMonteCarlo(lambdaAway, lambdaHome), awayGoalie, homeGoalie };
}

module.exports = {
  MODEL_VERSION, MODEL_WEIGHTS, W, RECENT_FORM_FULL_GAMES,
  poissonPMF, runMonteCarlo, calcLambda, confidenceLabel, shrunkRatings, priorShare, buildPrediction,
};
