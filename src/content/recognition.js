// ============================================================
// RecognitionManager — drives the offscreen mic host.
// ============================================================

const BACKEND = 'http://localhost:3000';

function isContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

export class RecognitionManager {
  constructor({ keyword = 'arise', onWake, onMicBlocked } = {}) {
    this.keyword = keyword.toLowerCase();
    this.onWake = onWake;
    this.onMicBlocked = onMicBlocked;

    this.state = 'idle';
    this._mode = null;
    this._stopWaiters = [];
    this._commandResolvers = null;
    this._hotkeyRegistered = false;
    this._dead = false;
    this._audioCtx = null;

    this._setupHotkey();
    this._wireMessages();
    this._wireHeartbeat();
  }

  _wireHeartbeat() {
    if (!isContextValid()) {
      this._dead = true;
      return;
    }
    try {
      this._heartbeatPort = chrome.runtime.connect({ name: 'shadow-heartbeat' });
      let settled = false;
      setTimeout(() => { settled = true; }, 3000);

      this._heartbeatPort.onDisconnect.addListener(() => {
        if (!settled) {
          setTimeout(() => this._wireHeartbeat(), 1000);
          return;
        }
        this._dead = true;
        this.state = 'idle';
        this._mode = null;
        this._commandResolvers = null;
      });
    } catch (err) {
      this._dead = true;
    }
  }

  start() {
    if (this.state === 'speaking' || this.state === 'mic-blocked') return;
    this.state = 'wake-listening';
    this._mode = 'wake';
    this._send({ type: 'RECOGNITION_START', mode: 'wake' });
  }

  async stop() {
    this.state = 'idle';
    this._mode = null;
    if (this._commandResolvers) {
      clearTimeout(this._commandResolvers.timeoutId);
      this._commandResolvers.resolve('');
      this._commandResolvers = null;
    }
    return this._safeStop();
  }

  async listenForCommand() {
    if (this.state === 'mic-blocked') {
      await new Promise((r) => setTimeout(r, 1000));
      return null;
    }

    await this._safeStop();
    // Small settle delay — lets offscreen fully process STOP before START{command}
    await new Promise(r => setTimeout(r, 200));

    this.state = 'command-listening';

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this._commandResolvers) {
          this._commandResolvers = null;
          if (this.state === 'command-listening') this.state = 'idle';
          resolve(null);
        }
      }, 20000);

      this._commandResolvers = { resolve, timeoutId };
      this._mode = 'command';
      this._send({ type: 'RECOGNITION_START', mode: 'command' });
    });
  }

  async speak(text) {
    if (!text) return;

    this.state = 'speaking';
    await this._safeStop();
    this._send({ type: 'RECOGNITION_MUTE' });

    try {
      const res = await fetch(`${BACKEND}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'bf_emma', speed: 1.1 }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();

      if (!this._audioCtx || this._audioCtx.state === 'closed') {
        this._audioCtx = new AudioContext();
      }
      if (this._audioCtx.state !== 'running') {
        await this._audioCtx.resume().catch(() => {});
      }
      if (this._audioCtx.state !== 'running') {
        throw new Error('audiocontext-blocked');
      }

      const audioBuffer = await this._audioCtx.decodeAudioData(arrayBuffer);
      const source = this._audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._audioCtx.destination);

      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        source.onended = finish;
        source.start(0);
        setTimeout(finish, (audioBuffer.duration * 1000) + 2000);
      });
    } catch (err) {
      console.warn('[Shadow] Kokoro TTS unavailable, using browser TTS:', err.message);
      await this._browserSpeak(text);
    } finally {
      this._send({ type: 'RECOGNITION_UNMUTE' });
      if (this.state === 'speaking') this.state = 'idle';
    }
  }

  _browserSpeak(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      synth.cancel();
      synth.resume();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 0.8;
      utterance.volume = 1.0;

      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
      setTimeout(() => { if (!finished) { synth.cancel(); finish(); } }, 15000);
    });
  }

  retry() {
    if (this.state !== 'mic-blocked') return;
    this.state = 'idle';
    this.start();
  }

  _send(message) {
    if (this._dead || !isContextValid()) return;
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch (err) {
      this._dead = true;
    }
  }

  _safeStop() {
    return new Promise((resolve) => {
      if (this._dead || !isContextValid()) {
        this._dead = true;
        resolve();
        return;
      }

      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      this._stopWaiters.push(done);
      this._send({ type: 'RECOGNITION_STOP' });
      setTimeout(done, 900);
    });
  }

  _wireMessages() {
    chrome.runtime.onMessage.addListener((message) => {
      switch (message.type) {
        case 'RECOGNITION_WAKE':   this._handleWake(); break;
        case 'RECOGNITION_RESULT': this._handleResult(message.transcript); break;
        case 'RECOGNITION_ERROR':  this._handleError(message.error); break;
        case 'RECOGNITION_ENDED':  this._handleEnded(); break;
      }
    });
  }

  _handleWake() {
    if (this._mode !== 'wake') return;
    this._mode = null;
    this.state = 'idle';
    this.onWake?.();
  }

  _handleResult(transcript) {
    const resolvers = this._commandResolvers;
    if (!resolvers) return;
    clearTimeout(resolvers.timeoutId);
    this._commandResolvers = null;
    if (this.state === 'command-listening') this.state = 'idle';
    resolvers.resolve(transcript ?? '');
  }

  _handleError(error) {
    if (error === 'not-allowed') {
      const wasBlocked = this.state === 'mic-blocked';
      this.state = 'mic-blocked';
      if (this._commandResolvers) {
        clearTimeout(this._commandResolvers.timeoutId);
        const r = this._commandResolvers;
        this._commandResolvers = null;
        r.resolve(null);
      }
      if (!wasBlocked) {
        console.warn('[Shadow] Mic permission denied.');
        this.onMicBlocked?.();
      }
      return;
    }

    if (this._commandResolvers) {
      clearTimeout(this._commandResolvers.timeoutId);
      const r = this._commandResolvers;
      this._commandResolvers = null;
      if (this.state === 'command-listening') this.state = 'idle';
      r.resolve('');
    }
  }

  _handleEnded() {
    const waiters = this._stopWaiters;
    this._stopWaiters = [];
    waiters.forEach((fn) => fn());
  }

  _setupHotkey() {
    if (this._hotkeyRegistered) return;
    this._hotkeyRegistered = true;
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyA') {
        e.preventDefault();
        this.onWake?.();
      }
    });
    console.log('[Shadow] Hotkey active: Option+A to summon Shadow');
  }
}