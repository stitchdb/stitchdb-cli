// Local mail catcher: an SMTP server the local auth service sends its e-mails to (sign-up confirmation, magic links,
// password reset), and a page that shows them. Nothing leaves your machine. The last 200 messages are kept in memory.
//   http://127.0.0.1:<mail port>/               the inbox
//   GET /api/messages[?to=<address>]            [{id, from, to, subject, date, text, html, links}] newest first
//   GET /api/messages/<id> · DELETE /api/messages
'use strict';
const net = require('net');
const crypto = require('crypto');

function decodeQP(s) { return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'); }
function decodeWord(s) {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => (enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8') : decodeQP(txt.replace(/_/g, ' '))));
}
function headersOf(raw) {
  const h = {};
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return h;
}
function parsePart(raw, out) {
  const sep = raw.search(/\r?\n\r?\n/);
  const h = headersOf(sep < 0 ? raw : raw.slice(0, sep));
  let body = sep < 0 ? '' : raw.slice(sep).replace(/^\r?\n\r?\n/, '');
  const type = (h['content-type'] || 'text/plain').toLowerCase();
  const b = /boundary="?([^";]+)"?/i.exec(h['content-type'] || '');
  if (type.startsWith('multipart/') && b) {
    for (const part of body.split(`--${b[1]}`).slice(1)) { if (part.startsWith('--')) break; parsePart(part.replace(/^\r?\n/, ''), out); }
    return h;
  }
  const enc = (h['content-transfer-encoding'] || '').toLowerCase();
  if (enc === 'base64') body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  else if (enc === 'quoted-printable') body = decodeQP(body);
  if (type.startsWith('text/html')) out.html ||= body; else if (type.startsWith('text/')) out.text ||= body;
  return h;
}

function createMail({ onMessage } = {}) {
  const messages = [];
  function store(from, to, data) {
    const out = {};
    const h = parsePart(data, out);
    const links = [...new Set(((out.html || '') + ' ' + (out.text || '')).match(/https?:\/\/[^\s"'<>]+/g) || [])].map((l) => l.replace(/&amp;/g, '&'));
    const m = { id: crypto.randomUUID(), from: decodeWord(h.from || from), to: to.length ? to : [decodeWord(h.to || '')], subject: decodeWord(h.subject || ''), date: new Date().toISOString(), text: out.text || '', html: out.html || '', links };
    messages.unshift(m);
    messages.length = Math.min(messages.length, 200);
    onMessage?.(m);
  }

  const smtp = net.createServer((s) => {
    let buf = '', from = '', to = [], data = null;
    const say = (l) => s.write(l + '\r\n');
    say('220 stitchdb-local ESMTP');
    s.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) { if (buf.length > 25 * 1024 * 1024) s.destroy(); return; }
          data += buf.slice(0, end); buf = buf.slice(end + 5);
          try { store(from, to, Buffer.from(data.replace(/\r\n\.\./g, '\r\n.'), 'latin1').toString('utf8')); } catch {}
          data = null; from = ''; to = [];
          say('250 OK: queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { s.write('250-stitchdb-local\r\n250-8BITMIME\r\n250-SIZE 26214400\r\n250 AUTH PLAIN LOGIN\r\n'); }
        else if (cmd === 'HELO') say('250 stitchdb-local');
        else if (cmd === 'AUTH') say('235 2.7.0 Authentication successful');
        else if (cmd === 'MAIL') { from = (/<([^>]*)>/.exec(line) || [])[1] || ''; say('250 OK'); }
        else if (cmd === 'RCPT') { to.push((/<([^>]*)>/.exec(line) || [])[1] || ''); say('250 OK'); }
        else if (cmd === 'DATA') { data = ''; say('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'RSET') { from = ''; to = []; say('250 OK'); }
        else if (cmd === 'NOOP') say('250 OK');
        else if (cmd === 'QUIT') { say('221 Bye'); s.end(); return; }
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) say('334 '); // AUTH LOGIN continuation
        else say('502 Command not implemented');
      }
    });
    s.on('error', () => {});
  });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local mail</title>
<style>:root{--bg:#fff;--fg:#16181d;--mute:#667085;--line:#e4e7ec;--acc:#2f6fed}@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e8eaee;--mute:#98a2b3;--line:#2a2f3a;--acc:#7aa2ff}}
body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
main{display:grid;grid-template-columns:minmax(220px,340px) 1fr;min-height:calc(100vh - 54px)}ul{list-style:none;margin:0;padding:0;border-right:1px solid var(--line);overflow:auto}
li{padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}li.on{background:color-mix(in srgb,var(--acc) 12%,transparent)}li b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
small{color:var(--mute)}section{padding:16px 20px;overflow:auto}iframe{width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff}button{font:inherit;padding:5px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
a{color:var(--acc)}@media (max-width:700px){main{grid-template-columns:1fr}ul{border-right:0}}</style>
<header><b>Local mail</b><span><small id="n"></small> <button onclick="fetch('api/messages',{method:'DELETE'}).then(load)">Clear</button></span></header>
<main><ul id="list"></ul><section id="view"><small>E-mails the local auth service sends show up here.</small></section></main>
<script>let sel=null;const e=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){const m=await fetch('api/messages').then(r=>r.json());document.getElementById('n').textContent=m.length+' message'+(m.length===1?'':'s');
document.getElementById('list').innerHTML=m.map(x=>'<li data-id="'+x.id+'" class="'+(x.id===sel?'on':'')+'"><b>'+e(x.subject||'(no subject)')+'</b><small>'+e(x.to.join(', '))+' · '+new Date(x.date).toLocaleTimeString()+'</small></li>').join('');
document.querySelectorAll('li').forEach(li=>li.onclick=()=>show(m.find(x=>x.id===li.dataset.id)));}
function show(x){sel=x.id;load();const v=document.getElementById('view');v.innerHTML='<h3>'+e(x.subject)+'</h3><small>From '+e(x.from)+' to '+e(x.to.join(', '))+'</small><p>'+x.links.map(l=>'<a href="'+e(l)+'" target="_blank" rel="noopener">'+e(l.length>90?l.slice(0,90)+'…':l)+'</a>').join('<br>')+'</p>';
const f=document.createElement('iframe');f.sandbox='allow-popups';v.appendChild(f);f.srcdoc=x.html||'<pre>'+e(x.text)+'</pre>';}
load();setInterval(load,2000);</script>`;

  function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/messages' && req.method === 'GET') { const to = url.searchParams.get('to'); return json(200, to ? messages.filter((m) => m.to.some((x) => x.toLowerCase() === to.toLowerCase())) : messages); }
    if (url.pathname === '/api/messages' && req.method === 'DELETE') { messages.length = 0; return json(200, { deleted: true }); }
    const one = /^\/api\/messages\/([0-9a-f-]+)$/.exec(url.pathname);
    if (one) { const m = messages.find((x) => x.id === one[1]); return m ? json(200, m) : json(404, { message: 'Not found' }); }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page()); }
    json(404, { message: 'Not found' });
  }
  return { smtp, handle, messages, esc };
}

module.exports = { createMail, parsePart };
