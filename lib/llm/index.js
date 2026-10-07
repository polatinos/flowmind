'use strict';

const anthropic = require('./anthropic');
const openai = require('./openai');
const gemini = require('./gemini');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { TOOL_DEFINITIONS } = require('../tools');

// Labels are shown as-is in both languages, so keep them to brand names: the
// UI already appends the model name.
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    run: anthropic.runConversation,
    defaultModel: anthropic.DEFAULT_MODEL,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    needsBaseUrl: false,
  },
  openai: {
    label: 'OpenAI (GPT)',
    run: openai.runConversation,
    defaultModel: openai.DEFAULT_MODEL,
    // Only models that still do function calling on Chat Completions. The
    // GPT-6 family moved tool calls to the Responses API (6.1 Sol refuses
    // them on Chat Completions outright), which openai.js does not speak.
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    needsBaseUrl: false,
  },
  gemini: {
    label: 'Google Gemini',
    run: gemini.runConversation,
    defaultModel: gemini.DEFAULT_MODEL,
    // Gemini 2.5 is shut down in October 2026.
    models: ['gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-3.5-flash-lite'],
    needsBaseUrl: false,
  },
  zen: {
    // OpenCode Zen, OpenAI-compatible, so it reuses the OpenAI tool-use path
    // with a fixed base URL. It needs a paid key (opencode.ai/auth): since
    // 2026-10 the free models answer "FreeTierError: free tier can only be
    // used from within OpenCode" to any other client.
    // Only models Zen serves on /chat/completions belong here; its GPT and
    // Claude models live on /responses and /messages.
    // NB: the Zen API wants bare model ids ("kimi-k3"), NOT "opencode/…".
    label: 'OpenCode Zen',
    run: openai.runConversation,
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'glm-5.3', 'qwen3.8-max', 'deepseek-v4-pro', 'minimax-m3'],
    fixedBaseUrl: 'https://opencode.ai/zen/v1',
    needsBaseUrl: false,
  },
  compatible: {
    // OpenAI-compatible endpoint: Ollama, Groq, LM Studio, vLLM, or Google's
    // OpenAI-compatible Gemini endpoint. Requires a base URL + model.
    label: 'OpenAI-compatible (Ollama/Groq)',
    run: openai.runConversation,
    defaultModel: '',
    models: [],
    needsBaseUrl: true,
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    defaultModel: p.defaultModel,
    models: p.models,
    needsBaseUrl: Boolean(p.needsBaseUrl),
    fixedBaseUrl: p.fixedBaseUrl || null,
  }));
}

/**
 * Run one assistant turn against the selected provider's tool-use loop.
 *
 * @param {object} p
 * @param {string} p.provider          'anthropic' | 'openai' | 'gemini' | 'compatible'
 * @param {string} p.apiKey
 * @param {string} [p.model]
 * @param {string} [p.baseUrl]         required for the 'compatible' provider
 * @param {Array<{role,content}>} p.messages
 * @param {HomeyContext} p.homeyContext
 * @param {(msg)=>void} [p.log]
 * @param {(step)=>void} [p.onStep]  live progress: { tool, status: 'running'|'ok'|'error', error? }
 * @returns {Promise<{ reply, steps, provider, model }>}
 */
async function runAssistant({
  provider, apiKey, model, baseUrl, messages, homeyContext, log, onStep, maxSteps = 10,
}) {
  const chosen = PROVIDERS[provider];
  if (!chosen) throw new Error(`Unknown provider: ${provider}`);
  if (chosen.needsBaseUrl && !baseUrl) {
    throw new Error(`The ${provider} provider needs a base URL (e.g. http://<homey-ip>:11434/v1).`);
  }
  if (!apiKey && !chosen.needsBaseUrl) {
    throw new Error(`No API key configured for ${provider}.`);
  }

  const effectiveBaseUrl = chosen.fixedBaseUrl || baseUrl;
  const usedModel = model || chosen.defaultModel;

  // Inject the persistent memories into the system prompt for this turn.
  let system = SYSTEM_PROMPT;
  try {
    const memories = homeyContext.getMemoriesText();
    if (memories) system += `\n\n## Saved memories\n${memories}`;
  } catch (err) {
    // Memory is a nice-to-have; never block a chat turn on it.
  }

  const { reply, steps } = await chosen.run({
    apiKey,
    model: usedModel,
    baseUrl: effectiveBaseUrl,
    system,
    messages,
    tools: TOOL_DEFINITIONS,
    // Log failing tools: without this a broken tool is invisible in the app
    // log, and the only trace is the steps panel in the settings page.
    executeTool: async (name, input) => {
      // Live progress for the settings page; a broken listener must never
      // break the turn itself.
      if (onStep) try { onStep({ tool: name, status: 'running' }); } catch (err) { /* ignore */ }
      const result = await homeyContext.executeTool(name, input);
      if (result && result.error && log) log(`[tool] ${name} failed: ${result.error}`);
      if (onStep) {
        const failed = Boolean(result && result.error);
        try {
          onStep({
            tool: name,
            status: failed ? 'error' : 'ok',
            ...(failed ? { error: String(result.error).slice(0, 200) } : {}),
          });
        } catch (err) { /* ignore */ }
      }
      return result;
    },
    maxSteps,
    log,
  });

  return { reply, steps, provider, model: usedModel };
}

module.exports = { runAssistant, listProviders, PROVIDERS };
