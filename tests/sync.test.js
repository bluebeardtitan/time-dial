'use strict';
/* Tests for the sync layer that ships inside index.html.
   The SyncCore block and the app's own norm()/validate() are extracted from the real file, so these tests
   exercise exactly the code that runs in the browser.   Run:  node --test tests/sync.test.js        */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const coreSrc = html.slice(html.indexOf('/* ==SYNC-CORE-BEGIN== */'), html.indexOf('/* ==SYNC-CORE-END== */'));
const SyncCore = new Function(coreSrc + '\nreturn SyncCore;')();
const { SyncError, createAuth, createDriveRemote, createSyncEngine, merge3 } = SyncCore;
const helpers = html.match(/const pad=n=>[^\n]*\n/)[0] + html.match(/const ymd=d=>[^\n]*\n/)[0];
const appSrc = html.slice(html.indexOf('const RD=/'), html.indexOf('function load(){'));
const app = new Function(helpers + appSrc + '\nreturn {norm, validate, validateSync};')();

/* ---------- harness ---------- */
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };
function makeClock(start = Date.parse('2026-10-10T10:00:00Z')) {
  let t = start, seq = 0, timers = [];
  return {
    now: () => t,
    setTimeout: (f, ms) => { const id = ++seq; timers.push({ id, at: t + ms, f }); return id; },
    clearTimeout: id => { timers = timers.filter(x => x.id !== id); },
    pending: () => timers.length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const n = timers[0];
        if (!n || n.at > end) break;
        timers.shift(); t = Math.max(t, n.at); n.f(); await flush();
      }
      t = end; await flush();
    },
  };
}
const iso = t => new Date(t).toISOString();

function makeRemote(clock) {
  const r = { file: null, version: 0, calls: { head: 0, download: 0, write: 0 }, concurrent: 0, maxConcurrent: 0, fault: null, gate: null };
  const view = () => ({ exists: true, fileId: 'F1', folderId: 'D1', version: String(r.version), md5: r.file.md5, modified: r.file.modified });
  const wrap = async (name, fn) => {
    r.calls[name]++; r.concurrent++; r.maxConcurrent = Math.max(r.maxConcurrent, r.concurrent);
    try {
      if (r.fault && (r.fault.on === name || r.fault.on === '*') && r.fault.times > 0) { r.fault.times--; throw r.fault.err(); }
      if (r.gate && name === 'write') await r.gate;
      await Promise.resolve();
      return fn();
    } finally { r.concurrent--; }
  };
  r.external = (text, modified) => { r.version++; r.file = { text, md5: SyncCore.hashStr(text), modified: iso(modified ?? clock.now()) }; };
  r.touch = () => { r.version++; };   /* metadata-only change: version moves, content (md5) does not */
  r.reset = () => { r.calls = { head: 0, download: 0, write: 0 }; r.maxConcurrent = 0; };
  r.head = () => wrap('head', () => r.file ? view() : { exists: false, fileId: '', folderId: '' });
  r.download = () => wrap('download', () => r.file.text);
  r.write = (ids, data) => wrap('write', () => { r.external(data); return view(); });
  return r;
}
function makeStore(db) { return { db, meta: null, base: null, backups: {}, applied: 0 }; }
function makeEnv(db, metaInit, config) {
  const clock = makeClock(), remote = makeRemote(clock), store = makeStore(db);
  store.meta = Object.assign({ connected: true, email: 'a@b.c', lastLocalChangeAt: clock.now() - 1e6 }, metaInit || {});
  const env = { clock, remote, store, online: true };
  env.engine = () => createSyncEngine({
    getLocal: () => store.db, normalize: app.norm, validate: app.validateSync, remote,
    now: clock.now, timers: clock, online: () => env.online, random: () => 0.5, config,
    loadMeta: () => store.meta ? JSON.parse(JSON.stringify(store.meta)) : null,
    saveMeta: m => { store.meta = JSON.parse(JSON.stringify(m)); },
    loadBase: () => store.base, saveBase: s => { store.base = s; },
    backup: (k, o) => { store.backups[k] = o; },
    applyLocal: o => { store.db = app.norm(o); store.applied++; },
  });
  return env;
}
const task = (id, title, x) => Object.assign({ id, title, date: '2026-10-10', time: '09:00' }, x);
const seed = () => app.norm({
  tasks: [task('A', 'Orig title'), task('Y', 'To delete'), task('W', 'Keep me')],
  habits: [{ id: 'H', title: 'Run', start: '2026-10-01', time: '07:00', repeat: 'daily', completions: ['2026-10-01'] }],
});
/* local state identical to remote -> baseline established with zero writes */
async function baselined(config) {
  const env = makeEnv(seed(), null, config);
  env.remote.external(JSON.stringify(seed()));
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.ok(env.store.meta.baseHash, 'baseline hash recorded');
  env.remote.reset(); env.store.applied = 0;
  return env;
}
const edit = (env, fn) => { fn(env.store.db); env.eng.noteLocalChange(); };

/* ---------- 1-2. OAuth ---------- */
function makeGis() {
  const g = { inits: 0, requests: [], script: [], cfg: null };
  g.oauth2 = { initTokenClient(cfg) {
    g.inits++; g.cfg = cfg;
    return { requestAccessToken(p) {
      g.requests.push(p); const b = g.script.shift() || {};
      setImmediate(() => { if (b.err) cfg.error_callback(b.err); else if (b.result) cfg.callback(b.result); });
    } };
  } };
  return g;
}
function makeAuth(g, clock, over) {
  const mem = { v: null };
  const a = createAuth(Object.assign({
    loadGis: () => Promise.resolve(g.oauth2), clientId: 'cid.apps.googleusercontent.com', scope: 'scope.a scope.b',
    now: clock.now, timers: clock, origin: 'https://user.github.io', protocol: 'https:', hostname: 'user.github.io',
    storage: { get: () => mem.v, set: v => { mem.v = v; }, remove: () => { mem.v = null; } },
  }, over));
  a.mem = mem; return a;
}
const OK = { result: { access_token: 'ya29.SECRET-TOKEN', expires_in: 3600 } };

test('1. OAuth succeeds with the configured client/origin; no redirect URI is involved; token is cached and reused', async () => {
  const clock = makeClock(), g = makeGis(), a = makeAuth(g, clock);
  g.script.push(OK);
  assert.equal(await a.getToken({ interactive: true }), 'ya29.SECRET-TOKEN');
  assert.equal(g.cfg.client_id, 'cid.apps.googleusercontent.com');
  assert.equal(g.cfg.scope, 'scope.a scope.b');
  assert.ok(!('redirect_uri' in g.cfg), 'the popup token flow must not be given a redirect_uri');
  assert.deepEqual(g.requests[0], { prompt: '' });
  await a.getToken(); await a.getToken({ interactive: true });
  assert.equal(g.requests.length, 1, 'cached token is reused');
  const b = makeAuth(g, clock, { storage: { get: () => a.mem.v, set() {}, remove() {} } });
  assert.equal(await b.getToken(), 'ya29.SECRET-TOKEN');
  assert.equal(g.requests.length, 1, 'a reload reuses the stored, unexpired token');
  await clock.advance(3600e3);          /* expired -> one silent refresh, same token client */
  g.script.push({ result: { access_token: 'ya29.NEW', expires_in: 3600 } });
  assert.equal(await a.getToken(), 'ya29.NEW');
  assert.deepEqual(g.requests[1], { prompt: 'none' });
  assert.equal(g.inits, 1, 'token client is initialised once');
});

test('1b. concurrent token requests share one popup/callback', async () => {
  const clock = makeClock(), g = makeGis(), a = makeAuth(g, clock);
  g.script.push(OK);
  const r = await Promise.all([a.getToken({ interactive: true }), a.getToken({ interactive: true }), a.getToken()]);
  assert.equal(new Set(r).size, 1);
  assert.equal(g.requests.length, 1);
});

test('2. OAuth failures give specific, actionable diagnostics and never leak tokens', async () => {
  const clock = makeClock();
  const run = async (script, opt, over) => {
    const g = makeGis(); g.script.push(script); const a = makeAuth(g, clock, over);
    let err; try { await a.getToken(opt); } catch (e) { err = e; } return { err, g, a };
  };
  let { err } = await run({ err: { type: 'popup_closed' } }, { interactive: true });
  assert.equal(err.code, 'AUTH_CLOSED'); assert.ok(err.needsAuth);
  assert.match(err.message, /https:\/\/user\.github\.io/); assert.match(err.message, /Authorized JavaScript origins/);
  ({ err } = await run({ err: { type: 'popup_failed_to_open' } }, { interactive: true }));
  assert.equal(err.code, 'AUTH_POPUP_BLOCKED'); assert.match(err.message, /pop-ups/);
  ({ err } = await run({ result: { error: 'access_denied' } }, { interactive: true }));
  assert.equal(err.code, 'AUTH_DENIED'); assert.match(err.message, /test user/);
  ({ err } = await run({ result: { error: 'redirect_uri_mismatch' } }, { interactive: true }));
  assert.equal(err.code, 'AUTH_CONFIG'); assert.match(err.message, /not used by this sign-in method/);
  ({ err } = await run({ result: { error: 'weird', error_description: 'bad access_token=ya29.LEAKY&x=1' } }, { interactive: true }));
  assert.ok(!/ya29|LEAKY/.test(err.message), 'tokens are scrubbed from messages');
  const f = await run(OK, { interactive: true }, { protocol: 'file:', origin: 'null' });
  assert.equal(f.err.code, 'AUTH_ORIGIN'); assert.equal(f.g.requests.length, 0);
  const h = await run(OK, { interactive: true }, { protocol: 'http:', hostname: 'example.com', origin: 'http://example.com' });
  assert.equal(h.err.code, 'AUTH_ORIGIN');
  const l = await run(OK, { interactive: true }, { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8080' });
  assert.ok(!l.err, 'http://localhost is allowed');
});

/* ---------- Drive adapter (fake Drive) ---------- */
const jr = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => body });
function fakeDrive() {
  const s = { folders: [], files: [], posts: 0, dropNextCreateResponse: false, seq: 0 };
  const meta = f => ({ id: f.id, version: String(f.version), md5Checksum: SyncCore.hashStr(f.text), modifiedTime: '2026-10-10T10:00:00Z', trashed: !!f.trashed });
  s.fetch = async (url, init = {}) => {
    const u = new URL(url), m = init.method || 'GET', p = u.pathname;
    if (m === 'GET' && p === '/drive/v3/files') {
      const q = u.searchParams.get('q'), name = q.match(/name='([^']*)'/)[1], parent = q.match(/'([^']*)' in parents/)[1];
      if (q.includes('google-apps.folder')) return jr(200, { files: s.folders.filter(f => f.name === name && f.parent === parent).map(f => ({ id: f.id, name: f.name })) });
      return jr(200, { files: s.files.filter(f => f.name === name && f.parent === parent && !f.trashed).map(meta) });
    }
    if (m === 'POST' && p === '/drive/v3/files') { const b = JSON.parse(init.body); const f = { id: 'fo' + (++s.seq), name: b.name, parent: b.parents[0] }; s.folders.push(f); return jr(200, { id: f.id }); }
    if (m === 'POST' && p === '/upload/drive/v3/files') {
      s.posts++; const parts = init.body.split('\r\n'); const meta0 = JSON.parse(parts[3]); const text = parts[7];
      const f = { id: 'fi' + (++s.seq), name: meta0.name, parent: meta0.parents[0], text, version: 1 }; s.files.push(f);
      if (s.dropNextCreateResponse) { s.dropNextCreateResponse = false; throw new TypeError('network down'); }
      return jr(200, meta(f));
    }
    const id = p.split('/').pop(), f = s.files.find(x => x.id === id);
    if (m === 'PATCH') { if (!f) return jr(404, { error: { message: 'not found' } }); f.text = init.body.split('\r\n')[7]; f.version++; return jr(200, meta(f)); }
    if (m === 'GET') { if (!f) return jr(404, { error: { message: 'not found' } }); return u.searchParams.get('alt') === 'media' ? jr(200, f.text) : jr(200, meta(f)); }
    return jr(500, 'unexpected');
  };
  return s;
}
const stubAuth = () => { const a = { tokens: 0, inv: 0, getToken: async () => 'tok' + (++a.tokens), invalidate() { a.inv++; } }; return a; };

test('Drive adapter: create is idempotent when a response is lost; stale file ids are re-resolved', async () => {
  const srv = fakeDrive(), drv = createDriveRemote({ fetch: srv.fetch, auth: stubAuth(), folder: 'MAK-Projects/Time-Dial-Sync', fileName: 'time-dial-data.json' });
  srv.dropNextCreateResponse = true;
  await assert.rejects(() => drv.write({ fileId: '', folderId: '' }, '{"a":1}', {}), e => e.code === 'NETWORK' && e.retryable);
  assert.equal(srv.files.length, 1);
  const res = await drv.write({ fileId: '', folderId: '' }, '{"a":2}', {});
  assert.equal(srv.files.length, 1, 'retry updated the existing file, no duplicate');
  assert.equal(srv.posts, 1); assert.equal(srv.files[0].text, '{"a":2}');
  assert.equal((await drv.head({ fileId: res.fileId, folderId: res.folderId }, {})).md5, SyncCore.hashStr('{"a":2}'));
  srv.files.length = 0;
  assert.equal((await drv.head({ fileId: res.fileId, folderId: res.folderId }, {})).exists, false);
});

test('Drive adapter: 401 refreshes once then asks for sign-in; transient vs permanent errors are classified; secrets are scrubbed', async () => {
  const mk = handler => { const auth = stubAuth(); return { auth, drv: createDriveRemote({ fetch: handler, auth, folder: 'f', fileName: 'n' }) }; };
  let n = 0;
  let t = mk(async () => (++n === 1 ? jr(401, 'no') : jr(200, { id: 'x', version: 2, md5Checksum: 'm', modifiedTime: 'z' })));
  assert.equal((await t.drv.head({ fileId: 'x', folderId: 'd' }, {})).exists, true); assert.equal(t.auth.inv, 1);
  t = mk(async () => jr(401, 'no'));
  await assert.rejects(() => t.drv.head({ fileId: 'x', folderId: 'd' }, {}), e => e.code === 'AUTH_EXPIRED' && e.needsAuth);
  assert.equal(t.auth.tokens, 2, 'exactly one refresh attempt, no loop');
  const code = async (resp, ex) => { t = mk(ex || (async () => resp)); try { await t.drv.download('x', {}); } catch (e) { return e; } };
  let e = await code(jr(503, 'x')); assert.ok(e.retryable && !e.needsAuth);
  e = await code(jr(429, 'x')); assert.ok(e.retryable);
  e = await code(jr(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}],"message":"slow"}}')); assert.equal(e.code, 'RATE_LIMIT'); assert.ok(e.retryable);
  e = await code(jr(403, '{"error":{"errors":[{"reason":"insufficientPermissions"}],"message":"no"}}')); assert.ok(e.needsAuth && !e.retryable);
  e = await code(jr(400, '{"error":{"message":"bad Bearer ya29.LEAK"}}')); assert.ok(!e.retryable && !/ya29|LEAK/.test(e.message));
  e = await code(null, async () => { throw new TypeError('Failed to fetch'); }); assert.equal(e.code, 'NETWORK'); assert.ok(e.retryable);
  e = await code(null, async () => { const x = new Error('a'); x.name = 'AbortError'; throw x; }); assert.equal(e.code, 'TIMEOUT');
});

/* ---------- 3-5. first launch ---------- */
test('3. first launch downloads a demonstrably newer remote version (local kept as backup)', async () => {
  const env = makeEnv(app.norm({ tasks: [task('l1', 'Local')] }));
  env.store.meta.lastLocalChangeAt = env.clock.now() - 3600e3;
  env.remote.external(JSON.stringify(app.norm({ tasks: [task('r1', 'Remote')] })));
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.deepEqual(env.store.db.tasks.map(t => t.id), ['r1']);
  assert.equal(env.remote.calls.write, 0);
  assert.deepEqual(env.store.backups.local.tasks.map(t => t.id), ['l1']);
  assert.equal(env.eng.status().pending, false);
});

test('4. first launch preserves newer local data and uploads it', async () => {
  const env = makeEnv(app.norm({ tasks: [task('l1', 'Local')] }));
  env.store.meta.lastLocalChangeAt = env.clock.now() - 60e3;
  env.remote.external(JSON.stringify(app.norm({ tasks: [task('r1', 'Remote')] })), env.clock.now() - 3600e3);
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.deepEqual(env.store.db.tasks.map(t => t.id), ['l1']);
  assert.equal(env.remote.calls.write, 1);
  assert.deepEqual(JSON.parse(env.remote.file.text).tasks.map(t => t.id), ['l1']);
  assert.deepEqual(env.store.backups.remote.tasks.map(t => t.id), ['r1'], 'overwritten remote snapshot is kept');
});

test('4b. first launch with an empty local store initialises from the remote', async () => {
  const env = makeEnv(app.norm({}));
  env.remote.external(JSON.stringify(seed()));
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.equal(env.store.db.tasks.length, 3); assert.equal(env.remote.calls.write, 0);
});

test('4c. first launch with unknown/ambiguous ordering merges instead of overwriting either side', async () => {
  const env = makeEnv(app.norm({ tasks: [task('l1', 'Local')] }), { lastLocalChangeAt: 0 });
  env.remote.external(JSON.stringify(app.norm({ tasks: [task('r1', 'Remote')] })));
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.deepEqual(env.store.db.tasks.map(t => t.id).sort(), ['l1', 'r1']);
  assert.deepEqual(JSON.parse(env.remote.file.text).tasks.map(t => t.id).sort(), ['l1', 'r1']);
});

test('5. identical local and remote: no write, no upload, no local rewrite, no further traffic', async () => {
  const env = makeEnv(seed()); env.remote.external(JSON.stringify(seed()));
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.equal(env.remote.calls.write, 0); assert.equal(env.store.applied, 0);
  assert.equal(env.remote.calls.download, 1);
  await env.clock.advance(3600e3);
  assert.deepEqual(env.remote.calls, { head: 1, download: 1, write: 0 });
});

test('5b. remote that differs from local only by schema defaults counts as identical (no upload, no rewrite)', async () => {
  const raw = { tasks: [{ id: 'old', title: 'Old schema', date: '2026-10-10', time: '09:00' }] };
  const env = makeEnv(app.norm(raw)); env.remote.external(JSON.stringify(raw));
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.equal(env.remote.calls.write, 0); assert.equal(env.store.applied, 0);
  assert.ok(env.store.meta.baseHash);
});

/* ---------- 6-10. steady state ---------- */
test('6. a genuine local change triggers exactly one synchronization', async () => {
  const env = await baselined();
  edit(env, db => { db.tasks[0].title = 'Changed'; });
  assert.equal(env.eng.status().pending, true);
  await env.clock.advance(2400); assert.equal(env.remote.calls.write, 0, 'debounced');
  await env.clock.advance(200); assert.equal(env.remote.calls.write, 1);
  assert.equal(JSON.parse(env.remote.file.text).tasks[0].title, 'Changed');
  assert.equal(env.eng.status().pending, false);
  await env.clock.advance(86400e3); assert.equal(env.remote.calls.write, 1);
});

test('6b. a change that is reverted before the debounce fires uploads nothing', async () => {
  const env = await baselined();
  edit(env, db => { db.tasks[0].title = 'Temp'; });
  edit(env, db => { db.tasks[0].title = 'Orig title'; });
  assert.equal(env.eng.status().pending, false);
  await env.clock.advance(60e3); assert.deepEqual(env.remote.calls, { head: 0, download: 0, write: 0 });
});

test('7. no local changes means no repeated uploads; focus/visibility checks are throttled metadata reads', async () => {
  const env = await baselined();
  for (let i = 0; i < 50; i++) env.eng.probe();                       /* burst of focus events */
  await flush(); assert.equal(env.remote.calls.head, 0, 'within the throttle window nothing is requested');
  for (let m = 1; m <= 60; m++) { await env.clock.advance(60e3); env.eng.probe(); await flush(); }
  assert.equal(env.remote.calls.write, 0); assert.equal(env.remote.calls.download, 0);
  assert.ok(env.remote.calls.head <= 12, 'at most one metadata read per 5 minutes, got ' + env.remote.calls.head);
});

test('8. applying remote changes does not trigger an upload loop', async () => {
  const env = await baselined();
  const r = seed(); r.tasks.push(task('N', 'New remote')); env.remote.external(JSON.stringify(app.norm(r)));
  await env.clock.advance(6 * 60e3); env.eng.probe(); await flush();
  assert.equal(env.store.applied, 1); assert.equal(env.store.db.tasks.length, 4);
  env.eng.noteLocalChange();                                           /* even if a change hook fires after applying */
  assert.equal(env.eng.status().pending, false); assert.equal(env.clock.pending(), 0);
  await env.clock.advance(3600e3); assert.equal(env.remote.calls.write, 0);
});

test('8b. remote data written without schema defaults does not bounce back as a "local change"', async () => {
  const env = await baselined();
  env.remote.external(JSON.stringify({ tasks: [{ id: 'old', title: 'Old schema', date: '2026-10-10', time: '09:00' }] }));
  await env.clock.advance(6 * 60e3); env.eng.probe(); await flush();
  assert.equal(env.store.db.tasks[0].priority, 'normal', 'defaults were added locally');
  await env.clock.advance(3600e3); assert.equal(env.remote.calls.write, 0);
  assert.equal(env.eng.status().pending, false);
});

test('9. rapid edits are coalesced into a single upload of the final state', async () => {
  const env = await baselined();
  for (let i = 1; i <= 10; i++) { edit(env, db => { db.tasks[0].title = 'v' + i; }); await env.clock.advance(100); }
  assert.equal(env.remote.calls.write, 0);
  await env.clock.advance(3000);
  assert.equal(env.remote.calls.write, 1); assert.equal(JSON.parse(env.remote.file.text).tasks[0].title, 'v10');
});

test('10. many simultaneous triggers never run concurrent sync operations; edits made mid-sync are sent afterwards', async () => {
  const env = await baselined();
  let release; env.remote.gate = new Promise(r => { release = r; });
  edit(env, db => { db.tasks[0].title = 'first'; });
  await env.clock.advance(2500); assert.equal(env.remote.calls.write, 1);
  const ps = [1, 2, 3, 4, 5].map(() => env.eng.requestSync({ reason: 'x' })); env.eng.probe(); env.eng.onOnline();
  edit(env, db => { db.tasks[0].title = 'second'; });
  env.remote.gate = null; release(); await Promise.all(ps); await env.clock.advance(3000);
  assert.equal(env.remote.maxConcurrent, 1);
  assert.equal(env.remote.calls.write, 2, 'one upload per genuine change');
  assert.equal(JSON.parse(env.remote.file.text).tasks[0].title, 'second');
  assert.equal(env.eng.status().pending, false);
});

/* ---------- 11. failures ---------- */
test('11. a failed upload stays pending and is retried safely; retries are bounded', async () => {
  let env = await baselined();
  env.remote.fault = { on: 'write', times: 1, err: () => new SyncError('NETWORK', 'down', { retryable: true }) };
  const before = env.store.meta.baseHash;
  edit(env, db => { db.tasks[0].title = 'edited'; });
  await env.clock.advance(2500);
  assert.equal(env.remote.calls.write, 1); assert.equal(env.store.meta.baseHash, before, 'not marked synced');
  assert.equal(env.eng.status().pending, true); assert.equal(env.eng.status().failure.code, 'NETWORK');
  await env.clock.advance(1500);                                       /* base 2s * jitter 0.75 */
  assert.equal(env.remote.calls.write, 2); assert.equal(JSON.parse(env.remote.file.text).tasks[0].title, 'edited');
  assert.equal(env.eng.status().pending, false); assert.equal(env.eng.status().failure, null);

  env = await baselined();
  env.remote.fault = { on: 'write', times: Infinity, err: () => new SyncError('HTTP_503', 'busy', { retryable: true }) };
  edit(env, db => { db.tasks[0].title = 'edited'; });
  await env.clock.advance(86400e3);
  assert.equal(env.remote.calls.write, 6, '1 attempt + 5 backoff retries, then it stops');
  assert.equal(env.eng.status().paused, true); assert.equal(env.clock.pending(), 0);
  await env.clock.advance(7 * 86400e3); assert.equal(env.remote.calls.write, 6, 'no automatic retries after pausing');
  assert.equal(env.store.db.tasks[0].title, 'edited', 'local data intact');
  env.remote.fault = null; await env.eng.requestSync({ interactive: true });
  assert.equal(env.remote.calls.write, 7); assert.equal(env.eng.status().pending, false);
});

test('11b. merge + failed upload: base becomes the remote content, so the retry is a plain upload', async () => {
  const env = await baselined();
  env.remote.external(JSON.stringify(app.norm((() => { const r = seed(); r.tasks[0].notes = 'remote'; return r; })())));
  env.remote.fault = { on: 'write', times: 1, err: () => new SyncError('NETWORK', 'down', { retryable: true }) };
  edit(env, db => { db.tasks[1].title = 'local edit'; });
  await env.clock.advance(2500);
  assert.equal(env.store.db.tasks[0].notes, 'remote', 'remote change already merged locally');
  assert.equal(env.eng.status().pending, true);
  await env.clock.advance(1500);
  const f = JSON.parse(env.remote.file.text);
  assert.equal(f.tasks[0].notes, 'remote'); assert.equal(f.tasks[1].title, 'local edit');
  assert.equal(env.remote.calls.download, 1, 'retry did not re-download');
});

/* ---------- 12-13. restart, other devices ---------- */
test('12. restarting the app does not trigger a full sync', async () => {
  const env = await baselined();
  env.eng.dispose();
  await env.clock.advance(60e3);
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.deepEqual(env.remote.calls, { head: 0, download: 0, write: 0 }, 'recent check -> no network at all');
  env.eng.dispose(); await env.clock.advance(10 * 60e3);
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.deepEqual(env.remote.calls, { head: 1, download: 0, write: 0 }, 'stale check -> a single metadata read');
  env.eng.dispose(); edit({ store: env.store, eng: { noteLocalChange() {} } }, db => { db.tasks[0].title = 'offline edit'; });
  env.eng = env.engine(); env.eng.start(); await flush();
  assert.equal(env.remote.calls.write, 1, 'a pending change from before the restart is uploaded');
});

test('13. changes made on another device are detected and incorporated without uploading anything', async () => {
  const env = await baselined();
  const r = seed(); r.tasks[0].title = 'From phone'; env.remote.external(JSON.stringify(app.norm(r)));
  await env.clock.advance(6 * 60e3); env.eng.probe(); await flush();
  assert.equal(env.store.db.tasks[0].title, 'From phone');
  assert.equal(env.remote.calls.write, 0); assert.equal(env.remote.calls.download, 1);
  env.remote.touch();                                                  /* version bump, same bytes */
  await env.clock.advance(6 * 60e3); env.eng.probe(); await flush();
  assert.equal(env.remote.calls.download, 1, 'unchanged md5 -> no download');
});

/* ---------- 14. conflicts ---------- */
test('14. simultaneous local and remote edits follow the documented merge policy and lose nothing silently', async () => {
  const env = await baselined();
  const r = seed();
  r.tasks[0].title = 'Remote title'; r.tasks[0].notes = 'remote note';
  r.tasks = r.tasks.filter(t => t.id !== 'Y' && t.id !== 'W'); r.tasks.push(task('Z', 'Remote new'));
  r.habits[0].completions = ['2026-10-01', '2026-10-03'];
  env.remote.external(JSON.stringify(app.norm(r)));
  edit(env, db => {
    db.tasks[0].title = 'Local title'; db.tasks.push(task('X', 'Local new'));
    db.tasks.find(t => t.id === 'W').title = 'Local W';
    db.habits[0].completions.push('2026-10-02');
  });
  await env.clock.advance(2500);
  const by = id => env.store.db.tasks.find(t => t.id === id);
  assert.equal(by('A').title, 'Local title', 'same-field conflict: local wins');
  assert.equal(by('A').notes, 'remote note', 'non-conflicting remote field kept');
  assert.ok(by('X') && by('Z'), 'additions from both sides kept');
  assert.equal(by('Y'), undefined, 'remote deletion of an untouched item applied');
  assert.equal(by('W').title, 'Local W', 'an edit beats a delete');
  assert.deepEqual(env.store.db.habits[0].completions, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(env.remote.calls.write, 1);
  assert.equal(SyncCore.canon(app.norm(JSON.parse(env.remote.file.text))), SyncCore.canon(env.store.db));
  assert.equal(env.store.backups.remote.tasks.find(t => t.id === 'A').title, 'Remote title', 'losing remote values are preserved');
  assert.equal(env.eng.status().pending, false);
  await env.clock.advance(3600e3); assert.equal(env.remote.calls.write, 1);
});

test('14b. merge3 unit behaviour', () => {
  const t = (id, title) => ({ id, title });
  assert.deepEqual(merge3(null, { tasks: [t('a', 'L')] }, { tasks: [t('b', 'R')] }).tasks.map(x => x.id), ['a', 'b']);
  const base = { habits: [{ id: 'h', completions: ['1', '2'] }] };
  const out = merge3(base, { habits: [{ id: 'h', completions: ['1', '2', '3'] }] }, { habits: [{ id: 'h', completions: ['1', '4'] }] });
  assert.deepEqual(out.habits[0].completions.sort(), ['1', '3', '4'], 'removed by remote, added by both');
  assert.deepEqual(merge3(base, base, { habits: [] }).habits, [], 'untouched local yields to a remote delete');
});

/* ---------- 15. offline / expired token ---------- */
test('15a. offline: no requests, no timers, changes stay pending, resumes once when back online', async () => {
  const env = await baselined(); env.online = false;
  edit(env, db => { db.tasks[0].title = 'offline'; });
  await env.clock.advance(86400e3);
  assert.deepEqual(env.remote.calls, { head: 0, download: 0, write: 0 });
  assert.equal(env.eng.status().pending, true); assert.equal(env.clock.pending(), 0);
  env.online = true; env.eng.onOnline(); await flush();
  assert.equal(env.remote.calls.write, 1); assert.equal(env.eng.status().pending, false);
});

test('15b. expired credentials: sign-in is requested once, background work stops, nothing is lost, recovery works', async () => {
  const env = await baselined();
  env.remote.fault = { on: '*', times: Infinity, err: () => new SyncError('AUTH_EXPIRED', 'expired', { needsAuth: true }) };
  edit(env, db => { db.tasks[0].title = 'kept'; });
  await env.clock.advance(2500);
  assert.equal(env.eng.status().needsAuth, true);
  const calls = env.remote.calls.head;
  for (let i = 0; i < 5; i++) { edit(env, db => { db.tasks[0].title = 'kept' + i; }); await env.clock.advance(10 * 60e3); env.eng.probe(); env.eng.onOnline(); }
  await env.clock.advance(86400e3);
  assert.equal(env.remote.calls.head, calls, 'no further attempts while sign-in is needed');
  assert.equal(env.store.db.tasks[0].title, 'kept4'); assert.equal(env.eng.status().pending, true);
  env.remote.fault = null; env.eng.authRestored(); const r = await env.eng.requestSync({ interactive: true });
  assert.equal(r.status, 'pushed'); assert.equal(JSON.parse(env.remote.file.text).tasks[0].title, 'kept4');
});

test('15c. an unreadable remote copy is never overwritten or applied; local data is untouched', async () => {
  const env = await baselined();
  env.remote.external('{ not json'); edit(env, db => { db.tasks[0].title = 'mine'; });
  await env.clock.advance(2500);
  assert.equal(env.remote.calls.write, 0); assert.equal(env.eng.status().failure.code, 'REMOTE_INVALID');
  assert.equal(env.store.db.tasks[0].title, 'mine'); assert.equal(env.eng.status().paused, true);
});

test('16. deleting everything is a valid state that syncs both ways', async () => {
  const env = await baselined();
  edit(env, db => { db.tasks.length = 0; db.habits.length = 0; });
  await env.clock.advance(2500);
  assert.equal(env.remote.calls.write, 1); assert.equal(JSON.parse(env.remote.file.text).tasks.length, 0);
  assert.equal(app.validateSync(JSON.parse(env.remote.file.text)), '');
  const e2 = await baselined(); e2.remote.external(JSON.stringify(app.norm({})));
  await e2.clock.advance(6 * 60e3); e2.eng.probe(); await flush();
  assert.equal(e2.store.db.tasks.length, 0); assert.equal(e2.remote.calls.write, 0);
});

test('17. disconnect stops all sync activity and keeps local data', async () => {
  const env = await baselined();
  edit(env, db => { db.tasks[0].title = 'pending'; });
  env.eng.disconnect(); await env.clock.advance(86400e3);
  assert.deepEqual(env.remote.calls, { head: 0, download: 0, write: 0 });
  assert.equal(env.store.db.tasks[0].title, 'pending'); assert.equal(env.eng.status().connected, false);
  assert.equal(env.store.base, null);
});
