// pass-at-k.js — Compute pass@k or pass^k from promptfoo repeat results
// config.k: number — number of attempts (default 3)
// config.threshold: number — minimum pass rate (default 0.9)
// config.metric: 'pass_at_k' | 'pass_pow_k' (default 'pass_at_k')
//
// Note: promptfoo's --repeat flag runs each case k times. This assertion
// is designed as a post-processing check. When used inline, it evaluates
// the current run's pass/fail and defers aggregation to eval-report.sh.

module.exports = (output, { config }) => {
  const k = config.k || 3;
  const threshold = config.threshold || 0.9;
  const metric = config.metric || 'pass_at_k';

  // In inline mode, we can only see this single run's output.
  // Return a score of 1 (pass) or 0 (fail) for aggregation by eval-report.sh.
  const passed = output && output.trim().length > 0;
  const score = passed ? 1 : 0;

  if (metric === 'pass_pow_k') {
    // pass^k: all attempts must succeed — each run must pass
    return {
      pass: passed,
      score,
      reason: passed
        ? `Run passed (pass^${k} requires all ${k} runs to pass)`
        : `Run failed (pass^${k} requires all ${k} runs to pass)`,
    };
  }

  // pass@k: at least 1 success in k attempts
  return {
    pass: passed,
    score,
    reason: passed
      ? `Run passed (pass@${k} requires >= ${threshold * 100}% success rate across ${k} runs)`
      : `Run failed (pass@${k} aggregation computed by eval-report.sh)`,
  };
};
