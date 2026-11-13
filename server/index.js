// ============================================================
// Shadow proxy server
//  - POST /chat        → Claude via AWS Bedrock (vision-capable)
//  - POST /transcribe  → Deepgram Nova-2 STT
//  - POST /tts         → Kokoro local TTS
// ============================================================

import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { KokoroTTS } from 'kokoro-js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // screenshots are big

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// ── Kokoro TTS init ──────────────────────────────────────────
let kokoroTTS = null;
let kokoroLoading = null;

async function getKokoro() {
  if (kokoroTTS) return kokoroTTS;
  if (kokoroLoading) return kokoroLoading;

  kokoroLoading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
  }).then((tts) => {
    kokoroTTS = tts;
    kokoroLoading = null;
    console.log('[Shadow server] Kokoro TTS ready.');
    return tts;
  });

  return kokoroLoading;
}

getKokoro().catch((err) =>
  console.warn('[Shadow server] Kokoro pre-warm failed:', err.message)
);

// ── /tts — Kokoro TTS → wav buffer ──────────────────────────
app.post('/tts', async (req, res) => {
  const { text, voice = 'bf_emma', speed = 1.1 } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const tts = await getKokoro();
    const audio = await tts.generate(text, { voice, speed });
    const wavBuffer = float32ToWav(audio.audio, audio.sampling_rate);
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', wavBuffer.length);
    res.send(wavBuffer);
  } catch (err) {
    console.error('[Shadow server] TTS error:', err.message);
    res.status(502).json({ error: 'TTS failed' });
  }
});

// ── Float32 PCM → WAV buffer ─────────────────────────────────
function float32ToWav(float32Array, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = float32Array.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    buffer.writeInt16LE(Math.round(s * 32767), offset);
    offset += 2;
  }

  return buffer;
}

// ── /chat — Claude via Bedrock (vision-capable) ─────────────
app.post('/chat', async (req, res) => {
  const { message, systemPrompt, screenshot } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  console.log(
    '[Shadow server] /chat | prompt:', systemPrompt?.length ?? 0,
    'chars | vision:', !!screenshot,
    '| msg:', message?.slice(0, 60)
  );

  // Build message content — text always, image when provided
  let userContent;
  if (screenshot && screenshot.startsWith('data:image')) {
    const base64Data = screenshot.split(',')[1];
    const mediaType = screenshot.split(';')[0].split(':')[1]; // e.g. 'image/jpeg'
    userContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64Data },
      },
      { type: 'text', text: message },
    ];
  } else {
    userContent = message;
  }

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 150,
    system: systemPrompt ?? '',
    messages: [{ role: 'user', content: userContent }],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await bedrock.send(command);
      const data = JSON.parse(Buffer.from(response.body).toString());
      return res.json({ reply: data.content?.[0]?.text ?? '' });
    } catch (err) {
      const isThrottle = err?.name === 'ThrottlingException' || err?.$metadata?.httpStatusCode === 429;
      if (isThrottle && attempt < 2) {
        const delay = (attempt + 1) * 2000;
        console.warn(`[Shadow server] Bedrock throttled, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error('[Shadow server] Bedrock error:', err.message || err);
      return res.status(502).json({ error: 'Bedrock call failed' });
    }
  }
});

// ── /transcribe — webm blob → Deepgram Nova-2 ───────────────
app.post(
  '/transcribe',
  express.raw({ type: ['audio/webm', 'application/octet-stream'], limit: '10mb' }),
  async (req, res) => {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'empty audio' });
    }

    try {
      const response = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&punctuate=true',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
            'Content-Type': 'audio/webm',
          },
          body: req.body,
        }
      );

      if (!response.ok) {
        const err = await response.text();
        console.error('[Shadow server] Deepgram error:', err);
        return res.status(502).json({ error: 'Transcription failed' });
      }

      const data = await response.json();
      const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
      console.log('[Shadow server] Deepgram transcript:', transcript || '(empty)');
      res.json({ transcript: transcript.trim() });

    } catch (err) {
      console.error('[Shadow server] Transcribe error:', err.message);
      res.status(502).json({ error: 'Transcription failed' });
    }
  }
);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`[Shadow server] Running on :${PORT}`);
  console.log(`[Shadow server] Model: ${MODEL_ID}`);
});