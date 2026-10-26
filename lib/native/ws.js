// Minimal WebSocket server side (RFC 6455) for the local Realtime: handshake, text/binary messages (fragmented too),
// ping/pong and close. No extensions (no compression). No dependencies.
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX = 16 * 1024 * 1024;

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.buf = Buffer.alloc(0); this.frags = null; this.open = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this._drain(); });
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }
  _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX) { this.close(1009, 'message too big'); return; }
      const masked = b1 & 0x80;
      if (this.buf.length < off + (masked ? 4 : 0) + len) return;
      let data = this.buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const m = this.buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(off + (masked ? 4 : 0) + len);
      const fin = b0 & 0x80, op = b0 & 0x0f;
      if (op === 0x8) { const code = data.length >= 2 ? data.readUInt16BE(0) : 1000; this._send(0x8, data.subarray(0, 2)); this.sock.end(); this._closed(); this.emit('closing', code); return; }
      if (op === 0x9) { this._send(0xA, data); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) this.frags = { op, parts: [data] };
      else if (op === 0x0 && this.frags) this.frags.parts.push(data);
      else continue;
      if (fin) { const { op: o, parts } = this.frags; this.frags = null; const all = Buffer.concat(parts); this.emit('message', o === 0x1 ? all.toString('utf8') : all, o === 0x2); }
    }
  }
  _send(op, data) {
    if (!this.open && op !== 0x8) return;
    const len = data.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    try { this.sock.write(Buffer.concat([head, data])); } catch {}
  }
  send(data) { if (typeof data === 'string') this._send(0x1, Buffer.from(data, 'utf8')); else this._send(0x2, Buffer.from(data)); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const b = Buffer.alloc(2 + Buffer.byteLength(reason)); b.writeUInt16BE(code); b.write(reason, 2);
    this._send(0x8, b); this.open = false; setTimeout(() => this.sock.destroy(), 200).unref(); this.emit('close');
  }
}

// Answer an HTTP upgrade request; returns the Socket, or null (and a 400) when it isn't a WebSocket handshake.
function accept(req, sock, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return null; }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  const ws = new Socket(sock);
  if (head && head.length) { ws.buf = Buffer.from(head); setImmediate(() => ws._drain()); } // after the caller added its listeners
  return ws;
}

module.exports = { accept, Socket };
