import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpType, nextVersion } from '../scripts/version.mjs';

test('bumpType maps conventional prefixes to bump levels', () => {
  assert.equal(bumpType('feat: add open button'), 'minor');
  assert.equal(bumpType('feat(ui): add open button'), 'minor');
  assert.equal(bumpType('fix: stop double scrape'), 'patch');
  assert.equal(bumpType('perf: cache median'), 'patch');
  assert.equal(bumpType('docs: update readme'), null);
  assert.equal(bumpType('chore: bump deps'), null);
  assert.equal(bumpType('ci: add workflow'), null);
  assert.equal(bumpType('refactor: split module'), null);
  assert.equal(bumpType('no conventional prefix'), null);
});

test('bumpType detects breaking changes', () => {
  assert.equal(bumpType('feat!: drop legacy api'), 'major');
  assert.equal(bumpType('feat(api)!: drop legacy'), 'major');
  assert.equal(bumpType('fix!: change defaults'), 'major');
  assert.equal(bumpType('refactor: x\n\nBREAKING CHANGE: removed y'), 'major');
});

test('nextVersion bumps each part and normalizes a 2-part version', () => {
  assert.equal(nextVersion('1.0', 'minor'), '1.1.0');
  assert.equal(nextVersion('1.0', 'patch'), '1.0.1');
  assert.equal(nextVersion('1.0', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
});

test('nextVersion returns null for an unknown level', () => {
  assert.equal(nextVersion('1.2.3', 'none'), null);
  assert.equal(nextVersion('1.2.3', null), null);
});
