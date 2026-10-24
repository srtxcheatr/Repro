// Run: node tests/clientip.test.mjs
import assert from 'node:assert/strict';
import { isPrivateIp, realClientIp } from '../src/security.js';
const req = (peer, headers = {}, ip = peer) => ({ socket: { remoteAddress: peer }, headers, ip });
for (const ip of ['10.24.63.117', '172.16.0.1', '172.31.9.9', '192.168.1.5', '127.0.0.1', '::1', '::ffff:10.0.0.2', 'fd12:3456::1']) assert.ok(isPrivateIp(ip), ip);
for (const ip of ['8.8.8.8', '172.32.0.1', '1.2.3.4', '2606:4700::1']) assert.ok(!isPrivateIp(ip), ip);
assert.equal(realClientIp(req('10.24.63.117', { 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');          // behind Render + Cloudflare
assert.equal(realClientIp(req('10.24.63.117', { 'x-forwarded-for': '203.0.113.7, 10.1.1.1' })), '203.0.113.7');  // falls back to right-most public hop
assert.equal(realClientIp(req('10.24.63.117', { 'x-forwarded-for': '9.9.9.9, 203.0.113.7, 10.1.1.1' })), '203.0.113.7');   // spoofed left entries ignored
assert.equal(realClientIp(req('10.24.63.117', { 'cf-connecting-ip': '10.0.0.9' })), '10.24.63.117');            // private claim is ignored
assert.equal(realClientIp(req('10.24.63.117', { 'cf-connecting-ip': '<script>' })), '10.24.63.117');            // junk ignored
assert.equal(realClientIp(req('198.51.100.4', { 'cf-connecting-ip': '1.1.1.1' })), '198.51.100.4');             // direct client can NOT spoof the header
console.log('client ip tests passed');
