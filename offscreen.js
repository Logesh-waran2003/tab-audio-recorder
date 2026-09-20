// Offscreen document: holds the MediaStreams and the MediaRecorder.
// It keeps running when the tab is in the background and when Chrome is minimised.
// It also answers 'query', so the service worker can always find the true state.
//
// Two-channel layout when the microphone is on:
//   LEFT  = the tab (everyone else on the call)
//   RIGHT = your microphone (you)
// Nothing is mixed together, so a transcriber can split the two speakers apart.
// With the microphone off, the tab goes to both channels and the file sounds normal.

let recorder = null;
let chunks = [];
let tabStream = null;
let micStream = null;
let audioCtx = null;
let usedMic = false;

function cleanup() {
  for (const s of [tabStream, micStream]) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  tabStream = null;
  micStream = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

async function getMic() {
  // The offscreen document cannot show a permission prompt. The audioCapture
  // permission in the manifest normally covers this. If it does not, the popup
  // sends the user to mic-permission.html once, and this then succeeds.
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,   // stops the tab audio bleeding in through speakers
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
}

async function start(streamId, wantMic) {
  if (recorder && recorder.state === 'recording') throw new Error('Already recording.');

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  // A failed microphone must never lose the meeting. Fall back to tab only.
  let micError = '';
  usedMic = false;
  if (wantMic) {
    try {
      micStream = await getMic();
      usedMic = true;
    } catch (e) {
      micError = String((e && e.message) || e);
      micStream = null;
    }
  }

  audioCtx = new AudioContext();
  const tabSrc = audioCtx.createMediaStreamSource(tabStream);

  // Tab capture silences the tab. Play the stream back so you still hear it.
  tabSrc.connect(audioCtx.destination);

  const merger = audioCtx.createChannelMerger(2);
  tabSrc.connect(merger, 0, 0);               // left = them

  if (micStream) {
    const micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(merger, 0, 1);             // right = you
    // The microphone is never played back, so you do not hear yourself.
  } else {
    tabSrc.connect(merger, 0, 1);             // no mic: same audio in both ears
  }

  const dest = audioCtx.createMediaStreamDestination();
  merger.connect(dest);

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  chunks = [];
  recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 128000 });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const withMic = usedMic;
    chunks = [];
    recorder = null;
    cleanup();
    chrome.runtime.sendMessage({ target: 'background', type: 'saved', url, withMic });
  };
  recorder.onerror = (e) => {
    chrome.runtime.sendMessage({ target: 'background', type: 'error', error: String(e.error || e) });
  };
  recorder.start(5000); // flush a chunk every 5 s

  return { micError };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'query') {
        sendResponse({
          ok: true,
          recording: !!recorder && recorder.state === 'recording',
          usedMic
        });
        return;
      }
      if (msg.type === 'start') {
        const r = await start(msg.streamId, !!msg.withMic);
        sendResponse({ ok: true, micError: r.micError, usedMic });
        return;
      }
      if (msg.type === 'stop') {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        else cleanup();
      }
      sendResponse({ ok: true });
    } catch (e) {
      const error = String((e && e.message) || e);
      cleanup();
      chrome.runtime.sendMessage({ target: 'background', type: 'error', error });
      sendResponse({ ok: false, error });
    }
  })();
  return true;
});
