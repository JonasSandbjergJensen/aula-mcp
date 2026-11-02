import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../www/aula-dashboard-card.js', import.meta.url), 'utf8');
let Card;
vm.runInNewContext(source, { HTMLElement: class {}, customElements: { define: (_name, cls) => { Card = cls; } }, window: {} });
test('Aula-provided HTML and script-shaped values are rendered as text', () => {
  const card = new Card();
  const output = card.data({ title: '<img src=x onerror=alert(1)>', content: '<script>bad()</script>' });
  assert.ok(!output.includes('<img'));
  assert.ok(!output.includes('<script>'));
  assert.ok(output.includes('&lt;img'));
});
test('calendar filter distinguishes lessons from family events and scopes child IDs', () => {
  const card = new Card(); card.child = '42'; card.lessons = false;
  card.snapshot = { manifest: { children: [{ id: 42, name: 'Test Child' }] }, sections: { calendar: { status: 'ok', data: [
    { type: 'lesson', title: 'Lesson hidden', belongsToProfiles: [42], startDateTime: '2026-10-30T08:00:00+01:00' },
    { type: 'event', title: 'Parent meeting', belongsToProfiles: [42], startDateTime: '2026-10-30T15:00:00+01:00' },
    { type: 'event', title: 'Other child', belongsToProfiles: [43], startDateTime: '2026-10-30T15:00:00+01:00' },
  ] } } };
  assert.ok(card.calendar().includes('Parent meeting'));
  assert.ok(!card.calendar().includes('Lesson hidden'));
  assert.ok(!card.calendar().includes('Other child'));
  card.lessons = true; assert.ok(card.calendar().includes('Lesson hidden'));
});
