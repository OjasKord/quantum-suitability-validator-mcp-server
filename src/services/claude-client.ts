import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../constants.js';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

export async function callClaude(userPrompt: string, maxTokens = 4096): Promise<string> {
  const client = getClient();

  let clearTimer: () => void = () => { /* noop */ };
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error('Claude API timeout after 25s')), 25000);
    clearTimer = () => clearTimeout(id);
  });

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      }),
      timeoutPromise
    ]);

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text content in Claude response');
    }
    return textBlock.text;
  } finally {
    clearTimer();
  }
}

export function parseClaudeJSON<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  return JSON.parse(cleaned) as T;
}
