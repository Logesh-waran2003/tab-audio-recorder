const el = (id) => document.getElementById(id);
const go = el('go'), goLabel = el('goLabel'), info = el('info');
const reset = el('reset'), grant = el('grant'), hint = el('hint');
const mic = el('mic'), discreet = el('discreet');
const stateText = el('stateText'), time = el('time');

const BARS = 20;
let recording = false;
let startedAt = 0;
let usedMic = false;
let sticky = '';          // an error stays on screen until the next action

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...extra });
}
const isOn = (sw) => sw.getAttribute('aria-checked') === 'true';
const setOn = (sw, v) => sw.setAttribute('aria-checked', v ? 'true' : 'false');

for (const id of ['barsThem', 'barsMe']) {
  el(id).innerHTML = '<i></i>'.repeat(BARS);
}

// --- meters ------------------------------------------------------------------
// The offscreen document owns the audio, so it measures the level and we draw it.
// This is the check that catches a dead microphone in one second, not after the call.
function paintChannel(prefix, db) {
  const bars = el(prefix === 'Them' ? 'barsThem' : 'barsMe').children;
  const out = el('db' + prefix);

  if (db === null || db === undefined || db <= -89) {
    out.textContent = db === null ? 'off' : '−∞';
    for (const b of bars) { b.style.height = '12%'; b.style.opacity = '.22'; }
    return;
  }
  out.textContent = '−' + Math.abs(Math.round(db)) + ' dB';
  // -60 dB is silence, 0 dB is the ceiling.
  const level = Math.min(1, Math.max(0, (db + 60) / 60));
  const lit = Math.round(level * BARS);
  for (let i = 0; i < bars.length; i++) {
    const active = i < lit;
    // Slight variation so the meter reads as sound, not as a progress bar.
    const h = active ? 25 + (level * 70) * (0.65 + 0.35 * Math.sin(i * 1.7 + Date.now() / 90)) : 12;
    bars[i].style.height = Math.min(100, h) + '%';
    bars[i].style.opacity = active ? '.95' : '.22';
  }
}

function clearMeters() {
  paintChannel('Them', -90);
  paintChannel('Me', null);
}

async function pollLevels() {
  if (!recording) return;
  let r = null;
  try {
    r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'levels' });
  } catch (e) {
    return;                                  // offscreen gone; refresh() will catch up
  }
  if (!r || !r.ok) return;
  paintChannel('Them', r.them);
  paintChannel('Me', r.me);
}

// --- rendering ---------------------------------------------------------------
function render() {
  document.body.classList.toggle('rec', recording);
  goLabel.textContent = recording ? 'Stop and save' : 'Start recording';
  setOn(mic, isOn(mic));
  mic.setAttribute('aria-disabled', recording ? 'true' : 'false');

  if (recording) {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    time.textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    stateText.textContent = usedMic ? 'Recording · 2 channels' : 'Recording · tab only';
  } else {
    time.textContent = '00:00';
    stateText.textContent = 'Ready';
    clearMeters();
  }

  if (sticky) { info.textContent = sticky; info.className = 'err'; return; }
  info.className = '';
  info.textContent = recording
    ? 'Keep the tab open. You can switch tabs or minimise Chrome.'
    : 'Saves to Downloads/tab-audio';
}

async function refresh() {
  const r = await send('status');
  recording = !!(r && r.state && r.state.recording);
  startedAt = (r && r.state && r.state.startedAt) || Date.now();
  usedMic = !!(r && r.state && r.state.usedMic);
  reset.style.display = recording ? 'block' : 'none';
  render();
}

// --- actions -----------------------------------------------------------------
go.addEventListener('click', async () => {
  go.disabled = true;
  sticky = '';
  grant.style.display = 'none';
  const r = await send(recording ? 'stop' : 'start');
  if (r && r.ok === false) {
    sticky = 'Error: ' + r.error;
  } else if (r && r.micError) {
    sticky = 'Recording without the microphone: ' + r.micError;
    grant.style.display = 'block';
  }
  setTimeout(async () => { go.disabled = false; await refresh(); }, 600);
});

function toggle(sw, onChange) {
  const flip = async () => {
    if (sw.getAttribute('aria-disabled') === 'true') return;
    setOn(sw, !isOn(sw));
    sticky = '';
    await onChange(isOn(sw));
    render();
  };
  sw.addEventListener('click', flip);
  sw.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
  });
}

toggle(mic, (v) => chrome.storage.local.set({ withMic: v }));
toggle(discreet, async (v) => {
  await chrome.storage.local.set({ discreet: v });
  await send('rebadge');
});

grant.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
  window.close();
});

reset.addEventListener('click', async () => {
  await send('reset');
  sticky = '';
  await refresh();
});

// --- start -------------------------------------------------------------------
(async () => {
  // Show the real shortcut, not a guess: the user may have rebound it.
  const cmds = await chrome.commands.getAll();
  const toggleCmd = cmds.find((c) => c.name === 'toggle-recording');
  hint.textContent = (toggleCmd && toggleCmd.shortcut) || '';
  if (!hint.textContent) hint.style.display = 'none';

  const saved = await chrome.storage.local.get(['withMic', 'discreet']);
  setOn(mic, saved.withMic !== false);       // default on
  setOn(discreet, !!saved.discreet);         // default off: the badge is the proof
  await refresh();
})();

setInterval(() => { if (!sticky) render(); }, 1000);
setInterval(pollLevels, 120);
