/* global chrome, document, prompt, confirm, Blob, URL, setInterval */
const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);

async function render() {
  const { log = [], keepAwake } = await chrome.storage.local.get(['log', 'keepAwake']);
  $('ka').checked = !!keepAwake;
  const has = await chrome.permissions.contains({ permissions: ['background'] });
  $('bgState').textContent = has ? 'background permission: GRANTED' : 'background permission: not granted';
  const hb = log.filter((e) => e.type === 'heartbeat');
  const st = log.filter((e) => e.type === 'startup');
  $('summary').textContent = `${hb.length} heartbeats, ${st.length} onStartup, last heartbeat ${hb.length ? hb[hb.length - 1].t : '-'}`;
  $('out').textContent = log.slice(-200).map((e) => JSON.stringify(e)).join('\n');
}

$('bg').onclick = async () => {
  const granted = await chrome.permissions.request({ permissions: ['background'] });
  await send({ cmd: 'bgPermission', granted });
  render();
};
$('ka').onchange = async () => { await send({ cmd: 'setKeepAwake', on: $('ka').checked }); render(); };
$('refresh').onclick = render;
$('mark').onclick = async () => { await send({ cmd: 'mark', note: prompt('note?') || '' }); render(); };
$('clear').onclick = async () => { if (confirm('Clear log?')) { await send({ cmd: 'clear' }); render(); } };
$('export').onclick = async () => {
  const { log = [], keepAwake } = await chrome.storage.local.get(['log', 'keepAwake']);
  const has = await chrome.permissions.contains({ permissions: ['background'] });
  const out = {
    exportedAt: new Date().toISOString(),
    backgroundGranted: has,
    keepAwake: !!keepAwake,
    startups: log.filter((e) => e.type === 'startup').map((e) => e.t),
    log,
  };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sbw-probe-export-${Date.now()}.json`;
  a.click();
};
render();
setInterval(render, 5000);
