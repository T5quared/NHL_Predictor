// Per-game expected stat for one player tonight (the "model" side of the blend)
const { RATE } = require('./config');

function playerRate({ log, stat, pos, prior, factor = 1 }) {
  const values = log.map(g => g[stat]);
  const gp = values.length;
  const sum = values.reduce((s, v) => s + v, 0);
  const priorRate = prior && prior.gp >= 20 ? prior[stat] / prior.gp : RATE.POSITION_DEFAULTS[pos || 'F'][stat];
  const base = (sum + RATE.PRIOR_GAMES * priorRate) / (gp + RATE.PRIOR_GAMES);
  let rate = base;
  if (gp >= 5) {
    const recent = values.slice(0, 10);
    const recentRate = recent.reduce((s, v) => s + v, 0) / recent.length;
    rate = (1 - RATE.RECENT_WEIGHT) * base + RATE.RECENT_WEIGHT * recentRate;
  }
  return Math.max(0.01, rate * factor);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Matchup multiplier: scoring stats follow tonight's team goal projection, shots follow opponent shots against
function matchupFactor({ market, teamLambda, teamGfPG, oppShotsAgainst, leagueShotsAgainst }) {
  if (market.scoring) {
    if (!(teamLambda > 0 && teamGfPG > 0)) return 1;
    return clamp(teamLambda / teamGfPG, RATE.TEAM_FACTOR_MIN, RATE.TEAM_FACTOR_MAX);
  }
  if (!(oppShotsAgainst > 0 && leagueShotsAgainst > 0)) return 1;
  return clamp(oppShotsAgainst / leagueShotsAgainst, RATE.SHOTS_FACTOR_MIN, RATE.SHOTS_FACTOR_MAX);
}

module.exports = { playerRate, matchupFactor };
