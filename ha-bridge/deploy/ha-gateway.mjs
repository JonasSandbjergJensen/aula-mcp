import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Explicitly reviewed read operations. New upstream tools are denied by default.
export const READ_TOOLS = new Set([
  'aula.discover', 'aula.profiles.list', 'aula.calendar.events',
  'aula.presence.today', 'aula.presence.templates',
  'aula.messages.list_threads', 'aula.messages.get_thread',
  'aula.messages.get_attachment', 'aula.notifications.list',
  'aula.posts.list', 'aula.posts.get_attachment',
  'aula.ugeplan.easyiq', 'aula.ugeplan.meebook',
  'aula.ugeplan.easyiq_skoleportal', 'aula.lektier.easyiq',
  'aula.opgaver.minuddannelse', 'aula.ugebrev.minuddannelse',
  'aula.huskelisten.systematic', 'aula.utils.extract_pdf_text',
]);
export function authorized(header, secret) {
  if (!secret || secret.length < 32 || typeof header !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(header).digest(),
    createHash('sha256').update(`Bearer ${secret}`).digest());
}
export function unpack(result) {
  if (result.isError) throw new Error('upstream_tool_error');
  const text = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
export class McpConnection {
  constructor(url, fetcher = fetch) { this.url = url; this.fetcher = fetcher; this.session = null; this.id = 0; }
  async rpc(method, params, notification = false) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) {
      headers['Mcp-Session-Id'] = this.session;
      headers['MCP-Protocol-Version'] = '2025-03-26';
    }
    const payload = { jsonrpc: '2.0', method, params };
    if (!notification) payload.id = ++this.id;
    const res = await this.fetcher(this.url, { method: 'POST', headers,
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`mcp_http_${res.status}`);
    this.session = res.headers.get('mcp-session-id') || this.session;
    if (notification || res.status === 202 || res.status === 204) return null;
    const body = await res.json();
    if (body.error) throw new Error('mcp_rpc_error');
    return body.result;
  }
  async connect() {
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'aula-ha-bridge', version: '0.1.0' } });
    await this.rpc('notifications/initialized', {}, true);
    this.manifest = unpack(await this.rpc('tools/call', { name: 'aula.discover', arguments: {} }));
  }
  async close() {
    if (!this.session) return;
    try { await this.fetcher(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session },
      signal: AbortSignal.timeout(3000) }); } catch {}
    this.session = null;
  }
  async call(name, args = {}) {
    if (!READ_TOOLS.has(name)) throw new Error('tool_not_allowed');
    if (!this.session) await this.connect();
    if (name === 'aula.discover') return this.manifest;
    return unpack(await this.rpc('tools/call', { name, arguments: args }));
  }
}
export function aulaTimestamp(date) {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'longOffset' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const offset = p.timeZoneName.replace('GMT', '').replace(':', '') || '+0000';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.0000${offset}`;
}
export function snapshotPlan(manifest, now = new Date()) {
  const children = manifest.children || [];
  const childIds = children.map(x => x.id);
  const institutionCodes = [...new Set(children.map(x => x.institution.code))];
  const plan = [
    ['profiles', 'aula.profiles.list', {}],
    ['calendar', 'aula.calendar.events', { profileIds: childIds,
      start: aulaTimestamp(now), end: aulaTimestamp(new Date(+now + 30 * 86400000)) }],
    ['presence', 'aula.presence.today', { childIds }],
    ['presence_templates', 'aula.presence.templates', { childIds }],
    ['messages', 'aula.messages.list_threads', { page: 0 }],
    ['notifications', 'aula.notifications.list', {}],
    ['posts', 'aula.posts.list', { index: 0, limit: 20 }],
  ];
  for (const key of ['ugeplan', 'opgaver', 'ugebrev', 'huskelisten', 'lektier']) {
    const capability = manifest.capabilities?.[key];
    const tool = capability?.tools?.[0];
    const unavailable = !tool || /not detected/i.test(capability?.notes || '');
    plan.push([key, unavailable ? null : tool, { childIds, institutionCodes }]);
  }
  return plan;
}
export function createGateway({ secret, mcpUrl = 'http://127.0.0.1:7878/mcp', fetcher = fetch, ttl = 300000 }) {
  if (!secret || secret.length < 32) throw new Error('AULA_HA_TOKEN must contain at least 32 characters');
  let cache = null, inFlight = null, serial = Promise.resolve();
  const files = new Map();
  const postAttachments = new Map();
  function rememberPosts(data) {
    for (const post of Array.isArray(data) ? data : data?.posts || data?.items || []) {
      for (const file of post.attachments || []) {
        if (typeof file.url === 'string') postAttachments.set(`${post.id}:${file.url}`, Date.now() + 3600000);
      }
    }
    for (const [id, expires] of postAttachments) if (expires < Date.now()) postAttachments.delete(id);
    while (postAttachments.size > 1000) postAttachments.delete(postAttachments.keys().next().value);
  }
  function exclusive(fn) {
    const work = serial.then(fn, fn); serial = work.catch(() => {}); return work;
  }
  async function connection(fn) {
    const mcp = new McpConnection(mcpUrl, fetcher);
    try { await mcp.connect(); return await fn(mcp); } finally { await mcp.close(); }
  }
  async function snapshot() {
    if (cache && Date.now() - Date.parse(cache.fetched_at) < ttl) return cache;
    if (inFlight) return inFlight;
    inFlight = exclusive(() => connection(async mcp => {
      const previous = cache;
      const manifest = structuredClone(mcp.manifest);
      delete manifest.tokens; // No credentials or token metadata in HA.
      const sections = {};
      for (const [key, tool, args] of snapshotPlan(manifest)) {
        if (!tool) { sections[key] = { status: 'unsupported', data: null }; continue; }
        try {
          const data = await mcp.call(tool, args);
          if (data?.error) throw new Error('source_error');
          if (tool === 'aula.posts.list') rememberPosts(data);
          sections[key] = { status: 'ok', fetched_at: new Date().toISOString(), data,
            coverage: key === 'calendar' ? '30 days' : key === 'messages' ? 'page 0; older pages on demand' :
              key === 'posts' ? 'latest 20; older posts on demand' : 'provider response' };
        } catch {
          sections[key] = { status: 'error', error: 'source_unavailable',
            fetched_at: previous?.sections?.[key]?.fetched_at || null,
            data: previous?.sections?.[key]?.data ?? null,
            stale: previous?.sections?.[key]?.data != null };
        }
      }
      cache = { schema_version: 1, fetched_at: new Date().toISOString(), manifest, sections,
        completeness: 'Latest data, not a complete historical archive. All read tools available on demand.' };
      return cache;
    })).finally(() => { inFlight = null; });
    return inFlight;
  }
  async function call(name, args) {
    if (!READ_TOOLS.has(name)) throw new Error('tool_not_allowed');
    args = { ...args };
    // Accept only attachment URLs already returned by the authenticated Aula feed.
    // This prevents the gateway from becoming an arbitrary URL fetcher.
    if (name === 'aula.posts.get_attachment' &&
        !(postAttachments.get(`${args.postId}:${args.url}`) > Date.now())) {
      throw new Error('unknown_post_attachment');
    }
    if (name === 'aula.utils.extract_pdf_text') {
      const file = files.get(args.attachment_id);
      if (!file || file.expires < Date.now()) throw new Error('attachment_expired');
      args = { path: file.path };
    }
    return exclusive(() => connection(async mcp => {
      const data = await mcp.call(name, args);
      if (name === 'aula.posts.list') rememberPosts(data);
      if (name === 'aula.discover') { const manifest = structuredClone(data); delete manifest.tokens; return manifest; }
      if (name.endsWith('.get_attachment') && data?.ok && data.path) {
        const path = await realpath(data.path);
        if (!path.startsWith('/tmp/aula-attachments/')) throw new Error('invalid_attachment_path');
        for (const [id, file] of files) if (file.expires < Date.now()) files.delete(id);
        if (files.size >= 100) files.delete(files.keys().next().value);
        const id = randomUUID(); files.set(id, { path, expires: Date.now() + 3600000, name: data.filename });
        return { attachment_id: id, filename: data.filename, bytes: data.bytes, mediaType: data.mediaType };
      }
      return data;
    }));
  }
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
  const server = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, secret)) return json(res, 401, { error: 'unauthorized' });
    try {
      const url = new URL(req.url, 'http://gateway');
      if (req.method === 'GET' && url.pathname === '/api/v1/status') return json(res, 200, { ok: true, version: '0.1.0' });
      if (req.method === 'GET' && url.pathname === '/api/v1/snapshot') return json(res, 200, await snapshot());
      if (req.method === 'GET' && url.pathname === '/api/v1/tools') {
        return json(res, 200, await exclusive(() => connection(async mcp => {
          const result = await mcp.rpc('tools/list', {});
          return result.tools.filter(tool => READ_TOOLS.has(tool.name)).map(tool =>
            tool.name === 'aula.utils.extract_pdf_text' ? { ...tool,
              description: 'Extract text from a downloaded PDF using its temporary attachment_id.',
              inputSchema: { type: 'object', properties: { attachment_id: { type: 'string' } },
                required: ['attachment_id'], additionalProperties: false } } : tool);
        })));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/v1/files/')) {
        const id = url.pathname.split('/').pop(); const file = files.get(id);
        if (!file || file.expires < Date.now()) return json(res, 404, { error: 'attachment_expired' });
        const bytes = await readFile(file.path);
        if (bytes.length > 50 * 1024 * 1024) return json(res, 413, { error: 'file_too_large' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
        return res.end(bytes);
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/call') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) return json(res, 413, { error: 'body_too_large' }); }
        let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid_json' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid_request' });
        if (!READ_TOOLS.has(body.name)) return json(res, 403, { error: 'tool_not_allowed' });
        if (body.arguments != null && (typeof body.arguments !== 'object' || Array.isArray(body.arguments))) return json(res, 400, { error: 'invalid_arguments' });
        return json(res, 200, await call(body.name, body.arguments || {}));
      }
      return json(res, 404, { error: 'not_found' });
    } catch { return json(res, 502, { error: 'aula_upstream_unavailable' }); }
  });
  server.requestTimeout = 180000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway({ secret: process.env.AULA_HA_TOKEN });
  const host = process.env.AULA_HA_HOST || '127.0.0.1';
  const port = Number(process.env.AULA_HA_PORT || process.env.PORT || 8081);
  server.listen(port, host, () => console.log(`Aula HA gateway listening on ${host}:${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
