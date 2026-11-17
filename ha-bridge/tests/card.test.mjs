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

test('personal inbox filters and HTML escaping keep archived messages recoverable', () => {
  const card = new Card(); card._hass = {user:{name:'Test user'}};
  card.inboxData = {unread:1, items:[
    {id:'1', read:false, archived:false, result:{title:'Unread <img src=x>'}},
    {id:'2', read:true, archived:false, result:{title:'Read item'}},
    {id:'3', read:false, archived:true, result:{title:'Archived item'}},
  ]};
  card.inboxFilter = 'unread';
  assert.deepEqual(Array.from(card.inboxItems(), x=>x.id), ['1']);
  assert.ok(card.inbox().includes('&lt;img'));
  assert.ok(!card.inbox().includes('<img'));
  card.inboxFilter = 'all';
  assert.deepEqual(Array.from(card.inboxItems(), x=>x.id), ['1','2']);
  card.inboxFilter = 'archive';
  assert.ok(card.inbox().includes('Gendan'));
  assert.deepEqual(Array.from(card.inboxItems(), x=>x.id), ['3']);
});

test('failed save keeps the item and does not open it as read', async () => {
  const card = new Card(); const before={items:[{id:'1', read:false, result:{}}]};
  card.inboxData=before; card._hass={user:{id:'a'}, callApi:async()=>{throw Error('offline');}};
  let opened=false; card.reader=()=>{opened=true;}; card.render=()=>{};
  await card.readInbox('1');
  assert.equal(card.inboxData,before); assert.equal(opened,false);
  assert.match(card.inboxError,/ikke gemmes/); assert.equal(card.inboxUpdating,false);
});

test('older poll cannot undo a successful personal read', async () => {
  const card = new Card(); let finishPoll;
  card.loadGeneration=1;
  const owner={user:{id:'a'}, callApi:async(method)=>method==='GET'
    ? new Promise(resolve=>{finishPoll=resolve;}) : {items:[{id:'1',read:true}]}};
  card._hass=owner; card.render=()=>{};
  const pending=card.loadInbox(1,owner);
  await card.updateInbox('1','read');
  finishPoll({items:[{id:'1',read:false}]}); await pending;
  assert.equal(card.inboxData.items[0].read,true);
});

test('account switch discards the previous users in-flight response', async () => {
  const card = new Card(); let finish;
  const owner={user:{id:'a'},callApi:()=>new Promise(resolve=>{finish=resolve;})};
  card._hass=owner; card.loadGeneration=1;
  const pending=card.loadInbox(1,owner);
  card._hass={user:{id:'b'}}; card.inboxData=null;
  finish({items:[{id:'a-personal-state'}]}); await pending;
  assert.equal(card.inboxData,null);
});

