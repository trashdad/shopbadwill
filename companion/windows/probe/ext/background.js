/* global chrome */
// Throwaway S-8 probe. Appends events to storage.local key "log": [{type, t, ...}].
const MAX = 5000;
let chain = Promise.resolve();

function log(type, extra) {
  const entry = { type, t: new Date().toISOString(), ...extra };
  chain = chain.then(async () => {
    const { log: cur = [] } = await chrome.storage.local.get('log');
    cur.push(entry);
    await chrome.storage.local.set({ log: cur.slice(-MAX) });
  }).catch(() => {});
  return chain;
}

async function applyKeepAwake() {
  const { keepAwake } = await chrome.storage.local.get('keepAwake');
  if (keepAwake) chrome.power.requestKeepAwake('system');
  else chrome.power.releaseKeepAwake();
  return !!keepAwake;
}

function ensureAlarm() {
  chrome.alarms.get('heartbeat', (a) => {
    if (!a) chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  ensureAlarm();
  await log('installed');
});

chrome.runtime.onStartup.addListener(async () => {
  ensureAlarm();
  const on = await applyKeepAwake();
  await log('startup', { keepAwake: on });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'heartbeat') return;
  const { keepAwake } = await chrome.storage.local.get('keepAwake');
  await log('heartbeat', { keepAwake: !!keepAwake });
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    if (msg.cmd === 'setKeepAwake') {
      await chrome.storage.local.set({ keepAwake: !!msg.on });
      await applyKeepAwake();
      await log(msg.on ? 'keepawake_on' : 'keepawake_off');
    } else if (msg.cmd === 'bgPermission') {
      await log('bg_permission', { granted: !!msg.granted });
    } else if (msg.cmd === 'clear') {
      chain = chain.then(() => chrome.storage.local.set({ log: [] }));
      await chain;
    } else if (msg.cmd === 'mark') {
      await log('mark', { note: String(msg.note || '') });
    }
    respond({ ok: true });
  })();
  return true;
});

ensureAlarm();
