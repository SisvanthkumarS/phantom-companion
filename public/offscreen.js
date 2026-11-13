// ============================================================
// Offscreen Recognition Host
// Owns the microphone. Exactly ONE capture is ever in flight.
// State is explicit and driven by the content script.
// ============================================================

const KEYWORD = 'arise';
const BACKEND = 'http://localhost:3000';
const WAKE_RMS_THRESHOLD = 0.01;
const COMMAND_RMS_THRESHOLD = 0.006;

let state = 'wake';
let muted = false;
let micStream = null;
let wakeLoopRunning = false;

let activeRecorder = null;
let activeAudioCtx = null;

let port = null;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'recognition' });
  } catch (err) {
    setTimeout(connectPort, 500);
    return;
  }

  port.postMessage({ type: 'RECOGNITION_READY' });

  port.onMessage.addListener((message) => {
    switch (message.type) {
      case 'RECOGNITION_START':
        if (message.mode === 'command') {
          enterCommand();
        } else {
          enterWake();
        }
        break;

      case 'RECOGNITION_STOP':
        // If already idle, just acknowledge — don't reset to wake.
        // This prevents the deadlock guard from racing with command capture.
        if (state === 'idle') {
          safePost({ type: 'RECOGNITION_ENDED' });
        } else {
          enterIdle();
          safePost({ type: 'RECOGNITION_ENDED' });
        }
        break;

      case 'RECOGNITION_MUTE':
        muted = true;
        abortActiveCapture();
        break;

      case 'RECOGNITION_UNMUTE':
        setTimeout(() => { muted = false; }, 400);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectPort, 500);
  });
}

function safePost(message) {
  try {
    if (!port) connectPort();
    port.postMessage(message);
  } catch (err) {
    console.warn('[Shadow] Port post failed, reconnecting:', err.message);
    port = null;
    setTimeout(connectPort, 200);
  }
}

connectPort();

// ── State transitions ────────────────────────────────────────
function enterWake() {
  if (state === 'wake') return;
  console.log('[Shadow] → wake');
  state = 'wake';
  abortActiveCapture();
  startWakeLoop();
}

function enterCommand() {
  console.log('[Shadow] → command');
  state = 'command';
  abortActiveCapture();
  captureCommand();
}

function enterIdle() {
  if (state === 'idle') return;
  console.log('[Shadow] → idle');
  state = 'idle';
  abortActiveCapture();
}

// ── Mic setup ────────────────────────────────────────────────
async function ensureMic() {
  if (micStream) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return true;
  } catch (err) {
    console.warn('[Shadow] Mic denied in offscreen document:', err);
    safePost({ type: 'RECOGNITION_MIC_BLOCKED' });
    return false;
  }
}

// ── Abort whatever is currently recording ────────────────────
function abortActiveCapture() {
  const rec = activeRecorder;
  activeRecorder = null;
  if (rec) {
    rec._aborted = true;
    try {
      if (rec.state === 'recording') rec.stop();
    } catch (err) {}
  }
  const ctx = activeAudioCtx;
  activeAudioCtx = null;
  if (ctx) {
    try {
      if (ctx.state !== 'closed') ctx.close();
    } catch (err) {}
  }
}

// ── Record one clip. Resolves null if aborted. ───────────────
function recordClip({ maxMs = 4000, silenceStop = false }) {
  return new Promise((resolve) => {
    let recorder;
    try {
      recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' });
    } catch (err) {
      resolve(null);
      return;
    }

    activeRecorder = recorder;
    const chunks = [];
    let settled = false;
    let maxTimer = null;
    let silenceTimer = null;
    let tick = null;

    const cleanup = () => {
      clearTimeout(maxTimer);
      clearTimeout(silenceTimer);
      clearInterval(tick);
      if (activeRecorder === recorder) activeRecorder = null;
    };

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    recorder.onstop = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (recorder._aborted) {
        resolve(null);
      } else {
        resolve(new Blob(chunks, { type: 'audio/webm' }));
      }
    };

    if (silenceStop) {
      try {
        const ctx = new AudioContext();
        activeAudioCtx = ctx;
        const source = ctx.createMediaStreamSource(micStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let spoke = false;

        tick = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let rms = 0;
          for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
          rms = Math.sqrt(rms / buf.length);

          if (rms > 0.012) {
            spoke = true;
            clearTimeout(silenceTimer);
            silenceTimer = null;
          } else if (spoke && !silenceTimer) {
            silenceTimer = setTimeout(() => {
              if (recorder.state === 'recording') recorder.stop();
            }, 1500); // extended from 1000ms for longer words like "disappear"
          }
        }, 100);
      } catch (err) {
        // Silence detection unavailable — fall back to maxMs only.
      }
    }

    recorder.start();
    maxTimer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, maxMs);
  });
}

// ── Loudness gate ────────────────────────────────────────────
async function clipRms(blob) {
  try {
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  } catch (err) {
    return Infinity;
  }
}

// ── Transcribe via backend ───────────────────────────────────
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
    console.warn('[Shadow] Transcribe failed:', err.message);
    safePost({ type: 'RECOGNITION_ERROR', error: 'transcribe-failed' });
    return '';
  }
}

// ── Wake loop ────────────────────────────────────────────────
async function startWakeLoop() {
  if (wakeLoopRunning) return;
  wakeLoopRunning = true;

  while (state === 'wake') {
    if (muted) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    const clip = await recordClip({ maxMs: 4000 });

    if (!clip || state !== 'wake' || muted) continue;

    const rms = await clipRms(clip);
    if (rms < WAKE_RMS_THRESHOLD) continue;

    if (state !== 'wake') continue;

    const transcript = await transcribeClip(clip);
    console.log('[Shadow] wake heard:', transcript || '(nothing)');

    if (state !== 'wake') continue;

    if (transcript.toLowerCase().includes(KEYWORD)) {
      console.log('[Shadow] wake word detected → idle, awaiting command');
      state = 'idle';
      safePost({ type: 'RECOGNITION_WAKE' });

      // Extended deadlock guard — gives content script time to send command START
      setTimeout(() => {
        if (state === 'idle') {
          console.warn('[Shadow] Wake unanswered — resuming wake loop.');
          enterWake();
        }
      }, 15000); // was 12000
    }
  }

  wakeLoopRunning = false;
}

// ── Command capture ──────────────────────────────────────────
async function captureCommand() {
  let waited = 0;
  while (muted && waited < 5000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  if (state !== 'command') return;

  const clip = await recordClip({ maxMs: 8000, silenceStop: true });

  if (!clip || state !== 'command') {
    safePost({ type: 'RECOGNITION_RESULT', transcript: '' });
    safePost({ type: 'RECOGNITION_ENDED' });
    return;
  }

  const rms = await clipRms(clip);
  if (rms < COMMAND_RMS_THRESHOLD) {
    console.log('[Shadow] command heard: (silence, gated)');
    safePost({ type: 'RECOGNITION_RESULT', transcript: '' });
    safePost({ type: 'RECOGNITION_ENDED' });
    state = 'idle';
    return;
  }

  const transcript = await transcribeClip(clip);
  console.log('[Shadow] command heard:', transcript || '(nothing)');

  safePost({ type: 'RECOGNITION_RESULT', transcript });
  safePost({ type: 'RECOGNITION_ENDED' });

  state = 'idle';
}

// ── Boot ─────────────────────────────────────────────────────
ensureMic().then((ok) => {
  if (ok) startWakeLoop();
});