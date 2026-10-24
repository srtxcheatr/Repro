// Runs the real consent.js against a minimal fake browser (no DOM rendering is tested).
import assert from 'node:assert/strict'; import vm from 'node:vm'; import fs from 'node:fs';
const src = fs.readFileSync(new URL('../../storesrt-main/assets/js/consent.js', import.meta.url), 'utf8');
function browser(cookie = '', store = {}) {
  const els = {}; let appended = 0;
  class LS { constructor() { Object.assign(this, store); } getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; } removeItem(k) { delete this[k]; } }
  LS.prototype.setItem = function (k, v) { this[k] = String(v); };
  const localStorage = new LS();
  const Storage = function () {}; Storage.prototype = LS.prototype;
  const doc = { readyState: 'complete', _c: cookie, get cookie() { return this._c; }, set cookie(v) { this._c = v.split(';')[0]; },
    body: { appendChild: () => appended++ }, querySelector: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, set innerHTML(v) {}, set textContent(v) {} }),
    getElementById: (id) => (els[id] = els[id] || { addEventListener(_, f) { this.f = f; } }), addEventListener() {} };
  const win = { localStorage, document: doc, location: { protocol: 'https:' }, dispatchEvent() {}, CustomEvent: class {} };
  vm.runInNewContext(src, { ...win, window: win, document: doc, Storage, Object, RegExp, String, CustomEvent: win.CustomEvent, location: win.location });
  return { win, localStorage, doc, els, shown: () => appended > 0 };
}
let b = browser('', { srtx_theme: 'light', 'firebase:authUser': 'x' });
assert.equal(b.win.srtxConsent.get(), null); assert.ok(b.shown());                       // banner shown when undecided
assert.equal(b.localStorage.getItem('srtx_theme'), null);                                // pre-consent leftovers purged
assert.equal(b.localStorage.getItem('firebase:authUser'), 'x');                          // login session kept
b.localStorage.setItem('srtx_theme', 'dark'); assert.equal(b.localStorage.getItem('srtx_theme'), null);   // blocked before consent
b.els.srtxCookieAccept.f();
assert.equal(b.win.srtxConsent.get(), 'accepted'); assert.match(b.doc.cookie, /srtx_consent=accepted/);
b.localStorage.setItem('srtx_theme', 'dark'); assert.equal(b.localStorage.getItem('srtx_theme'), 'dark');  // allowed after accept
b.win.srtxConsent.deny();
assert.equal(b.localStorage.getItem('srtx_theme'), null); assert.equal(b.localStorage.getItem('firebase:authUser'), 'x'); // deny purges, keeps login
b.localStorage.setItem('srtx_x', '1'); assert.equal(b.localStorage.getItem('srtx_x'), null);
const r = browser('srtx_consent=accepted'); assert.equal(r.win.srtxConsent.allowed(), true); assert.equal(r.shown(), false);   // remembered, no banner
const d = browser('srtx_consent=denied'); assert.equal(d.win.srtxConsent.allowed(), false); assert.equal(d.shown(), false);
console.log('consent tests passed');
