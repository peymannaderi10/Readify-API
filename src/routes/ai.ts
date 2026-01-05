import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { openai, CHAT_MODEL, REALTIME_MODEL } from '../lib/openai.js';
import { requireAuth, requirePremium } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { env } from '../config/env.js';
import { aiRateLimiter } from '../middleware/rate-limit.js';

const router = Router();

// ============================================
// VALIDATION CONSTANTS (OWASP: Define reasonable limits)
// ============================================
const MAX_MESSAGE_LENGTH = 4000;        // Max user message length
const MAX_PAGE_CONTENT_LENGTH = 100000; // Max page content (~100KB of text)
const MAX_TITLE_LENGTH = 500;           // Max page title
const MAX_URL_LENGTH = 2048;            // Standard max URL length
const MAX_HISTORY_ITEMS = 50;           // Max conversation history items
const MAX_HISTORY_CONTENT_LENGTH = 4000; // Max content per history item

// ============================================
// POST /ai/chat - Streaming text chat with SSE
// ============================================

/**
 * Chat request schema with strict validation (OWASP: Input Validation)
 * - All string fields have max length limits to prevent memory exhaustion
 * - .strict() rejects any unexpected fields
 * - History array is limited in both count and content size
 */
const chatSchema = z.object({
  message: z.string()
    .min(1, 'Message cannot be empty')
    .max(MAX_MESSAGE_LENGTH, `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`),
  pageContent: z.string()
    .max(MAX_PAGE_CONTENT_LENGTH, `Page content cannot exceed ${MAX_PAGE_CONTENT_LENGTH} characters`)
    .optional(),
  pageTitle: z.string()
    .max(MAX_TITLE_LENGTH, `Page title cannot exceed ${MAX_TITLE_LENGTH} characters`)
    .optional(),
  pageUrl: z.string()
    .max(MAX_URL_LENGTH, `URL cannot exceed ${MAX_URL_LENGTH} characters`)
    .optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(MAX_HISTORY_CONTENT_LENGTH),
  })).max(MAX_HISTORY_ITEMS, `History cannot exceed ${MAX_HISTORY_ITEMS} messages`).optional(),
}).strict(); // Reject unexpected fields

// Apply AI-specific rate limiting (20 req/min) + auth + premium check
router.post('/chat', aiRateLimiter, requireAuth, requirePremium, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = chatSchema.parse(req.body);
    const { message, pageContent, pageTitle, pageUrl, history = [] } = body;

    // Build system prompt with page context if available
    let systemPrompt = 'You are a helpful reading assistant.';
    
    if (pageContent) {
      systemPrompt = `You are a reading assistant. Answer questions using ONLY the webpage content provided below.

RULES:
1. Be concise - give clear, helpful answers (1-3 sentences when possible).
2. Only use information from the page content.
3. If something is not in the content, say "I don't see that information on this page."
4. Be conversational and helpful.

WEBPAGE: ${pageTitle || 'Unknown'}
URL: ${pageUrl || 'Unknown'}

CONTENT:
${pageContent.substring(0, 50000)}`;
    }

    // Build messages array
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user', content: message },
    ];

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Create streaming completion
    const stream = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
      stream: true,
    });

    // Stream chunks to client
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    // Send done event
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error);
    
    // If headers already sent, can't send JSON error
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Stream error occurred' })}\n\n`);
      res.end();
      return;
    }
    
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

// ============================================
// POST /ai/realtime-token - Get ephemeral token for Realtime API
// ============================================

/**
 * Realtime token request schema with strict validation (OWASP: Input Validation)
 * - Voice is restricted to known valid values
 * - All optional strings have length limits
 */
const realtimeTokenSchema = z.object({
  pageContent: z.string()
    .max(MAX_PAGE_CONTENT_LENGTH, `Page content cannot exceed ${MAX_PAGE_CONTENT_LENGTH} characters`)
    .optional(),
  pageTitle: z.string()
    .max(MAX_TITLE_LENGTH, `Page title cannot exceed ${MAX_TITLE_LENGTH} characters`)
    .optional(),
  pageUrl: z.string()
    .max(MAX_URL_LENGTH, `URL cannot exceed ${MAX_URL_LENGTH} characters`)
    .optional(),
  voice: z.enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'])
    .optional()
    .default('verse'),
}).strict(); // Reject unexpected fields

// Apply AI-specific rate limiting (20 req/min) + auth + premium check
router.post('/realtime-token', aiRateLimiter, requireAuth, requirePremium, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = realtimeTokenSchema.parse(req.body);
    const { pageContent, pageTitle, pageUrl, voice = 'verse' } = body;

    // Build instructions with page context
    let instructions = 'You are a helpful voice assistant. Be concise and conversational.';
    
    if (pageContent) {
      instructions = `You are a reading assistant having a voice conversation. Answer questions using ONLY the webpage content below.

RULES:
1. Be CONCISE - give brief, conversational answers (1-3 sentences).
2. Only use information from the page content.
3. If something is not in the content, say "I don't see that on this page."
4. Speak naturally, as if having a conversation.

WEBPAGE: ${pageTitle || 'Unknown'}
URL: ${pageUrl || 'Unknown'}

CONTENT:
${pageContent.substring(0, 50000)}`;
    }

    // Request ephemeral token from OpenAI
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        voice: voice,
        instructions: instructions,
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 2000, // Wait 2 seconds of silence before triggering response
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI Realtime session error:', errorText);
      throw new AppError('Failed to create realtime session', 500, 'REALTIME_ERROR');
    }

    const sessionData = await response.json() as {
      client_secret: { value: string; expires_at: number };
      id: string;
      expires_at?: number;
    };

    // Return the ephemeral token and session config
    res.json({
      success: true,
      client_secret: sessionData.client_secret,
      session_id: sessionData.id,
      model: REALTIME_MODEL,
      voice: voice,
      expires_at: sessionData.client_secret.expires_at,
    });

  } catch (error) {
    console.error('Realtime token error:', error);
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

// ============================================
// POST /ai/tts - Text-to-speech (optional endpoint)
// ============================================

/**
 * TTS request schema with strict validation (OWASP: Input Validation)
 * - Text has strict min/max limits
 * - Voice is restricted to OpenAI's valid voices
 * - Speed is bounded to valid range
 */
const ttsSchema = z.object({
  text: z.string()
    .min(1, 'Text cannot be empty')
    .max(4096, 'Text cannot exceed 4096 characters'),
  voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
    .optional()
    .default('nova'),
  speed: z.number()
    .min(0.25, 'Speed must be at least 0.25')
    .max(4.0, 'Speed cannot exceed 4.0')
    .optional()
    .default(1.0),
}).strict(); // Reject unexpected fields

// Apply AI-specific rate limiting (20 req/min) + auth + premium check
router.post('/tts', aiRateLimiter, requireAuth, requirePremium, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = ttsSchema.parse(req.body);
    const { text, voice = 'nova', speed = 1.0 } = body;

    const mp3Response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice,
      input: text,
      speed: speed,
    });

    // Get the audio as a buffer
    const buffer = Buffer.from(await mp3Response.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);

  } catch (error) {
    console.error('TTS error:', error);
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

export default router;

