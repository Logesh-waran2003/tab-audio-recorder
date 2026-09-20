// Reads WHO IS SPEAKING from the Google Meet page and sends it to the background.
//
// Why this exists: the tab channel holds every other person mixed together, so the
// transcript can only say THEM. Meet already knows the names — it prints them above
// each live caption. We read them off the page and stamp them onto the timeline.
//
// Requirements and limits, stated plainly:
//   * Live captions must be ON in the meeting (CC button). No captions, no names.
//   * Nothing is read from the audio. This is page text only.
//   * Google renames its CSS classes often. We never match on class names, only on
//     the accessibility label, which is far more stable. It can still break.
//   * Nothing leaves the machine. Names go to the background worker and then into a
//     JSON file beside your recording.

const POLL_MS = 400;
let lastSpeaker = "";
let lastSentAt = 0;

/** Meet marks its captions container for screen readers. That label is our anchor. */
function findCaptionRegion() {
  const candidates = document.querySelectorAll("[aria-label]");
  for (const el of candidates) {
    const label = el.getAttribute("aria-label") || "";
    if (/captions?/i.test(label) && el.innerText && el.innerText.trim()) {
      return el;
    }
  }
  return null;
}

/**
 * A caption block renders as:
 *     Priya Sharma
 *     shall we start with the problem statement
 * so the first line is the name and the rest is what they said.
 */
function currentSpeaker() {
  const region = findCaptionRegion();
  if (!region) return "";

  const blocks = region.querySelectorAll("div");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const lines = (blocks[i].innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;
    const name = lines[0];
    // A name is short and has no sentence punctuation. This rejects caption text
    // that happens to sit on its own line.
    if (name.length > 40 || /[.?!,]$/.test(name)) continue;
    return name;
  }
  return "";
}

function tick() {
  const name = currentSpeaker();
  if (!name) return;

  const now = Date.now();
  // Re-send the same speaker at most every 5s, so a long turn still anchors
  // the timeline if the recording started midway through it.
  if (name === lastSpeaker && now - lastSentAt < 5000) return;

  lastSpeaker = name;
  lastSentAt = now;
  try {
    chrome.runtime.sendMessage({ target: "background", type: "speaker", name, at: now });
  } catch (e) {
    // The worker was asleep or the extension reloaded. The next tick retries.
  }
}

setInterval(tick, POLL_MS);

// Run this in the Meet console to check the reader still works after a Meet update:
//   __tabAudioSpeakers()
window.__tabAudioSpeakers = () => ({
  captionRegionFound: Boolean(findCaptionRegion()),
  speakerNow: currentSpeaker(),
});
