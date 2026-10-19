// End-to-end check against a local `wrangler pages dev` serving the demo server (scripts/make_demo_export.py).
//
//   node test/e2e-demo.mjs --base https://127.0.0.1:8788 --cdp 9333 --export demo-export --password demo [--shots /tmp/e2e]
//
// Needs headless Chrome with --remote-debugging-port=<cdp> --ignore-certificate-errors on a throwaway profile.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') && acc.push([a.slice(2), all[i + 1]]), acc), []));
const BASE = args.base || 'https://127.0.0.1:8788';
const PORT = args.cdp || '9333';
const EXPORT = args.export || 'demo-export';
const PASSWORD = args.password || 'demo';
const SHOTS = args.shots || '';
const guild = JSON.parse(fs.readFileSync(path.join(EXPORT, 'guild.json'), 'utf8'));
const channels = JSON.parse(fs.readFileSync(path.join(EXPORT, 'channels.json'), 'utf8'));
const byName = (name) => channels.find((c) => c.name === name);
const messagesOf = (id) => JSON.parse(fs.readFileSync(path.join(EXPORT, 'messages', `${id}.json`), 'utf8'));
const general = byName('general'), welcome = byName('welcome'), forum = byName('resources');
const posts = channels.filter((c) => c.parent_id === forum.id);
const forward = messagesOf(general.id).find((m) => m.message_snapshots);
const reply = messagesOf(general.id).find((m) => m.type === 19);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const record = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab() {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const exceptions = []; let navs = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0].slice(0, 160));
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs++;
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const waitFor = async (expression, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await evaluate(expression).catch(() => null); if (v) return v; await sleep(400); } return null; };
  const click = async (selector) => {
    const p = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (p) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    return !!p;
  };
  const key = async (k, code = 27) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code }); };
  const shot = async (name) => { if (!SHOTS) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64')); };
  return { send, evaluate, waitFor, click, key, shot, exceptions, get navs() { return navs; }, nav: (url) => send('Page.navigate', { url }),
    close: async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } };
}

const MSG = `document.querySelectorAll('li[id^="chat-messages-"]').length`;
const tab = await openTab();

await tab.nav(`${BASE}/`);
record('password page before login', !!await tab.waitFor(`!!document.querySelector('input[name=password]')`, 15000));
await tab.evaluate(`(()=>{const i=document.querySelector('input[name=password]');i.value=${JSON.stringify(PASSWORD)};i.form.submit();return 1})()`);
const landed = await tab.waitFor(MSG, 45000);
const where = await tab.evaluate('location.pathname');
record('login lands in the official client', landed > 0 && where.startsWith(`/channels/${guild.id}/`), `path=${where} messages=${landed}`);
const sidebar = await tab.evaluate(`[...document.querySelectorAll('[data-list-item-id^="channels___"]')].map(e=>e.innerText.trim()).join('|')`);
record('channel list shows the server\'s channels', ['welcome', 'general', 'links', 'resources'].every((n) => sidebar.includes(n)), sidebar.slice(0, 120));
await tab.shot('01-landing.png');

// roles and server profiles (guild.json roles + members.json): Alice is a Moderator (blue), Bob has the nickname
// "Bobby (demo)" and the gradient Contributor role, Carol has no role but a server bio
await tab.nav(`${BASE}/channels/${guild.id}/${general.id}`);
await tab.waitFor(MSG, 45000);
const names = await tab.waitFor(`(()=>{const o={};for(const s of document.querySelectorAll('li[id^="chat-messages-"] [id^="message-username-"] [class*="username"]'))o[s.innerText.trim()]={color:getComputedStyle(s).color,gradient:/gradient/i.test(s.className)};return o['Alice (demo)']&&o['Bobby (demo)']?o:null})()`, 20000);
record('names use role colors and server nicknames', !!names && names['Alice (demo)'].color === 'rgb(52, 152, 219)' && names['Bobby (demo)'].gradient,
  JSON.stringify(names || {}).slice(0, 160));
const openCard = async (name) => {
  const p = await tab.evaluate(`(()=>{const e=[...document.querySelectorAll('li[id^="chat-messages-"] [id^="message-username-"] [class*="username"]')].filter(e=>e.innerText.trim()===${JSON.stringify(name)}).pop();if(!e)return null;e.scrollIntoView({block:'center'});return 1})()`);
  if (!p) return '';
  await sleep(800);
  const pos = await tab.evaluate(`(()=>{const e=[...document.querySelectorAll('li[id^="chat-messages-"] [id^="message-username-"] [class*="username"]')].filter(e=>e.innerText.trim()===${JSON.stringify(name)}).pop();const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  const text = await tab.waitFor(`document.querySelector('[class*="user-profile-popout"]')?.innerText||''`, 8000);
  await tab.key('Escape');
  return text || '';
};
const aliceCard = await openCard('Alice (demo)');
record('profile card lists the member\'s roles', aliceCard.includes('Moderator'), aliceCard.replace(/\n+/g, ' ').slice(0, 80));
const carolCard = await openCard('Carol (demo)');
record('profile card shows the server bio and pronouns', carolCard.includes('Demo server bio for Carol.') && carolCard.includes('she/her'),
  carolCard.replace(/\n+/g, ' ').slice(0, 80));
await tab.click('[aria-label="Show Member List"]');
const list = await tab.waitFor(`(()=>{const t=document.querySelector('[class*="membersWrap"]')?.innerText||'';return /Moderator/.test(t)&&t.includes('Alice (demo)')?t:''})()`, 10000);
record('member list groups members by role', !!list, (list || '').replace(/\n+/g, ' ').slice(0, 100));
await tab.click('[aria-label="Hide Member List"]');

await tab.nav(`${BASE}/channels/${guild.id}/${general.id}/${forward.id}`);
const fwd = await tab.waitFor(`(()=>{const li=document.getElementById('chat-messages-${general.id}-${forward.id}');return li&&li.innerText.includes('Handy reference')?'ok':''})()`, 45000);
record('forwarded message shows its content', !!fwd);
await tab.nav(`${BASE}/channels/${guild.id}/${general.id}/${reply.id}`);
const bar = await tab.waitFor(`(()=>{const li=document.getElementById('chat-messages-${general.id}-${reply.id}');const r=li&&li.querySelector('[id^="message-reply-context-"]');return r?r.innerText.slice(0,60):''})()`, 45000);
record('reply shows the replied-to message', !!bar && /Bob(by)? \(demo\)/.test(bar), bar || 'no reply bar');
await tab.shot('02-forward-reply.png');

await tab.nav(`${BASE}/channels/${guild.id}/${general.id}`);
await tab.waitFor(MSG, 45000);
const before = await tab.evaluate(MSG);
await tab.evaluate(`(()=>{const s=document.querySelector('[class*="messagesWrapper"] [class*="scroller"]');s.scrollTop=0;return 1})()`);
const older = await tab.waitFor(`${MSG} > ${before} ? ${MSG} : 0`, 20000);
record('scrolling up loads older history', !!older, `${before} → ${older || before}`);

// an avatar well inside the message list (the last ones can sit under the message box)
const avatar = await tab.evaluate(`(()=>{const a=[...document.querySelectorAll('li[id^="chat-messages-"] img[class*="avatar"]')].filter(i=>{const r=i.getBoundingClientRect();return r.y>120&&r.y<innerHeight-160}).pop();if(!a)return null;const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
if (avatar) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: avatar.x, y: avatar.y, button: 'left', clickCount: 1 });
const card = await tab.waitFor(`document.querySelector('[class*="user-profile-popout"]')?.innerText.slice(0,40)||''`, 8000);
record('clicking an avatar opens that user\'s profile card', !!card && /(Alice|Bobby?|Carol) \(demo\)/.test(card), (card || '').replace(/\n/g, ' '));
await tab.key('Escape');

await tab.nav(`${BASE}/channels/${guild.id}/${welcome.id}`);
await tab.waitFor(MSG, 45000);
await sleep(1500);
await tab.click('[aria-label="Pinned Messages"]');
const pinned = await tab.waitFor(`document.body.innerText.includes('Be kind, stay on topic')&&document.querySelector('[role="dialog"]')?'ok':''`, 10000);
record('pinned messages panel lists the pin', !!pinned);
await tab.key('Escape');

await tab.nav(`${BASE}/channels/${guild.id}/${forum.id}`);
const titles = await tab.waitFor(`(()=>{const t=[...document.querySelectorAll('[class*="mainCard"]')].map(c=>c.innerText.split('\\n')[0]);return t.length>=${posts.length}?t.join('|'):''})()`, 30000);
record('forum lists active and archived posts', !!titles && posts.every((p) => titles.includes(p.name)), titles || 'none');
await tab.shot('03-forum.png');

const excBefore = tab.exceptions.length;
for (const label of ['Open GIF picker', 'Open sticker picker', 'Add Emoji', 'Apps']) {
  await tab.nav(`${BASE}/channels/${guild.id}/${general.id}`);
  await tab.waitFor(MSG, 30000);
  if (await tab.click(`[aria-label=${JSON.stringify(label)}]`)) { await sleep(2000); await tab.key('Escape'); }
}
const pickerExc = tab.exceptions.slice(excBefore).filter((e) => !/View Model linked to Artboard|Request has been terminated/.test(e));
record('pickers open without client exceptions', pickerExc.length === 0, pickerExc.slice(0, 2).join(' | '));

await tab.click('[role="textbox"]');
await tab.send('Input.insertText', { text: 'hello from e2e' });
await tab.key('Enter', 13);
const denied = await tab.waitFor(`/permission/i.test([...document.querySelectorAll('li[id^="chat-messages-"]')].slice(-1)[0]?.innerText||'')`, 15000);
const crashed = await tab.evaluate(`/Well, this is awkward/.test(document.body.innerText)`);
record('sending is refused (read-only) without crashing', !!denied && !crashed);

const navs = tab.navs;
await sleep(60000);
record('idle 60s: no reload loop', tab.navs === navs, `navigations=${tab.navs - navs}`);
await tab.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
