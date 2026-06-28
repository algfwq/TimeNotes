import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const topBar = readFileSync(new URL('../src/components/TopBar.tsx', import.meta.url), 'utf8');

test('save dialog does not seed users with a developer-machine directory', () => {
  assert.equal(topBar.includes("D:\\TimeNotes\\TimeNotes\\sample.tnote"), false);
});

test('save dialog does not pass an untrusted path-derived directory directly', () => {
  assert.equal(topBar.includes('Directory: directoryFromPath(savePath),'), false);
});
