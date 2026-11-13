// ============================================================
// USWMClient — talks to the Python USWM sidecar on :3001
// Used by ShadowCompanion in content.js
// ============================================================

const USWM_BASE = 'http://localhost:3001';

export class USWMClient {
  constructor(sessionId) {
    this._sessionId = sessionId;
    this._ready = false;
    this._initPromise = null;
    this._lastStrategy = null;
  }

  async _ensureReady() {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        const res = await fetch(`${USWM_BASE}/session/new`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error(`USWM session/new failed: ${res.status}`);
        const data = await res.json();
        this._sessionId = data.session_id;
        this._ready = true;
        console.log('[USWM] Session ready:', this._sessionId.slice(0, 8));
      } catch (err) {
        console.warn('[USWM] Sidecar unavailable — running without USWM:', err.message);
        this._ready = false;
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  async observe({ source, content, pageContext } = {}) {
    await this._ensureReady();
    if (!this._ready) return;
    if (source !== 'user') return;

    try {
      await fetch(`${USWM_BASE}/session/${this._sessionId}/observe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content, source }),
      });
    } catch (err) {
      console.warn('[USWM] observe failed:', err.message);
    }
  }

  async getStrategy() {
    await this._ensureReady();
    if (!this._ready) {
      return { strategy: null, gateOpen: false };
    }

    try {
      const res = await fetch(`${USWM_BASE}/session/${this._sessionId}/strategy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`strategy failed: ${res.status}`);
      const data = await res.json();
      this._lastStrategy = data;
      console.log(
        `[USWM] strategy=${data.strategyName} gateOpen=${data.gateOpen} ` +
        `source=${data.source} gate=${data.gate?.toFixed(3)} conf=${data.confidence?.toFixed(3)}`
      );
      return {
        strategy: data.strategyName,
        gateOpen: data.gateOpen,
      };
    } catch (err) {
      console.warn('[USWM] getStrategy failed:', err.message);
      return { strategy: null, gateOpen: false };
    }
  }

  async getEmotionalState() {
    if (!this._lastStrategy) return { dominantEmotion: 'idle', intensity: 0.3 };
    const { strategyName, gateOpen, confidence } = this._lastStrategy;
    if (!gateOpen) return { dominantEmotion: 'idle', intensity: 0.3 };

    const map = {
      'Question':                 { dominantEmotion: 'excited',    intensity: 0.5 },
      'Restatement/Paraphrase':   { dominantEmotion: 'calm',       intensity: 0.4 },
      'Reflection of Feelings':   { dominantEmotion: 'sad',        intensity: 0.6 },
      'Self-disclosure':          { dominantEmotion: 'calm',       intensity: 0.5 },
      'Affirmation/Reassurance':  { dominantEmotion: 'excited',    intensity: 0.7 },
      'Providing Suggestions':    { dominantEmotion: 'thinking',   intensity: 0.6 },
      'Information':              { dominantEmotion: 'idle',       intensity: 0.4 },
      'Others':                   { dominantEmotion: 'idle',       intensity: 0.3 },
    };

    return map[strategyName] ?? { dominantEmotion: 'idle', intensity: 0.3 };
  }

  async destroy() {
    if (!this._ready) return;
    try {
      await fetch(`${USWM_BASE}/session/${this._sessionId}`, { method: 'DELETE' });
    } catch (_) {}
    this._ready = false;
  }
}
