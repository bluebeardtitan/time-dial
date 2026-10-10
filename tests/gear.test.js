'use strict';
/* Tests for the timekeeping gear train that ships inside index.html.
   The GEAR-CORE block is extracted from the real file and executed against a tiny
   DOM stub, so these assertions exercise exactly the code that runs in the browser.
   Run:  node --test tests/gear.test.js                                              */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const gearSrc = html.slice(html.indexOf('/* ==GEAR-CORE-BEGIN== */'), html.indexOf('/* ==GEAR-CORE-END== */'));
assert.ok(gearSrc.length > 1000, 'GEAR-CORE block should be found in index.html');

/* ---------- tiny DOM so makeTrain() can run headless ---------- */
class N {
  constructor(t) { this.t = t; this.a = {}; this.ch = []; this._st = {}; this.style = { setProperty: (k, v) => { this._st[k] = v; } }; }
  setAttribute(k, v) { this.a[k] = String(v); }
  getAttribute(k) { return this.a[k]; }
  append(...cs) { for (const c of cs) if (c) this.ch.push(c); return this; }
  addEventListener() {}
  remove() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { return {}; }
}
function sandboxWithGears() {
  const docL = {}, winL = {}, raf = new Map();
  let seq = 0, fakeNow = Date.now();
  class FakeDate extends Date { constructor(...a) { a.length ? super(...a) : super(fakeNow); } static now() { return fakeNow; } }
  const sb = {
    console,
    NS: 'http://www.w3.org/2000/svg',
    SVGT: /^(svg|g|path|circle|line|text|rect|title|defs|radialGradient|linearGradient|stop)$/,
    C: 300,
    Date: FakeDate,
    document: { createElementNS: (ns, t) => new N(t), createElement: t => new N(t), visibilityState: 'visible',
      addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); } },
    window: { addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: f => { const id = ++seq; raf.set(id, f); return id; },
    cancelAnimationFrame: id => { raf.delete(id); },
  };
  sb.el = (t, a = {}, ...k) => {
    const n = new N(t);
    for (const [x, v] of Object.entries(a)) { if (v == null || v === false) continue; if (typeof v === 'function') n.addEventListener(x.slice(2), v); else n.setAttribute(x, v === true ? '' : v); }
    k.flat().forEach(c => c != null && c !== false && n.append(c));
    return n;
  };
  vm.createContext(sb);
  vm.runInContext(gearSrc, sb, { filename: 'gear-core.js' });
  sb.__raf = raf;
  sb.__fire = (t, visible) => { if (t === 'visibilitychange') sb.document.visibilityState = visible ? 'visible' : 'hidden'; (docL[t] || []).forEach(f => f()); (winL[t] || []).forEach(f => f()); };
  sb.__pump = () => { const cbs = [...raf.values()]; raf.clear(); cbs.forEach(f => f()); };
  sb.__setNow = ms => { fakeNow = ms; };
  return sb;
}
const sb = sandboxWithGears();
const G = sb.makeTrain();
const { CHAIN, TC, PH } = vm.runInContext('({CHAIN,TC,PH})', sb);
const spinNodes = [];
(function walk(n) { if (n.t === 'g' && n.a.class === 'spin') spinNodes.push(n); for (const c of n.ch) walk(c); })(G);
const labels = spinNodes.map(s => s.a['data-part']);
const deg = x => ((x % 360) + 360) % 360;

const spec = (g, part) => ({ dir: g.dir, period: g.period, phase: PH[g.id][part], escapement: false });
const angleAt = (g, part, T) => sb.gearAngle(spec(g, part), T);
/* angular difference folded into (-180,180] */
const adiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return d; };

test('start-up self-check reports a valid transmission', () => {
  assert.equal(sb.checkTrain().length, 0);
  assert.equal(vm.runInContext('TRAIN_ERRORS', sb).length, 0);
});

test('geometry: every meshing centre distance equals the sum of pitch radii (module shared)', () => {
  for (let i = 0; i < 4; i++) {
    const a = CHAIN[i], b = CHAIN[i + 1];
    const d = Math.hypot(TC[i + 1].x - TC[i].x, TC[i + 1].y - TC[i].y);
    assert.ok(Math.abs(d - (a.pin.rp + b.rp)) < 0.5, `${a.id}->${b.id} centre ${d}`);
    assert.ok(Math.abs(2 * a.pin.rp / a.pin.teeth - 2 * b.rp / b.teeth) < 1e-9, `${a.id}->${b.id} module`);
  }
});

test('ratios: N_a/P_a == N_b/P_b and externally meshing gears turn opposite ways', () => {
  for (let i = 0; i < 4; i++) {
    const a = CHAIN[i], b = CHAIN[i + 1];
    assert.equal(a.pin.teeth / a.period, b.teeth / b.period, `${a.id}->${b.id} speed ratio`);
    assert.notEqual(a.dir, b.dir, `${a.id}->${b.id} direction`);
  }
});

test('meshing invariant N1*dθ1 + N2*dθ2 is constant over a full day', () => {
  for (let i = 0; i < 4; i++) {
    const a = CHAIN[i], b = CHAIN[i + 1];
    const inv = T => a.pin.teeth * angleAt(a, 'pin', T) + b.teeth * angleAt(b, 'wheel', T);
    const c0 = inv(0);
    let worst = 0;
    for (let T = 0; T <= 86400; T += 0.5) worst = Math.max(worst, Math.abs(adiff(inv(T), c0)));
    assert.ok(worst < 0.01, `${a.id}->${b.id} drifted ${worst}`);
  }
});

test('compound gears share a shaft so wheel and pinion have equal angular speed', () => {
  const eps = 1e-6;
  for (const g of CHAIN) {
    if (!g.pin) continue;
    const dw = angleAt(g, 'wheel', 123 + eps) - angleAt(g, 'wheel', 123);
    const dp = angleAt(g, 'pin', 123 + eps) - angleAt(g, 'pin', 123);
    assert.ok(Math.abs(dw - dp) < 1e-6, `${g.id} wheel/pinion speed`);
  }
});

test('rotation periods match the intended clock divisions', () => {
  const want = { escape: 30, sec: 60, thr: 360, min: 3600, hr: 43200 };
  for (const g of CHAIN) assert.equal(g.period, want[g.id], `${g.id} period`);
});

test('time-of-day phases: seconds, minute and hour wheels land on their divisions', () => {
  const sec = CHAIN[1], min = CHAIN[3], hr = CHAIN[4];
  assert.equal(angleAt(sec, 'wheel', 0), deg(PH.sec.wheel));
  assert.ok(Math.abs(adiff(angleAt(sec, 'wheel', 30), PH.sec.wheel)) === 180, '00:00:30 half a turn');
  assert.equal(deg(angleAt(sec, 'wheel', 60)), deg(PH.sec.wheel), '00:01:00 one turn');
  assert.ok(Math.abs(adiff(angleAt(min, 'wheel', 1800), PH.min.wheel)) === 180, '00:30:00 half a turn');
  assert.equal(deg(angleAt(min, 'wheel', 3600)), deg(PH.min.wheel), '01:00:00 one turn');
  assert.ok(Math.abs(adiff(angleAt(hr, 'wheel', 21600), PH.hr.wheel)) === 180, '06:00:00 half a turn');
  assert.equal(deg(angleAt(hr, 'wheel', 43200)), deg(PH.hr.wheel), '12:00:00 one turn');
});

test('fractional seconds move the conventional wheels smoothly', () => {
  const sec = CHAIN[1];
  const a = angleAt(sec, 'wheel', 10), b = angleAt(sec, 'wheel', 10.5), c = angleAt(sec, 'wheel', 11);
  assert.ok(b !== a, 'seconds wheel advances mid-second');
  assert.ok(Math.abs(adiff(c, a)) - 6 < 1e-9, 'seconds wheel sweeps 6° per second');
});

test('escape wheel advances exactly one tooth per second and holds between ticks', () => {
  const esc = CHAIN[0];
  const e = T => sb.gearAngle({ dir: esc.dir, period: esc.period, phase: PH.escape.wheel, escapement: true }, T);
  assert.equal(deg(e(6) - e(5)), 360 / esc.teeth, 'one tooth per tick');
  assert.equal(e(5.5), e(5.0), 'locked between ticks');
  assert.equal(deg(e(30) - e(0)), 0, 'one full turn every 30 s');
});

test('escape pinion rides the smooth train (12°/s) so its mesh with seconds never slips', () => {
  const esc = CHAIN[0];
  const p = T => angleAt(esc, 'pin', T);
  assert.ok(p(10.5) !== p(10), 'pinion moves mid-second');
  assert.ok(Math.abs(adiff(p(11), p(10)) - 12) < 1e-9, 'pinion averages 12°/s, matching the escape mean');
});

test('all nine rotating groups exist and are positioned by the clock', () => {
  assert.equal(spinNodes.length, 9);
  const at = T => { sb.setGearTransforms(T); return spinNodes.map(s => s.a.transform); };
  const t0 = at(0), t1 = at(123);
  assert.ok(t0.every(x => /^rotate\(/.test(x)), 'every group gets a rotate() transform');
  assert.equal(t0.filter((x, i) => x !== t1[i]).length, 9, 'every group moves');
});

test('positions depend only on the timestamp, never on elapsed frames', () => {
  const at = T => { sb.setGearTransforms(T); return spinNodes.map(s => s.a.transform).join('|'); };
  assert.equal(at(7 * 3600 + 1234.567), at(7 * 3600 + 1234.567));
});

test('exactly one animation loop survives repeated focus/visibility changes', () => {
  assert.equal(sb.__raf.size, 1, 'loop scheduled after start');
  for (let i = 0; i < 5; i++) sb.__fire('focus', true);
  assert.equal(sb.__raf.size, 1, 'focus must not add loops');
  for (let i = 0; i < 5; i++) sb.__fire('visibilitychange', true);
  assert.equal(sb.__raf.size, 1, 'becoming visible must not add loops');
  sb.__fire('visibilitychange', false);
  assert.equal(sb.__raf.size, 0, 'hidden stops the loop');
  sb.__fire('visibilitychange', true);
  sb.__fire('focus', true); sb.__fire('pageshow', true);
  assert.equal(sb.__raf.size, 1, 'resume schedules exactly one loop');
});

test('the loop follows the wall clock across frames and a long sleep, without drift', () => {
  const Tod = ms => { const d = new Date(ms); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000; };
  const read = i => deg(parseFloat(spinNodes[i].a.transform.match(/-?[\d.]+/)[0]));
  let now = Date.UTC(2026, 9, 10, 13, 0, 0);
  sb.__setNow(now); sb.__pump();
  const check = (g, part) => {
    const idx = labels.indexOf(g.id + '-' + (part === 'pin' ? 'pin' : 'wheel'));
    const es = !!g.escapement && part === 'wheel';   /* only the escape WHEEL steps */
    const exp = deg(sb.gearAngle({ dir: g.dir, period: g.period, phase: PH[g.id][part], escapement: es }, Tod(now)));
    assert.ok(Math.abs(adiff(read(idx), exp)) < 0.01, `${g.id} ${part}: got ${read(idx)} want ${exp}`);
  };
  for (let k = 0; k < 900; k++) { now += 137; sb.__setNow(now); sb.__pump(); }   // ~2 min of uneven frames
  check(CHAIN[1], 'wheel'); check(CHAIN[4], 'wheel'); check(CHAIN[0], 'wheel');
  now += 6 * 3600 * 1000; sb.__setNow(now); sb.__pump();                          // device sleep / background tab
  check(CHAIN[1], 'wheel'); check(CHAIN[4], 'wheel'); check(CHAIN[0], 'wheel');
});
