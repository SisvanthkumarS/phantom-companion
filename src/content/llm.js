// ============================================================
// LLM transport — talks to the local proxy backend, never the
// Anthropic API directly (no key ships in the extension).
// Supports vision: pass a screenshot dataUrl alongside the text.
// Falls back to an in-character line if the backend is unreachable.
// ============================================================

const FALLBACK_RESPONSES = [
  "I'm here. Signal's just quiet right now.",
  "Still with you. Speak again.",
  "The line's thin, but I haven't gone anywhere.",
];

function fallbackResponse() {
  return FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
}

export async function getShadowResponse({ message, systemPrompt, screenshot, backendUrl = 'http://localhost:3000/chat' }) {
  try {
    const controller = new AbortController();
    // Vision calls take longer — 15s budget
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, systemPrompt, screenshot }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Backend responded with ${response.status}`);
    }

    const data = await response.json();
    if (!data.reply) {
      throw new Error('Backend response missing reply');
    }

    return data.reply;
  } catch (err) {
    console.warn('[Shadow] LLM backend unreachable, using fallback response:', err);
    return fallbackResponse();
  }
}