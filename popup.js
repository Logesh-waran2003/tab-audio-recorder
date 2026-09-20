const go = document.getElementById('go');
const info = document.getElementById('info');
const reset = document.getElementById('reset');
const mic = document.getElementById('mic');
const grant = document.getElementById('grant');
const discreet = document.getElementById('discreet');

let recording = false;
let startedAt = 0;
let usedMic = false;
let sticky = '';   // an error message stays until the next action

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...extra });
}

function render() {
  go.textContent = recording ? 'Stop and save' : 'Start recording';
  go.className = recording ? 'rec' : 'idle';
  mic.disabled = recording;
  if (sticky) { info.textContent = sticky; info.className = 'err'; return; }
  info.className = '';
  if (recording) {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const who = usedMic ? 'tab + your mic' : 'tab only';
    info.textContent = `Recording ${mm}:${ss} (${who}). You can switch tabs or minimise the browser. Do not close the tab.`;
  } else if (discreet.checked) {
    info.textContent = 'Ready. The toolbar stays quiet, so check here to see if it is running.';
  } else {
    info.textContent = mic.checked
      ? 'Ready. Saves to Downloads/tab-audio/ as a 2-channel file.'
      : 'Ready. The file goes to Downloads/tab-audio/.';
  }
}

async function refresh() {
  const r = await send('status');
  recording = !!(r && r.state && r.state.recording);
  startedAt = (r && r.state && r.state.startedAt) || Date.now();
  usedMic = !!(r && r.state && r.state.usedMic);
  reset.style.display = recording ? 'block' : 'none';
  render();
}

go.addEventListener('click', async () => {
  go.disabled = true;
  sticky = '';
  grant.style.display = 'none';
  const r = await send(recording ? 'stop' : 'start');
  if (r && r.ok === false) {
    sticky = 'Error: ' + r.error;
  } else if (r && r.micError) {
    // Recording still started, on the tab only. Say what happened.
    sticky = 'Recording without the microphone: ' + r.micError;
    grant.style.display = 'block';
  }
  setTimeout(async () => { go.disabled = false; await refresh(); }, 600);
});

discreet.addEventListener('change', async () => {
  await chrome.storage.local.set({ discreet: discreet.checked });
  await send('rebadge');
  sticky = '';
  render();
});

mic.addEventListener('change', async () => {
  await chrome.storage.local.set({ withMic: mic.checked });
  sticky = '';
  render();
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

(async () => {
  const saved = await chrome.storage.local.get(['withMic', 'discreet']);
  mic.checked = saved.withMic !== false;   // default on
  discreet.checked = !!saved.discreet;     // default off
  await refresh();
})();

setInterval(() => { if (!sticky) render(); }, 1000);
