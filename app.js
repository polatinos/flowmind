'use strict';

const Homey = require('homey');
const HomeyContext = require('./lib/HomeyContext');
const { runAssistant, listProviders } = require('./lib/llm');

const SETTINGS = {
  PROVIDER: 'provider',
  MODEL: 'model',
  ZEN_KEY: 'zenApiKey',
  ANTHROPIC_KEY: 'anthropicApiKey',
  OPENAI_KEY: 'openaiApiKey',
  GEMINI_KEY: 'geminiApiKey',
  COMPATIBLE_KEY: 'compatibleApiKey',
  COMPATIBLE_BASE_URL: 'compatibleBaseUrl',
  ENABLE_CODE: 'enableCodeExecution',
};

// The free, one-key OpenCode Zen (Big Pickle) option is the default so the app
// is usable out of the box, like the Home Assistant "opencode" add-on.
const DEFAULT_PROVIDER = 'zen';

module.exports = class FlowMindApp extends Homey.App {
  async onInit() {
    this.log('FlowMind is starting…');
    this.homeyContext = new HomeyContext(this.homey);
    try {
      await this.homeyContext.init();
      this.log('Connected to the Homey Web API.');
    } catch (err) {
      // Don't crash the app: surface the problem when the user chats instead.
      this.error('Could not initialise the Homey Web API yet:', err.message);
    }
  }

  _keyFor(provider) {
    if (provider === 'zen') return this.homey.settings.get(SETTINGS.ZEN_KEY);
    if (provider === 'anthropic') return this.homey.settings.get(SETTINGS.ANTHROPIC_KEY);
    if (provider === 'openai') return this.homey.settings.get(SETTINGS.OPENAI_KEY);
    if (provider === 'gemini') return this.homey.settings.get(SETTINGS.GEMINI_KEY);
    if (provider === 'compatible') return this.homey.settings.get(SETTINGS.COMPATIBLE_KEY);
    return null;
  }

  /**
   * Return non-secret configuration for the settings page. API keys are never
   * sent back to the client — only whether each one is present.
   */
  async getConfig() {
    const provider = this.homey.settings.get(SETTINGS.PROVIDER) || DEFAULT_PROVIDER;
    const model = this.homey.settings.get(SETTINGS.MODEL) || '';
    return {
      provider,
      model,
      providers: listProviders(),
      compatibleBaseUrl: this.homey.settings.get(SETTINGS.COMPATIBLE_BASE_URL) || '',
      enableCodeExecution: Boolean(this.homey.settings.get(SETTINGS.ENABLE_CODE)),
      keysSet: {
        zen: Boolean(this.homey.settings.get(SETTINGS.ZEN_KEY)),
        anthropic: Boolean(this.homey.settings.get(SETTINGS.ANTHROPIC_KEY)),
        openai: Boolean(this.homey.settings.get(SETTINGS.OPENAI_KEY)),
        gemini: Boolean(this.homey.settings.get(SETTINGS.GEMINI_KEY)),
        compatible: Boolean(this.homey.settings.get(SETTINGS.COMPATIBLE_KEY)),
      },
    };
  }

  /**
   * Persist configuration. Empty/whitespace API-key values are ignored so the
   * user can update the model/provider without re-entering a key.
   */
  async saveConfig(body = {}) {
    if (typeof body.provider === 'string') {
      this.homey.settings.set(SETTINGS.PROVIDER, body.provider);
    }
    if (typeof body.model === 'string') {
      this.homey.settings.set(SETTINGS.MODEL, body.model);
    }
    if (typeof body.compatibleBaseUrl === 'string') {
      this.homey.settings.set(SETTINGS.COMPATIBLE_BASE_URL, body.compatibleBaseUrl.trim());
    }
    if (typeof body.enableCodeExecution === 'boolean') {
      this.homey.settings.set(SETTINGS.ENABLE_CODE, body.enableCodeExecution);
    }
    const keyFields = {
      zenApiKey: SETTINGS.ZEN_KEY,
      anthropicApiKey: SETTINGS.ANTHROPIC_KEY,
      openaiApiKey: SETTINGS.OPENAI_KEY,
      geminiApiKey: SETTINGS.GEMINI_KEY,
      compatibleApiKey: SETTINGS.COMPATIBLE_KEY,
    };
    for (const [field, key] of Object.entries(keyFields)) {
      if (typeof body[field] === 'string' && body[field].trim()) {
        this.homey.settings.set(key, body[field].trim());
      }
    }
    return this.getConfig();
  }

  /**
   * Run one assistant turn.
   * @param {object} body
   * @param {Array<{role,content}>} body.messages full chat history
   */
  async chat(body = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw new Error('No messages provided.');

    const provider = body.provider || this.homey.settings.get(SETTINGS.PROVIDER) || DEFAULT_PROVIDER;
    const model = body.model || this.homey.settings.get(SETTINGS.MODEL) || '';
    const apiKey = this._keyFor(provider);
    const baseUrl =
      provider === 'compatible' ? this.homey.settings.get(SETTINGS.COMPATIBLE_BASE_URL) || '' : undefined;

    if (provider === 'compatible' && !baseUrl) {
      throw new Error('Set a base URL for the OpenAI-compatible provider in the settings first.');
    }
    if (provider !== 'compatible' && !apiKey) {
      throw new Error(
        `No API key set for ${provider}. Open the settings and add your ${provider} API key first.`,
      );
    }

    // Make sure the Web API client is ready (retry init if the first attempt failed).
    await this.homeyContext.init();

    const result = await runAssistant({
      provider,
      apiKey,
      model,
      baseUrl,
      messages: messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content == null ? '' : m.content),
      })),
      homeyContext: this.homeyContext,
      log: (msg) => this.log(msg),
    });

    return result;
  }
};
