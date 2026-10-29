import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, READ_TOOLS, aulaTimestamp } from '../deploy/ha-gateway.mjs';

const secret = 'test-only-key-with-at-least-32-characters';
const manifest = { children: [{ id: 42, name: 'Test Child', institution: { code: 'TEST' } }],
  tokens: { hidden: 'must-not-reach-ha' }, capabilities: {
    ugeplan: { tools: ['aula.ugeplan.meebook'] },
    opgaver: { tools: ['aula.opgaver.minuddannelse'], notes: 'widget not detected' },
  } };

function mockMcp() {
  const calls = []; let failCalendar = false; let session = 0;
  const sessions = new Map();
  const fetcher = async (_url, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(options.body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') {
      const id = String(++session); sessions.set(id, false);
      return Response.json({ result: {} }, { headers: { 'mcp-session-id': id } });
    }
    const id = options.headers['Mcp-Session-Id'];
    assert.ok(id, 'subsequent requests carry the session');
    if (body.method === 'tools/list') {
      assert.equal(sessions.get(id), true, 'discovery before tools');
      return Response.json({ result: { tools: [...READ_TOOLS, 'aula.raw_request', 'aula.messages.mark_read'].map(name => ({ name })) } });
    }
    const { name, arguments: args } = body.params; calls.push({ name, args });
    let data;
    if (name === 'aula.discover') { assert.equal(sessions.get(id), false); sessions.set(id, true); data = manifest; }
    else {
      assert.equal(sessions.get(id), true, 'discover once before reads');
      if (name === 'aula.calendar.events' && failCalendar) return Response.json({ result: { isError: true } });
      data = name === 'aula.posts.list' ? [{ id: 7, attachments: [{ name: 'test.pdf', url: 'https://example.com/known.pdf' }] }] : [{ id: 1 }];
    }
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
  };
  return { calls, fetcher, fail: () => { failCalendar = true; } };
}
async function gateway(t, options = {}) {
  const mock = mockMcp(); const server = createGateway({ secret, fetcher: mock.fetcher, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, auth = true) => fetch(base + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(auth ? { Authorization: `Bearer ${secret}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, mock };
}
test('fails closed without a long separate secret', () => {
  assert.throws(() => createGateway({ secret: '' }));
  assert.throws(() => createGateway({ secret: 'short' }));
});
test('all routes require authentication before contacting MCP', async t => {
  const { request, mock } = await gateway(t);
  for (const path of ['status', 'snapshot', 'tools', 'files/anything']) {
    assert.equal((await request(path, undefined, false)).status, 401);
  }
  assert.equal((await request('call', { name: 'aula.discover' }, false)).status, 401);
  assert.equal(mock.calls.length, 0);
});
test('write and raw tools are denied; tool discovery returns exactly 19 safe tools', async t => {
  const { request, mock } = await gateway(t);
  for (const name of ['aula.raw_request', 'aula.messages.mark_read', 'aula.presence.report_sick']) {
    assert.equal((await request('call', { name })).status, 403);
  }
  assert.equal(mock.calls.length, 0);
  const tools = await (await request('tools')).json();
  assert.equal(tools.length, 19);
  const pdf = tools.find(x => x.name === 'aula.utils.extract_pdf_text');
  assert.deepEqual(pdf.inputSchema.required, ['attachment_id']);
  assert.equal(pdf.inputSchema.properties.path, undefined);
});
test('snapshot cache preserves source status and removes token metadata', async t => {
  const { request, mock } = await gateway(t);
  const first = await (await request('snapshot')).json();
  const count = mock.calls.length;
  const second = await (await request('snapshot')).json();
  assert.deepEqual(first, second); assert.equal(mock.calls.length, count);
  assert.equal(first.manifest.tokens, undefined);
  assert.equal(first.sections.calendar.status, 'ok');
  assert.equal(first.sections.opgaver.status, 'unsupported');
  assert.equal(mock.calls.filter(x => x.name === 'aula.discover').length, 1);
  assert.deepEqual(mock.calls.find(x => x.name === 'aula.calendar.events').args.profileIds, [42]);
  assert.equal(mock.calls.some(x => x.name === 'aula.opgaver.minuddannelse'), false);
  const manifestResult = await (await request('call', { name: 'aula.discover' })).json();
  assert.equal(manifestResult.tokens, undefined);
});
test('a failed source keeps old data explicitly stale instead of fabricating empty data', async t => {
  const { request, mock } = await gateway(t, { ttl: -1 });
  const old = await (await request('snapshot')).json(); mock.fail();
  const next = await (await request('snapshot')).json();
  assert.equal(next.sections.calendar.status, 'error');
  assert.equal(next.sections.calendar.stale, true);
  assert.deepEqual(next.sections.calendar.data, old.sections.calendar.data);
  assert.equal(next.sections.presence.status, 'ok');
});
test('arbitrary local PDF paths and attachment URLs never reach MCP', async t => {
  const { request, mock } = await gateway(t);
  assert.equal((await request('call', { name: 'aula.utils.extract_pdf_text', arguments: { path: '/etc/passwd' } })).status, 502);
  assert.equal((await request('call', { name: 'aula.posts.get_attachment', arguments: { postId: 7, url: 'http://127.0.0.1/secret' } })).status, 502);
  assert.equal(mock.calls.length, 0);
});
test('malformed requests do not become upstream requests', async t => {
  const { request, mock } = await gateway(t);
  assert.equal((await request('call', null)).status, 400);
  assert.equal((await request('call', { name: 'aula.discover', arguments: [] })).status, 400);
  assert.equal(mock.calls.length, 0);
});
test('Aula timestamps honor Danish daylight-saving transitions', () => {
  assert.equal(aulaTimestamp(new Date('2026-10-24T12:00:00Z')), '2026-10-24 14:00:00.0000+0200');
  assert.equal(aulaTimestamp(new Date('2026-10-25T12:00:00Z')), '2026-10-25 13:00:00.0000+0100');
});
