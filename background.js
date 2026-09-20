// Service worker: coordinates the offscreen recorder.
// The worker sleeps in MV3, so it keeps NO state in memory.
// Truth comes from the offscreen document; storage only holds the start time.

const OFFSCREEN = 'offscreen.html';

async function hasOffscreen() {
  const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return c.length > 0;
}

async function askOffscreen(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra });
}

// The one source of truth: is the offscreen recorder actually running?
async function liveStatus() {
  if (!(await hasOffscreen())) return { recording: false, startedAt: 0, title: '' };
  let r = null;
  try { r = await askOffscreen('query'); } catch (e) { r = null; }
  const saved = (await chrome.storage.local.get('meta')).meta || {};
  if (!r || !r.recording) return { recording: false, startedAt: 0, title: '' };
  return {
    recording: true,
    startedAt: saved.startedAt || 0,
    title: saved.title || '',
    tabId: saved.tabId,
    usedMic: !!r.usedMic
  };
}

// Discreet mode: no badge at all, so nothing shows in a full-screen share.
// The popup still tells the truth, so a recording can never be lost silently.
async function setBadge(on) {
  const { discreet } = await chrome.storage.local.get('discreet');
  if (discreet) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Tab Audio Recorder' });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  chrome.action.setTitle({ title: on ? 'Recording' : 'Tab Audio Recorder' });
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA'],
    justification: 'Record tab audio with MediaRecorder while the tab is in the background.'
  });
}

function safeName(title, withMic) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = (title || 'tab-audio').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60) || 'tab-audio';
  // '-2ch' marks a file whose right channel is your microphone.
  // transcribe.sh reads this marker and splits the two speakers apart.
  const suffix = withMic ? '-2ch' : '';
  return `tab-audio/${base}-${stamp}${suffix}.webm`;
}

async function startRecording() {
  const st = await liveStatus();
  if (st.recording) throw new Error('Already recording. Use Stop and save.');

  // An idle offscreen document may hold a dead stream. Start clean.
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  await ensureOffscreen();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const withMic = (await chrome.storage.local.get('withMic')).withMic !== false; // default on
  const r = await askOffscreen('start', { streamId, withMic });
  if (!r || r.ok === false) throw new Error((r && r.error) || 'Offscreen failed to start.');

  await chrome.storage.local.set({
    meta: { startedAt: Date.now(), title: tab.title || '', tabId: tab.id, usedMic: !!r.usedMic },
    speakers: [],
    lastError: ''
  });
  await setBadge(true);
  // Asked for the microphone and did not get it: say so, but keep recording.
  return { micError: r.micError || '', usedMic: !!r.usedMic };
}

async function stopRecording() {
  if (!(await hasOffscreen())) { await setBadge(false); return; }
  await askOffscreen('stop');   // the 'saved' message follows and does the download
}

// --- speaker names -----------------------------------------------------------
// The content script on a Meet page reports who is speaking. We keep the list in
// storage (the MV3 worker sleeps and would lose it in memory) and write it beside
// the recording as JSON. transcribe.sh turns THEM into real names from that file.

const MAX_SPEAKER_SEGMENTS = 5000;

async function noteSpeaker(name, at) {
  const st = await liveStatus();
  if (!st.recording || !st.startedAt) return;          // only while recording
  const { speakers = [] } = await chrome.storage.local.get('speakers');
  const t = Math.max(0, at - st.startedAt);            // ms from the start of the file
  const last = speakers[speakers.length - 1];
  if (last && last.name === name && t - last.t < 5000) return;
  speakers.push({ t, name });
  if (speakers.length > MAX_SPEAKER_SEGMENTS) speakers.shift();
  await chrome.storage.local.set({ speakers });
}

// chrome.downloads needs a URL. A service worker has no URL.createObjectURL,
// so the sidecar goes out as a data: URL.
async function saveSpeakerFile(recordingName) {
  const { speakers = [] } = await chrome.storage.local.get('speakers');
  await chrome.storage.local.set({ speakers: [] });
  if (!speakers.length) return;
  const json = JSON.stringify({ version: 1, segments: speakers }, null, 2);
  const url = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
  const filename = recordingName.replace(/\.webm$/, '') + '-speakers.json';
  await chrome.downloads.download({ url, filename, saveAs: false });
}

async function finish(url, withMic) {
  const meta = (await chrome.storage.local.get('meta')).meta || {};
  const twoCh = withMic !== undefined ? withMic : !!meta.usedMic;
  const name = safeName(meta.title, twoCh);
  await chrome.downloads.download({ url, filename: name, saveAs: false });
  await saveSpeakerFile(name);
  await chrome.storage.local.set({ meta: {} });
  await setBadge(false);
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return;
  (async () => {
    try {
      if (msg.type === 'start') {
        const started = await startRecording();
        sendResponse({ ok: true, state: await liveStatus(), ...started });
      } else if (msg.type === 'stop') {
        await stopRecording();
        sendResponse({ ok: true });
      } else if (msg.type === 'status') {
        const state = await liveStatus();
        await setBadge(state.recording);       // badge can never drift again
        sendResponse({ ok: true, state });
      } else if (msg.type === 'saved') {
        await finish(msg.url, msg.withMic);
        sendResponse({ ok: true });
      } else if (msg.type === 'reset') {
        if (await hasOffscreen()) await chrome.offscreen.closeDocument();
        await chrome.storage.local.set({ meta: {}, lastError: '' });
        await setBadge(false);
        sendResponse({ ok: true });
      } else if (msg.type === 'rebadge') {
        const st = await liveStatus();
        await setBadge(st.recording);
        sendResponse({ ok: true });
      } else if (msg.type === 'speaker') {
        await noteSpeaker(msg.name, msg.at);
        sendResponse({ ok: true });
      } else if (msg.type === 'error') {
        await chrome.storage.local.set({ lastError: msg.error });
        await setBadge(false);
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// --- keyboard shortcut -------------------------------------------------------
// A shortcut works with the popup closed, so it must say what it did. Without
// this you can silently record nothing, or silently keep recording after you
// believe you stopped.
function toast(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    silent: false
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  try {
    const st = await liveStatus();
    if (st.recording) {
      await stopRecording();
      toast('Stopped', 'Saving to Downloads/tab-audio');
    } else {
      const r = await startRecording();
      toast(
        'Recording',
        r.usedMic ? 'Tab + your microphone, 2 channels' : 'Tab only — no microphone'
      );
    }
  } catch (e) {
    toast('Tab Audio Recorder', String((e && e.message) || e));
  }
});

// If the captured tab closes, stop and save what we have.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const meta = (await chrome.storage.local.get('meta')).meta || {};
  if (meta.tabId === tabId) await stopRecording();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ meta: {} });
  await setBadge(false);
});
