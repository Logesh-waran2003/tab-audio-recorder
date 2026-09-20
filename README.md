# Tab Audio Recorder

**A Chrome extension that records a meeting and tells you who said what — with no
cloud service.**

Most tab recorders give you one mixed track. Everyone becomes one voice. This one
puts the tab on the left channel and your microphone on the right, so a local
Whisper model can label the speakers:

    [00:12:04] THEM: shall we start with the problem statement?
    [00:12:11] ME:   yes, I want to raise one thing first.

Audio never leaves the machine. There is no account, no server and no upload.

Records any Chrome tab, audio only. It keeps recording when the tab is in the
background and when Chrome is minimised. Works on a YouTube live stream and on a
Google Meet call.

> **Recording law.** In many places, including NSW and WA in Australia, you must
> have the agreement of every person before you record a private conversation.
> Ask first. This tool does not tell the other side that it is running.

## Install
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose this folder
4. Pin the extension to the toolbar

After an update, press **Reload** on the extension card. A running recording is lost.

## Use
1. Open the tab. Join the call, or press play.
2. Click the extension icon. Leave **Record my microphone too** ticked.
3. Click **Start recording**
4. Go and do other work. The tab must stay open. Do not close it.
5. Click the icon -> **Stop and save**
6. The file lands in `~/Downloads/tab-audio/`

The first time, Chrome may ask to use the microphone. If it refuses instead, the
popup shows a link that opens a one-click page to grant it.

## The two channels

With the microphone on, the file has two channels and its name ends in `-2ch`:

| Channel | What is on it |
|---|---|
| Left | the tab — everyone else on the call |
| Right | your microphone — you |

Nothing is mixed together, so the transcriber can tell the speakers apart. Your
own voice is never played back to you while recording.

Without the microphone, the tab goes to both channels and the file sounds normal.

## Transcribe

    ./transcribe.sh                     # newest recording
    ./transcribe.sh file.webm
    ./transcribe.sh file.webm large-v3  # pick a model

Uses `mlx_whisper` when it is installed (much faster on Apple silicon), otherwise
plain `whisper`.

For a `-2ch` file it transcribes each channel on its own and merges them into one
transcript in time order:

    [00:12:04] THEM: shall we start with the problem statement?

    [00:12:11] ME: yes, I want to raise one thing first.

It also writes `<name>-me.txt` and `<name>-them.txt` if you want one side alone.

Three things the script handles that catch people out:

- **Repeat loops.** Whisper fed its own output loops on quiet audio and can turn a
  long meeting into thousands of repetitions of one word. The script always passes
  `condition-on-previous-text False`.
- **Silent channels.** A channel with no speech makes Whisper invent filler such as
  "Thank you". Any channel quieter than -60 dB is skipped instead of transcribed.
- **Collapsed output.** After transcribing it checks how many lines are unique and
  warns if under 20%.

## Limits
- The tab must stay open. Closing it stops and saves the recording.
- Chrome must stay running. Quitting Chrome loses the recording.
- Audio stays in memory until you stop. About 1 MB per minute; a 3 hour recording
  uses roughly 180 MB of RAM.
- Use headphones. On speakers, the tab audio leaks into the microphone channel.
  Echo cancellation is on, which reduces it but does not remove it.
- The microphone is the system default input. Change it in
  System Settings -> Sound -> Input before you start.
- Merge order comes from each channel's own timestamps. When one person is silent
  for a long stretch, their next line can be placed a few seconds off.

## Requirements

- Google Chrome (Manifest V3)
- For transcripts: `mlx_whisper` (Apple silicon) or `whisper`, plus `ffmpeg`
- Built and used on macOS. The extension itself should work anywhere Chrome does;
  `transcribe.sh` expects a Unix shell.

## Status

Version 1.1.0. Used by the author on real calls. Not yet published on the Chrome
Web Store, so installation is "Load unpacked". Issues and pull requests welcome.

## License

MIT. See [LICENSE](LICENSE).
