/** Pinned AWS ceremony semantics. Settings never authenticate operator authority. */
const switches = ['sensors','learnings','summary_confirmation','plan_approval','collaborators','skeleton'];
const ranks = { none: 0, advisory: 1, adversarial: 2 };
export function resolveCeremony(defaults, overrides = {}) {
  const settings = {sensors:'on',learnings:'on',summary_confirmation:'on',plan_approval:'on',collaborators:'on',skeleton:'off',guard_policy:'strict',review_cap:'adversarial',...defaults};
  for (const [key,value] of Object.entries(overrides)) {
    if (![...switches,'review_cap','guard_policy'].includes(key)) throw new Error(`Unknown ceremony setting ${key}`);
    settings[key] = value;
  }
  for (const key of switches) {
    if (typeof settings[key] === 'boolean') settings[key] = settings[key] ? 'on' : 'off';
    if (!['on','off'].includes(settings[key])) throw new Error(`Invalid ceremony ${key}`);
  }
  if (!Object.hasOwn(ranks,settings.review_cap)||!['strict','relaxed','off'].includes(settings.guard_policy)) throw new Error('Invalid review ceiling or guard policy');
  return Object.freeze(settings);
}
export function effectiveStage(original, settings) {
  const stage = structuredClone(original);
  if (settings.collaborators === 'off') { stage.support_agents = []; if (['pipeline','mob'].includes(stage.mode)) stage.mode = 'inline'; }
  if (stage.reviewer) {
    const declared = stage.review_class ?? 'adversarial';
    if (!Object.hasOwn(ranks,declared)) throw new Error('Invalid declared review class');
    const effective = ranks[settings.review_cap] < ranks[declared] ? settings.review_cap : declared;
    if (effective === 'none') { delete stage.reviewer; delete stage.review_class; }
    else { stage.review_class = effective; if (effective === 'advisory') stage.reviewer_max_iterations = 1; }
  }
  return stage;
}
export function summaryTargets(stage, targets, settings) {
  if (settings.summary_confirmation === 'off' || !stage.summary_confirmation) return [];
  const questions = targets.filter(target => target.id.endsWith('-questions'));
  if (stage.summary_confirmation === 'required' && !questions.length) throw new Error(`Summary confirmation declared without questions: ${stage.slug}`);
  return questions;
}
