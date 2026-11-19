// NFL props — stage set, not built yet.
// Plan (same flow as NHL, see src/props/run-props.js):
//   1. Prop board + consensus odds: SportsGameOdds, leagueID=NFL (lines are player-specific, so odds are required)
//   2. Player game logs: nflverse weekly player stats (free, GitHub releases)
//   3. Same scoring/ranking (src/props/scoring.js), with a normal-distribution rate model for yardage
//      instead of Poisson. Markets are listed in src/props/config.js (MARKETS.NFL).
//   Schedule: weekly run + a refresh before Sunday kickoffs for injuries.
function status() {
  return { built: false, message: 'NFL props are coming next — markets and data sources are set up in the config.' };
}
module.exports = { status };
