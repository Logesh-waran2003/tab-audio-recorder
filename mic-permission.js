const out = document.getElementById('out');

document.getElementById('ask').addEventListener('click', async () => {
  out.textContent = 'Waiting for Chrome…';
  out.className = '';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());   // we only needed the grant
    out.textContent = 'Done. Close this tab and start recording.';
    out.className = 'ok';
  } catch (e) {
    out.textContent = 'Chrome refused: ' + ((e && e.message) || e) +
      ' — open chrome://settings/content/microphone and allow this extension.';
    out.className = 'bad';
  }
});
