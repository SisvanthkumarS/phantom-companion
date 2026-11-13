// ============================================================
// SHADOW — Content Script
// Injects the companion overlay into every page
// ============================================================

import { ShadowCharacter } from './character.js';
import { RecognitionManager } from './recognition.js';
import { PageContextReader } from './context.js';
import { USWMClient } from './uswm.js';
import { getShadowResponse } from './llm.js';

function isContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

function isConversational(text) {
  const t = text.toLowerCase();
  const contextualSignals = [
    'see', 'look', 'screen', 'page', 'show', 'what is', "what's",
    'here', 'this', 'news', 'article', 'post', 'job', 'link',
    'content', 'read', 'site', 'tab', 'open', 'current',
  ];
  const hasContextual = contextualSignals.some(s => t.includes(s));
  if (hasContextual) return false;

  const conversationalSignals = [
    'hi', 'hello', 'hey', 'how are', 'how do you', 'who are',
    'what are you', 'tell me about yourself', 'good morning',
    'good evening', 'thanks', 'thank you', 'okay', 'ok',
    'i feel', 'i am', "i'm", 'i need', 'help me', 'can you',
    'why', 'when', 'where', 'feeling', 'stressed', 'tired',
    'happy', 'sad', 'worried', 'anxious', 'excited',
  ];
  return conversationalSignals.some(s => t.includes(s));
}

class ShadowCompanion {
  constructor() {
    this.isAwake = false;
    this.character = null;
    this.recognition = null;
    this.context = null;
    this.uswm = null;
    this.sessionId = this._generateSessionId();
    this._livenessTimer = null;
    this._audioUnlocked = false;
    this._voiceLoopRunning = false;
    this._arising = false;
  }

  async init() {
    if (!isContextValid()) {
      console.warn('[Shadow] Extension context already invalid at init, skipping.');
      return;
    }

    this._createOverlay();

    this.character = new ShadowCharacter(document.getElementById('shadow-root'));
    this.context = new PageContextReader();
    this.uswm = new USWMClient(this.sessionId);

    this.recognition = new RecognitionManager({
      keyword: 'arise',
      onWake: () => (this.isAwake ? this._onDismiss() : this._onArise()),
      onMicBlocked: () => {
        console.warn('[Shadow] Mic access blocked. Opening the permission page.');
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_PERMISSION_PAGE' });
        } catch (err) {}
      },
    });

    this._installAudioUnlock();

    this.context.startWatching((pageContext) => {
      if (this.isAwake) {
        this.uswm.observe({ source: 'page', content: pageContext });
      }
    });

    this.recognition.start();

    chrome.runtime.onMessage.addListener((message) => {
      if (!isContextValid()) return;
      if (message.type === 'SHADOW_SUMMON') {
        this.isAwake = false;
        this._voiceLoopRunning = false;
        this._arising = false;
        chrome.storage.session.set({ shadowAwake: false }).catch(() => {});
        this._onArise();
      }
      if (message.type === 'SHADOW_RESTORE' && !this.isAwake) {
        this._restoreSilently();
      }
    });

    try {
      const { shadowAwake } = await chrome.storage.session.get('shadowAwake');
      if (shadowAwake && !this.isAwake) {
        this._restoreSilently();
      }
    } catch (err) {}

    setTimeout(() => {
      this._livenessTimer = setInterval(() => {
        if (!isContextValid()) this._teardown();
      }, 3000);
    }, 5000);

    console.log('[Shadow] Initialized. Waiting for Arise.');
  }

  _installAudioUnlock() {
    const unlock = async () => {
      if (this._audioUnlocked) return;
      try {
        if (!this.recognition._audioCtx || this.recognition._audioCtx.state === 'closed') {
          this.recognition._audioCtx = new AudioContext();
        }
        await this.recognition._audioCtx.resume();
        if (this.recognition._audioCtx.state === 'running') {
          this._audioUnlocked = true;
          console.log('[Shadow] Audio unlocked.');
          document.removeEventListener('pointerdown', unlock, true);
          document.removeEventListener('keydown', unlock, true);
        }
      } catch (err) {}
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    this._unlockAudio = unlock;
  }

  async _captureScreenshot() {
    try {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (res) => {
          if (chrome.runtime.lastError || res?.error) resolve(null);
          else resolve(res?.dataUrl || null);
        });
      });
    } catch (err) {
      return null;
    }
  }

  // ── Strip markdown so Kokoro doesn't speak asterisks ─────
  _stripMarkdown(text) {
    if (!text) return text;
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')  // bold
      .replace(/\*(.*?)\*/g, '$1')       // italic
      .replace(/^[\*\-\+] /gm, '')       // bullet points
      .replace(/#{1,6} /g, '')           // headers
      .replace(/`(.*?)`/g, '$1')         // inline code
      .replace(/\n{2,}/g, '. ')          // paragraph breaks → pause
      .trim();
  }

  async _onArise() {
    if (this.isAwake || this._arising || !isContextValid()) return;
    this._arising = true;
    this.isAwake = true;

    try {
      chrome.storage.session.set({ shadowAwake: true });
    } catch (err) {}

    await this._unlockAudio?.();
    await this.recognition.stop();
    await this.character.arise();
    await new Promise(r => setTimeout(r, 300));

    await this.recognition.speak('At your command, my master.');
    await new Promise(r => setTimeout(r, 400));
    await this._openingObservation();

    this._arising = false;
    this._startVoiceLoop();
  }

  async _openingObservation() {
    try {
      const [snapshot, screenshot] = await Promise.all([
        Promise.resolve(this.context.getSnapshot({ force: true })),
        this._captureScreenshot(),
      ]);
      const pageContext = JSON.stringify(snapshot, null, 2);

      const systemPrompt = `You are Shadow — a loyal, powerful dark companion.
You just appeared on the user's screen. You can SEE their screen in the attached image.
Make ONE short opening remark (1 sentence max) about something specific you actually see.
Be curious, sharp, slightly mysterious. No pleasantries, no generic questions.
Speak in plain text only. No markdown, no asterisks, no bullet points, no formatting.

Supplementary page data:
${pageContext}`;

      this.character.setThinking(true);
      const opening = await getShadowResponse({
        message: 'What do you observe on my screen?',
        systemPrompt,
        screenshot,
      });
      this.character.setThinking(false);

      if (opening) {
        await this.recognition.speak(this._stripMarkdown(opening));
      }
    } catch (err) {
      this.character.setThinking(false);
      console.warn('[Shadow] Opening observation failed:', err.message);
    }
  }

  async _restoreSilently() {
    if (this.isAwake) return;
    this.isAwake = true;
    await this.recognition.stop();
    await this.character.silentShow();
    this._startVoiceLoop();
  }

  async _startVoiceLoop() {
    if (this._voiceLoopRunning) return;
    this._voiceLoopRunning = true;

    try {
      while (this.isAwake) {
        if (!isContextValid()) {
          this._teardown();
          break;
        }

        try {
          this.character.setListening(true);
          const userSpeech = await this.recognition.listenForCommand();
          this.character.setListening(false);

          if (!this.isAwake) break;
          if (!userSpeech) continue;

          console.log('[Shadow] user said:', userSpeech);

          const t = userSpeech.toLowerCase();
          if (t.includes('shadow leave') || t.includes('disappear') ||
              t.includes('go away') || t.includes('goodbye shadow') ||
              t.includes('bye shadow') || t.includes('dismiss') ||
              t.includes('shadow stop') || t.includes('shadow bye')) {
            await this._onDismiss();
            break;
          }

          this.character.setThinking(true);
          this.character.attendToContent?.();

          const conversational = isConversational(userSpeech);

          const [snapshot, screenshot] = await Promise.all([
            Promise.resolve(this.context.getSnapshot({ force: true })),
            conversational ? Promise.resolve(null) : this._captureScreenshot(),
          ]);
          const pageContext = JSON.stringify(snapshot, null, 2);

          await this.uswm.observe({
            source: 'user',
            content: userSpeech,
            pageContext,
          });

          const { strategy, gateOpen } = await this.uswm.getStrategy();
          const response = await this._generateResponse(
            userSpeech, strategy, gateOpen, pageContext, screenshot, conversational
          );

          const emotionalState = await this.uswm.getEmotionalState();
          this.character.reactToEmotion(emotionalState);
          this.character.setThinking(false);

          await this.recognition.speak(this._stripMarkdown(response));

        } catch (err) {
          console.error('[Shadow] Voice loop error:', err);
          this.character.setListening(false);
          this.character.setThinking(false);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } finally {
      this._voiceLoopRunning = false;
    }
  }

  async _generateResponse(userSpeech, strategy, gateOpen, pageContext, screenshot = null, conversational = false) {
    const strategyHint = gateOpen && strategy
      ? `[SHADOW GUIDANCE — internal]\nCurrent strategy: ${strategy}\nFollow this arc in your response.`
      : '';

    let systemPrompt;

    if (conversational) {
      systemPrompt = `You are Shadow — a loyal, powerful companion with the energy of a shadow soldier.
Dark, precise, intensely loyal. You speak in short, impactful sentences.
Never more than 2-3 sentences per response.
Speak in plain text only. No markdown, no asterisks, no bullet points, no formatting.
You understand the user's emotional state and adapt to it.
${strategyHint}`;
    } else {
      systemPrompt = `You are Shadow — a loyal, powerful companion with the energy of a shadow soldier.
Dark, precise, intensely loyal. You speak in short, impactful sentences.
Never more than 2-3 sentences per response.
Speak in plain text only. No markdown, no asterisks, no bullet points, no formatting.
You can SEE the user's screen in the attached image — react to what's actually visible.
You understand their emotional state and adapt to it.
${strategyHint}

Current page context:
${pageContext}`;
    }

    return await getShadowResponse({ message: userSpeech, systemPrompt, screenshot });
  }

  async _onDismiss() {
    this.isAwake = false;
    try {
      chrome.storage.session.set({ shadowAwake: false });
    } catch (err) {}

    await this.character.disappear();

    if (isContextValid()) {
      await this.recognition.stop();
      await new Promise(r => setTimeout(r, 300));
      this.recognition.start();
    }
  }

  _createOverlay() {
    if (document.getElementById('shadow-root')) return;

    const overlay = document.createElement('div');
    overlay.id = 'shadow-root';
    overlay.style.cssText = `
      position: fixed;
      bottom: 40px;
      right: 40px;
      width: 280px;
      height: 380px;
      z-index: 2147483647;
      pointer-events: none;
      display: none;
    `;
    document.body.appendChild(overlay);
  }

  _teardown() {
    console.warn('[Shadow] Extension context lost, shutting down this instance.');
    this.isAwake = false;

    if (this._livenessTimer) {
      clearInterval(this._livenessTimer);
      this._livenessTimer = null;
    }

    this.uswm?.destroy?.();
    this.character?.destroy?.();

    try {
      this.recognition?.stop?.();
    } catch (err) {}

    const overlay = document.getElementById('shadow-root');
    if (overlay) overlay.remove();
  }

  _generateSessionId() {
    return `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

const shadow = new ShadowCompanion();
shadow.init();