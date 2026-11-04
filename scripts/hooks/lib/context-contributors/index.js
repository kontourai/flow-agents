'use strict';

// Contributors are registered in a stable order. Each receives the same event,
// payload and budget; a failure in one contributor never suppresses another.
function createContributorRegistry(contributors) {
  const registered = [...contributors];
  return (event, payload, budget) => registered.flatMap((contributor, order) => {
    try {
      const result = contributor(event, payload, budget);
      return result && typeof result.text === 'string' && result.text && Number.isFinite(result.priority)
        ? [{ ...result, order }] : [];
    } catch { return []; }
  }).sort((a, b) => b.priority - a.priority || a.order - b.order).map(result => result.text).join('');
}
module.exports = { createContributorRegistry };
