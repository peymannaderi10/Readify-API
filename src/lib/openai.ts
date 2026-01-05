import OpenAI from 'openai';
import { env } from '../config/env.js';

// OpenAI client instance
export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

// Model configuration
export const CHAT_MODEL = env.OPENAI_CHAT_MODEL;
export const REALTIME_MODEL = env.OPENAI_REALTIME_MODEL;

