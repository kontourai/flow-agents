import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
test('new skill paths cannot overwrite legacy skill directories', () => {
  const kit = JSON.parse(fs.readFileSync(new URL('kit.json', root), 'utf8'));
  for (const id of ['knowledge.knowledge-observation-ingest', 'knowledge.knowledge-instinct-analysis', 'knowledge.knowledge-instinct-review']) {
    const skill = kit.skills.find((item) => item.id === id); assert.ok(skill, `${id} must be declared`);
    assert.ok(!['observe', 'instinct-analysis', 'instinct-review'].includes(path.basename(path.dirname(skill.path))));
    const text = fs.readFileSync(new URL(skill.path, root), 'utf8');
    const names = [...text.matchAll(/^name:\s*(.+)$/gm)];
    assert.equal(names.length, 1, 'skill frontmatter must name exactly one skill');
    assert.equal(names[0][1], `\"${path.basename(path.dirname(skill.path))}\"`);
    for (const name of [['Cl', 'aude'], ['Co', 'dex']].map((parts) => parts.join(''))) assert.equal(text.toLowerCase().includes(name.toLowerCase()), false);
  }
});
