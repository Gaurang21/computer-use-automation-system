// The operator page. Plain HTML and a little script: a list of open requests,
// the request detail with its masked screenshot, and once in control a live
// view refreshed twice a second. Clicks on the image become pointer actions.

export const OPERATOR_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator Console</title>
<style>
  :root { --bg:#f6f6f4; --fg:#1d1d1b; --muted:#6b6b66; --line:#d9d9d4; --accent:#1f5fbf; --warn:#a14a00; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ececea; --muted:#9a9a94; --line:#33332f; --accent:#7aa7ff; --warn:#ffb067; --card:#1f1f1d; } }
  body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; }
  header h1 { font-size:16px; margin:0; } header span { color:var(--muted); }
  main { display:grid; grid-template-columns:300px 1fr; min-height:calc(100vh - 50px); }
  @media (max-width: 800px) { main { grid-template-columns:1fr; } }
  #list { border-right:1px solid var(--line); padding:8px; }
  .item { padding:8px; border:1px solid var(--line); border-radius:6px; margin-bottom:8px; background:var(--card); cursor:pointer; }
  .item.sel { outline:2px solid var(--accent); } .item small { color:var(--muted); display:block; }
  .badge { font-size:11px; padding:1px 6px; border-radius:10px; border:1px solid var(--line); }
  #detail { padding:16px; overflow:auto; }
  dl { display:grid; grid-template-columns:120px 1fr; gap:4px 12px; } dt { color:var(--muted); } dd { margin:0; word-break:break-word; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; align-items:center; }
  button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  input[type=text] { font:inherit; padding:6px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); min-width:200px; }
  img { max-width:100%; border:1px solid var(--line); border-radius:4px; }
  #live { cursor:crosshair; } .warn { color:var(--warn); } .muted { color:var(--muted); }
</style></head>
<body>
<header><h1>Operator Console</h1><span id="lease"></span></header>
<main><div id="list"><p class="muted">No open requests.</p></div><div id="detail"><p class="muted">Select a request.</p></div></main>
<script>
let selected = location.hash.slice(1) || null, liveTimer = null;
const api = (path, body) => fetch('/api/interventions' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => { const j = r.headers.get('content-type')?.includes('json') ? await r.json() : null; if (!r.ok) alert(j?.error || r.statusText); return j; });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

async function refresh() {
  const items = await api('');
  const list = document.getElementById('list');
  list.innerHTML = items.length ? items.slice().reverse().map((i) => \`<div class="item \${i.id === selected ? 'sel' : ''}" data-id="\${i.id}">
    <b>\${esc(i.kind === 'approval' ? 'Approval needed' : 'Stuck')}</b> <span class="badge">\${esc(i.status)}</span>
    <small>\${esc(i.mode)} · \${esc(i.capabilityId || i.goal)}</small><small>\${esc(i.stepId || '')} · \${esc(i.reasonCode)}</small></div>\`).join('') : '<p class="muted">No requests.</p>';
  list.querySelectorAll('.item').forEach((el) => el.onclick = () => { selected = el.dataset.id; location.hash = selected; render(); refresh(); });
  if (selected) render();
}

async function render() {
  const d = await api('/' + selected); if (!d) return;
  document.getElementById('lease').textContent = 'state ' + d.state + ' · lease held by ' + d.lease.owner;
  const open = d.status === 'open', inControl = d.state === 'HUMAN_CONTROL';
  const el = document.getElementById('detail');
  el.innerHTML = \`<h2>\${esc(d.kind === 'approval' ? 'Approval needed' : 'Automation is stuck')}</h2>
  <dl><dt>Run</dt><dd>\${esc(d.runId)} (\${esc(d.mode)})</dd><dt>Capability</dt><dd>\${esc(d.capabilityId || '-')}</dd><dt>Goal</dt><dd>\${esc(d.goal || '-')}</dd>
  <dt>Step</dt><dd>\${esc(d.stepId || '-')} \${esc(d.stepIntent || '')}</dd><dt>Why</dt><dd class="warn">\${esc(d.reasonCode)}: \${esc(d.reason)}</dd>
  <dt>Expected</dt><dd>\${esc(d.expected || '-')}</dd><dt>Observed</dt><dd>\${esc(d.observed)}</dd><dt>Location</dt><dd>\${esc(d.location)}</dd>
  <dt>Status</dt><dd>\${esc(d.status)}\${d.resolution ? ' → ' + esc(d.resolution.kind) : ''}</dd></dl>
  <div class="row">\${open && d.allowed.includes('approve') ? '<button class="primary" id="approve">Approve</button>' : ''}
    \${open && d.allowed.includes('reject') ? '<button id="reject">Reject</button>' : ''}
    \${open && !inControl && d.allowed.includes('take_control') ? '<button class="primary" id="take">Take control</button>' : ''}
    \${open && d.allowed.includes('abort') ? '<button id="abort">Abort run</button>' : ''}</div>
  \${inControl && open ? \`<p><b>You are in control.</b> Click the screen to click. Type below to send keys.</p>
    <div class="row"><input type="text" id="text" placeholder="Text to type"><button id="send">Type</button>
    <button data-key="Enter">Enter</button><button data-key="Tab">Tab</button><button data-key="Escape">Escape</button></div>
    <img id="live" alt="Live session">
    <div class="row"><input type="text" id="note" placeholder="Note for the log">
    \${d.handBackChoices.map((c) => \`<button class="primary" data-hb="\${c}">Hand back: \${c === 'retry' ? 'retry the step' : c === 'continue' ? 'continue from next step' : 'abort'}</button>\`).join('')}</div>\`
    : d.screenshot ? '<p class="muted">Screenshot when the request was raised (sensitive fields masked):</p><img src="/api/interventions/' + d.id + '/evidence.png" alt="Masked screenshot">' : ''}
  \${d.humanActions.length ? '<h3>Human actions</h3><ol>' + d.humanActions.map((a) => '<li>' + esc(a.action) + ' ' + esc(a.element || '') + ' ' + esc(JSON.stringify(a.detail)) + '</li>').join('') + '</ol>' : ''}\`;
  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  on('approve', () => api('/' + d.id + '/approve', { note: 'approved in console' }).then(refresh));
  on('reject', () => api('/' + d.id + '/reject', { note: 'rejected in console' }).then(refresh));
  on('abort', () => api('/' + d.id + '/abort', { note: 'aborted in console' }).then(refresh));
  on('take', () => api('/' + d.id + '/take-control', { operator: 'console' }).then(refresh));
  on('send', () => { const t = document.getElementById('text'); api('/' + d.id + '/key', { text: t.value }).then(() => { t.value = ''; }); });
  el.querySelectorAll('[data-key]').forEach((b) => b.onclick = () => api('/' + d.id + '/key', { key: b.dataset.key }));
  el.querySelectorAll('[data-hb]').forEach((b) => b.onclick = () => api('/' + d.id + '/hand-back', { resolution: b.dataset.hb, note: document.getElementById('note').value }).then(refresh));
  clearInterval(liveTimer);
  const live = document.getElementById('live');
  if (live) {
    const tick = () => { live.src = '/api/interventions/' + d.id + '/live.png?t=' + Date.now(); };
    tick(); liveTimer = setInterval(tick, 500);
    live.onclick = (e) => { const r = live.getBoundingClientRect(); const sx = live.naturalWidth / r.width, sy = live.naturalHeight / r.height;
      api('/' + d.id + '/pointer', { x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) }); };
  }
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
