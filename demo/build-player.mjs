#!/usr/bin/env node
/** Inlines the captured session into a self-contained page the recorder can play. */
import { readFileSync, writeFileSync } from 'node:fs';

const session = JSON.parse(readFileSync('session.json', 'utf8'));
const by = (label) => session.steps.find((s) => s.label === label);

/**
 * Compact results, not pretty-printed bodies. The storyboard's fourth scene shows the
 * decision and the latency; dumping the whole object pushed the refusal off screen,
 * and the refusal is the point of the shot.
 */
const line = (o, keys) => keys.filter((k) => o[k] !== undefined)
  .map((k) => `${k}: ${typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k]}`).join('   ');

const a = by('beat2-authorize');
const c = by('beat2-capture');
const d = by('beat2-dishonor');

const scenes = [
  {
    id: 'beat2a',
    caption: 'Before the model runs',
    lines: [
      { type: 'cmd', text: a.command },
      { type: 'res', status: a.status, ms: a.latency_ms, tone: 'ok',
        text: line(a.body, ['decision', 'face_value', 'available_after_hold']) },
      { type: 'note', text: '# the model runs' },
      { type: 'cmd', text: c.command },
      { type: 'res', status: c.status, ms: c.latency_ms, tone: 'ok',
        text: line(c.body, ['state', 'captured_amount', 'released_remainder', 'balance']) },
      { type: 'note', text: '# 12 credits held. 9 settled. 3 given back.' },
    ],
  },
  {
    id: 'beat2b',
    caption: 'The same request, with no balance',
    clear: true,
    lines: [
      { type: 'cmd', text: d.command },
      { type: 'res', status: d.status, ms: d.latency_ms, tone: 'no', big: true,
        text: line(d.body, ['decision', 'reason']) },
      { type: 'res2', tone: 'no',
        text: line(d.body, ['available', 'required']) },
      { type: 'res2', tone: 'no',
        text: `remedy: ${JSON.stringify(d.body.remedy)}` },
      { type: 'note', text: '# the model does not run.' },
    ],
  },
  {
    id: 'beat3',
    caption: 'Verify it yourself',
    clear: true,
    lines: [
      { type: 'cmd', text: by('beat3-export').command },
      { type: 'cmd', text: by('beat3-verify').command },
      { type: 'out', tone: 'ok', text: by('beat3-verify').output },
      { type: 'note', text: '# change one byte of one entry' },
      { type: 'cmd', text: 'tegata-verify register.jsonl' },
      { type: 'out', tone: 'no', text: by('beat3-tamper').output },
    ],
  },
];

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>TEGATA — recorded session</title>
<style>
  :root { --paper:#F7F4EE; --ink:#211E1A; --ink2:#6B6659; --rule:#CFC9BB; --shu:#B8432F; }
  * { box-sizing:border-box; margin:0 }
  body { background:var(--paper); color:var(--ink); width:1280px; height:720px; overflow:hidden;
         font:400 17px/1.55 "IBM Plex Mono", ui-monospace, Menlo, monospace; }
  .stage { padding:44px 56px; height:100%; display:flex; flex-direction:column; }
  .head { display:flex; align-items:center; gap:14px; padding-bottom:18px;
          border-bottom:1px solid var(--rule); flex:none; }
  .name { font-family:Inter,sans-serif; font-weight:600; letter-spacing:.18em; font-size:15px }
  .caption { margin-left:auto; font-family:Inter,sans-serif; font-size:14px; color:var(--ink2) }
  .term { padding-top:22px; flex:1; overflow:hidden }
  .line { white-space:pre-wrap; margin-bottom:2px }
  .cmd { color:var(--ink) } .cmd .p { color:var(--ink2) }
  .note { color:var(--ink2) }
  .out { color:var(--ink) }
  .status { font-weight:600 } .ok .status { color:var(--ink) } .no .status { color:var(--shu) }
  .no .body { color:var(--shu) } .ok .body { color:var(--ink) }
  .line.big { font-size:26px; line-height:1.5; margin:10px 0 }
  .line.big .status { font-size:26px }
  .ms { color:var(--ink2); font-size:14px }
  .cursor { display:inline-block; width:9px; height:19px; background:var(--ink);
            vertical-align:-4px; animation:b 1s steps(1) infinite }
  @keyframes b { 50% { opacity:0 } }
  .card { position:absolute; inset:0; background:var(--paper); display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:22px; opacity:0 }
  .card.on { opacity:1 }
  .card h1 { font-family:Inter,sans-serif; font-size:38px; font-weight:600; letter-spacing:-.01em;
             text-align:center; line-height:1.3 }
  .card .shu { color:var(--shu) }
</style></head>
<body>
<div class="stage">
  <div class="head">
    <svg width="30" height="30" viewBox="0 0 96 96"><defs>
      <clipPath id="l"><rect width="44" height="96"/></clipPath>
      <clipPath id="r"><rect x="52" width="44" height="96"/></clipPath></defs>
      <g fill="none" stroke="#B8432F" stroke-width="14">
        <circle cx="48" cy="48" r="34" clip-path="url(#l)"/>
        <circle cx="48" cy="48" r="34" clip-path="url(#r)"/></g></svg>
    <span class="name">TEGATA</span>
    <span class="caption" id="caption"></span>
  </div>
  <div class="term" id="term"></div>
</div>
<div class="card" id="card"><h1></h1></div>

<script>
const SCENES = ${JSON.stringify(scenes)};
const term = document.getElementById('term');
const caption = document.getElementById('caption');
const card = document.getElementById('card');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function type(el, text, speed) {
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  el.appendChild(cursor);
  for (const ch of text) {
    cursor.insertAdjacentText('beforebegin', ch);
    if (ch !== ' ') await sleep(speed);
  }
  cursor.remove();
}

async function showCard(html, hold) {
  card.querySelector('h1').innerHTML = html;
  card.classList.add('on');
  await sleep(hold);
  card.classList.remove('on');
}

async function play() {
  await showCard('Your AI app has users<br>who cost you money.', 2200);

  for (const scene of SCENES) {
    if (scene.clear !== false) term.innerHTML = '';
    caption.textContent = scene.caption;
    await sleep(400);
    for (const line of scene.lines) {
      const div = document.createElement('div');
      div.className = 'line ' + (line.tone ? line.tone : '');
      term.appendChild(div);
      term.scrollTop = term.scrollHeight;
      if (line.type === 'cmd') {
        div.classList.add('cmd');
        div.innerHTML = '<span class="p">$ </span>';
        await type(div, line.text, 11);
        await sleep(220);
      } else if (line.type === 'note') {
        div.classList.add('note');
        await type(div, line.text, 16);
        await sleep(500);
      } else if (line.type === 'res' || line.type === 'res2') {
        if (line.big) div.classList.add('big');
        const head = line.status === undefined ? '' :
          '  <span class="status">' + line.status + '</span>  ' +
          '<span class="ms">' + line.ms + 'ms</span>\\n';
        div.innerHTML = head + '<span class="body">  ' + line.text + '</span>';
        await sleep(line.tone === 'no' ? 2600 : 1300);
      } else {
        div.innerHTML = '<span class="body">' + line.text.replace(/^/gm, '  ') + '</span>';
        await sleep(line.tone === 'no' ? 2400 : 1800);
      }
    }
    await sleep(1400);
  }

  term.innerHTML = '';
  caption.textContent = '';
  await showCard('Billing systems tell you what happened.<br>' +
                 '<span class="shu">TEGATA decides what\\'s allowed to happen.</span>', 3200);
  document.title = 'done';
}
play();
</script>
</body></html>`;

writeFileSync('player.html', html);
console.log('wrote demo/player.html');
