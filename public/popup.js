// ============================================================
// Popup — recognition host, AWS Transcribe edition.
// Chrome's Web Speech API is dead on this machine, so we record
// with MediaRecorder and send audio to the local backend, which
// streams it to AWS Transcribe and returns a transcript.
// Message contract with background/content is unchanged.
// ============================================================

const KEYWORD = 'arise';
const BACKEND = 'http://localhost:3000';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let mode = 'wake';        // 'wake' | 'command'
let running = false;      // wake loop active
let micStream = null;

function setStatus(text, active = true) {
  statusText.textContent = text;
  statusDot.classList.toggle('active', active);
}

const port = chrome.runtime.connect({ name: 'popup' });
port.postMessage({ type: 'POPUP_READY' });

port.onMessage.addListener((message) => {
  if (message.type === 'RECOGNITION_START') {
    if (message.mode === 'command') {
      mode = 'command';
      captureCommand();
    } else {
      mode = 'wake';
      // wake loop is already running continuously; nothing to do
    }
  } else if (message.type === 'RECOGNITION_STOP') {
    // A stop request just means "whatever you were doing, consider it done."
    port.postMessage({ type: 'RECOGNITION_ENDED' });
  }
});

// ── Mic setup ────────────────────────────────────────────────
async function ensureMic() {
  if (micStream) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (err) {
    console.warn('[Shadow] Mic denied in popup:', err);
    setStatus('Mic blocked — grant permission', false);
    return false;
  }
}

// ── Record one clip ──────────────────────────────────────────
// maxMs hard cap; if silenceStop is true, stop ~1.2s after the
// user goes quiet (only once they've actually spoken).
function recordClip({ maxMs = 4000, silenceStop = false }) {
  return new Promise((resolve) => {
    const recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));

    let silenceTimer = null;
    let audioCtx = null;

    if (silenceStop) {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(micStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let spoke = false;

      const tick = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let rms = 0;
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);

        if (rms > 0.01) {
          spoke = true;
          clearTimeout(silenceTimer);
          silenceTimer = null;
        } else if (spoke && !silenceTimer) {
          silenceTimer = setTimeout(() => {
            clearInterval(tick);
            audioCtx.close();
            if (recorder.state === 'recording') recorder.stop();
          }, 1200);
        }
      }, 100);

      recorder.addEventListener('stop', () => {
        clearInterval(tick);
        if (audioCtx.state !== 'closed') audioCtx.close();
      }, { once: true });
    }

    recorder.start();
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, maxMs);
  });
}

// ── Send clip to backend, get transcript ─────────────────────
async function transcribeClip(blob) {
  try {
    const buf = await blob.arrayBuffer();
    const res = await fetch(`${BACKEND}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: buf,
    });
    if (!res.ok) throw new Error(`transcribe ${res.status}`);
    const data = await res.json();
    return (data.transcript || '').trim();
  } catch (err) {
    console.warn('[Shadow] Transcribe failed:', err);
    port.postMessage({ type: 'RECOGNITION_ERROR', error: 'transcribe-failed' });
    return '';
  }
}

// ── Wake loop: 4s chunks, watch for the keyword ─────────────
async function wakeLoop() {
  if (running) return;
  running = true;

  while (running) {
    if (mode !== 'wake') {
      // Command capture is in flight — idle until it's done.
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }

    setStatus('Listening for "Arise"', true);
    const clip = await recordClip({ maxMs: 4000 });

    if (mode !== 'wake') continue; // mode flipped while recording

    setStatus('…', true);
    const transcript = await transcribeClip(clip);
    console.log('[Shadow] wake heard:', transcript || '(nothing)');

    if (transcript.toLowerCase().includes(KEYWORD)) {
      // Mark mode as pending right away, synchronously, before the message
      // even goes out. The content script's reply asking for command mode
      // has to travel popup to background to content and back, that takes
      // a few ms. Without this line the loop above would see mode still
      // equal to 'wake' during that gap and start recording again, racing
      // against the command capture that is about to start on the same
      // mic stream. Any value other than 'wake' closes that gap, since the
      // loop guard only checks mode !== 'wake'.
      mode = 'pending';
      setStatus('Awake', true);
      port.postMessage({ type: 'RECOGNITION_WAKE' });
      // Content script will request command mode via RECOGNITION_START,
      // which will set mode = 'command' and call captureCommand().
    }
  }
}

// ── Command capture: one utterance, silence-stopped ─────────
async function captureCommand() {
  setStatus('Listening…', true);
  const clip = await recordClip({ maxMs: 6000, silenceStop: true });

  setStatus('Transcribing…', true);
  const transcript = await transcribeClip(clip);
  console.log('[Shadow] command heard:', transcript || '(nothing)');

  port.postMessage({ type: 'RECOGNITION_RESULT', transcript });
  port.postMessage({ type: 'RECOGNITION_ENDED' });

  mode = 'wake';
}

// ── Manual fallback — same effect as saying "Arise" ─────────
document.getElementById('ariseBtn').addEventListener('click', () => {
  setStatus('Awake', true);
  port.postMessage({ type: 'RECOGNITION_WAKE' });
});

// ── Boot ─────────────────────────────────────────────────────
ensureMic().then((ok) => {
  if (ok) wakeLoop();
});