import { NextResponse } from 'next/server';
import { ANTHROPIC_MODELS, type CompactModel } from '@/lib/compact';
import { listOllamaModels, ollamaBaseUrl, ollamaUnreachableHint } from '@/lib/ollama';

export const dynamic = 'force-dynamic';

/**
 * What the compact panel can summarise with, right now.
 *
 * Anthropic's list is fixed and known at build time. Ollama's is not — it is
 * whatever the user has pulled — so it is asked for at request time. Neither
 * being available is a normal state, not an error: with no model at all the
 * panel still assembles the block locally, which is the point of the design.
 *
 * Each provider reports its own unavailability separately, and says what to do
 * about it, because "no models" with no reason is the kind of dead end that
 * sends someone reading source code.
 */
export interface ProviderStatus {
  key: string;
  label: string;
  local: boolean;
  available: boolean;
  reason?: string;
  models: CompactModel[];
}

export async function GET() {
  const anthropicReady = Boolean(process.env.ANTHROPIC_API_KEY);

  const providers: ProviderStatus[] = [
    {
      key: 'anthropic',
      label: 'Anthropic API',
      local: false,
      available: anthropicReady,
      ...(anthropicReady
        ? {}
        : { reason: 'ANTHROPIC_API_KEY is not set. Add it to .env and restart the dashboard.' }),
      models: anthropicReady ? [...ANTHROPIC_MODELS] : [],
    },
  ];

  // A daemon that is not running is the ordinary case on most machines, so it
  // is reported as a state with a fix, never as a failed request.
  try {
    const models = await listOllamaModels(AbortSignal.timeout(2500));
    providers.push({
      key: 'ollama',
      label: 'Ollama (this machine)',
      local: true,
      available: models.length > 0,
      ...(models.length === 0
        ? { reason: `Ollama is running at ${ollamaBaseUrl()} but has no models. Pull one: ollama pull qwen2.5-coder` }
        : {}),
      models,
    });
  } catch {
    providers.push({
      key: 'ollama',
      label: 'Ollama (this machine)',
      local: true,
      available: false,
      reason: `No Ollama daemon at ${ollamaBaseUrl()}. ${
        ollamaUnreachableHint() ?? 'Start one with: ollama serve'
      }`,
      models: [],
    });
  }

  return NextResponse.json({ providers });
}
