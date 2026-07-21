'use strict';

const Homey = require('homey');
const HomeyContext = require('./lib/HomeyContext');
const { runAssistant, listProviders, PROVIDERS } = require('./lib/llm');

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
  HOMEY_KEY: 'homeyApiKey',
};

// The free, one-key OpenCode Zen (Big Pickle) option is the default so the app
// is usable out of the box, like the Home Assistant "opencode" add-on.
const DEFAULT_PROVIDER = 'zen';

// Chat jobs. A settings page cannot wait for an assistant turn: Homey cancels
// its app API requests after ~10s, while a turn with tool calls easily takes
// 15-60s. So /chat only starts the work and the page polls /chat/:jobId for
// the result. Kept in memory only, and bounded like all storage on a Homey Pro.
const CHAT_JOB_MAX = 20;
const CHAT_JOB_TTL_MS = 10 * 60 * 1000;

module.exports = class FlowMindApp extends Homey.App {
  async onInit() {
    this.log('FlowMind is starting…');
    this._chatJobs = new Map();
    this.homeyContext = new HomeyContext(this.homey);
    try {
      await this.homeyContext.init();
      this.log('Connected to the Homey Web API.');
    } catch (err) {
      // Don't crash the app: surface the problem when the user chats instead.
      this.error('Could not initialise the Homey Web API yet:', err.message);
    }
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // "Have FlowMind do…" — fire-and-check action, no return value needed.
    this.homey.flow.getActionCard('ai_do').registerRunListener(async (args) => {
      await this._runFromFlow(args.instruction);
      return true;
    });
    // "Ask FlowMind…" — returns the answer as a token (Advanced Flow).
    this.homey.flow.getActionCard('ai_ask').registerRunListener(async (args) => {
      const reply = await this._runFromFlow(args.question);
      return { response: reply };
    });
  }

  /**
   * Run one assistant turn triggered from a Flow card. Flow run-listeners have
   * a tight time budget, so use fewer tool steps than the chat does, and mark
   * the message so the system prompt applies its no-confirmation flow rules.
   */
  async _runFromFlow(text) {
    const instruction = String(text == null ? '' : text).trim();
    if (!instruction) throw new Error('No instruction provided.');
    const result = await this.chat({
      messages: [{ role: 'user', content: `[flow] ${instruction}` }],
      maxSteps: 6,
    });
    return (result && result.reply) || 'Done.';
  }

  async getMemories() {
    return this.homeyContext.listMemories();
  }

  async deleteMemory({ id } = {}) {
    const result = await this.homeyContext.deleteMemory({ id });
    if (result && result.error) throw new Error(result.error);
    return result;
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
      // Local Homey API key status: flows can only be created in 'local' mode.
      homeyApi: this.homeyContext.getApiStatus(),
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

    // The Homey API key unlocks flow creation (the app token lacks that
    // scope). Reconnect right away so the save response reports whether the
    // key actually works.
    const homeyKeyChanged =
      (typeof body.homeyApiKey === 'string' && body.homeyApiKey.trim()) ||
      body.clearHomeyApiKey === true;
    if (body.clearHomeyApiKey === true) {
      this.homey.settings.unset(SETTINGS.HOMEY_KEY);
    } else if (typeof body.homeyApiKey === 'string' && body.homeyApiKey.trim()) {
      this.homey.settings.set(SETTINGS.HOMEY_KEY, body.homeyApiKey.trim());
    }
    if (homeyKeyChanged) {
      try {
        await this.homeyContext.reset();
      } catch (err) {
        this.error('Reconnecting the Homey API after a key change failed:', err.message);
      }
    }

    return this.getConfig();
  }

  /** Drop expired jobs, then make room so the map never grows past the cap. */
  _pruneChatJobs() {
    const now = Date.now();
    for (const [id, job] of this._chatJobs) {
      if (now - job.createdAt > CHAT_JOB_TTL_MS) this._chatJobs.delete(id);
    }
    // Map iterates in insertion order, so this drops the oldest jobs first.
    while (this._chatJobs.size >= CHAT_JOB_MAX) {
      this._chatJobs.delete(this._chatJobs.keys().next().value);
    }
  }

  /**
   * Start an assistant turn in the background and return its job id at once.
   * Used by the settings page, which cannot hold a request open long enough.
   */
  async startChat(body = {}) {
    this._pruneChatJobs();

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const job = { id: jobId, status: 'pending', createdAt: Date.now(), result: null, error: null };
    this._chatJobs.set(jobId, job);

    this.chat(body)
      .then((result) => {
        job.status = 'done';
        job.result = result;
      })
      .catch((err) => {
        job.status = 'error';
        job.error = err && err.message ? err.message : String(err);
      })
      .then(() => {
        // Nudge an open settings page so it fetches the result immediately
        // instead of waiting for its next poll. Polling is the fallback for
        // when the page was closed, so a failure here is harmless.
        try {
          this.homey.api.realtime('chat', { jobId, status: job.status });
        } catch (err) {
          this.log(`[chat] could not emit realtime event: ${err.message}`);
        }
      });

    return { jobId };
  }

  /**
   * Poll a chat job. Finished jobs stay until pruned, so a page that missed
   * the realtime event (closed, asleep, reloaded) can still collect its answer.
   */
  async getChatJob({ jobId } = {}) {
    const job = this._chatJobs.get(String(jobId == null ? '' : jobId));
    if (!job) return { status: 'unknown' };
    if (job.status === 'error') return { status: 'error', error: job.error };
    if (job.status === 'done') return { status: 'done', result: job.result };
    return { status: 'pending' };
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
    const providerCfg = PROVIDERS[provider];
    if (!apiKey && providerCfg && !providerCfg.needsBaseUrl && !providerCfg.keyOptional) {
      throw new Error(
        `No API key set for ${provider}. Open the settings and add your ${provider} API key first.`,
      );
    }

    // Make sure the Web API client is ready (retry init if the first attempt failed).
    await this.homeyContext.init();

    const startedAt = Date.now();
    this.log(`[chat] start provider=${provider} model=${model || '(default)'} messages=${messages.length}`);

    const result = await runAssistant({
      provider,
      apiKey,
      model,
      baseUrl,
      maxSteps: Number.isInteger(body.maxSteps) && body.maxSteps > 0 ? Math.min(body.maxSteps, 10) : 10,
      messages: messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content == null ? '' : m.content),
      })),
      homeyContext: this.homeyContext,
      log: (msg) => this.log(`${msg} (+${Date.now() - startedAt}ms)`),
    }).catch((err) => {
      this.error(`[chat] failed after ${Date.now() - startedAt}ms:`, err.message);
      throw err;
    });

    this.log(
      `[chat] done in ${Date.now() - startedAt}ms — ${result.steps ? result.steps.length : 0} steps, reply ${
        result.reply ? result.reply.length : 0
      } chars`,
    );

    return result;
  }
};
