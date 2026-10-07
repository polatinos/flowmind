'use strict';

const Homey = require('homey');
const HomeyContext = require('./lib/HomeyContext');
const { runAssistant, listProviders, PROVIDERS } = require('./lib/llm');
const { WebTerminal, PORT: WEB_TERMINAL_PORT } = require('./lib/webTerminal');

const SETTINGS = {
  PROVIDER: 'provider',
  MODEL: 'model',
  ZEN_KEY: 'zenApiKey',
  ANTHROPIC_KEY: 'anthropicApiKey',
  OPENAI_KEY: 'openaiApiKey',
  GEMINI_KEY: 'geminiApiKey',
  COMPATIBLE_KEY: 'compatibleApiKey',
  COMPATIBLE_BASE_URL: 'compatibleBaseUrl',
  HOMEY_KEY: 'homeyApiKey',
  WEB_TERMINAL: 'webTerminalEnabled',
};

// Provider id -> settings key, for clearing a key from the settings page.
const PROVIDER_KEY_SETTINGS = {
  zen: SETTINGS.ZEN_KEY,
  anthropic: SETTINGS.ANTHROPIC_KEY,
  openai: SETTINGS.OPENAI_KEY,
  gemini: SETTINGS.GEMINI_KEY,
  compatible: SETTINGS.COMPATIBLE_KEY,
};

// Shape of a Homey API key ("<uuid>:<uuid>:<hex>"). Such a key must never be
// stored as an AI-provider key: it would be sent to that provider on every chat.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HOMEY_API_KEY_RE = new RegExp(`^${UUID}:${UUID}:[0-9a-f]+$`, 'i');
const looksLikeHomeyApiKey = (value) => HOMEY_API_KEY_RE.test(String(value || '').trim());

// Every provider needs a key since OpenCode Zen closed its free tier to other
// clients (2026-10), so the default is simply the provider FlowMind is tested
// against.
const DEFAULT_PROVIDER = 'anthropic';

// Chat jobs. A settings page cannot wait for an assistant turn: Homey cancels
// its app API requests after ~10s, while a turn with tool calls easily takes
// 15-60s. So /chat only starts the work and the page polls /chat/:jobId for
// the result. Kept in memory only, and bounded like all storage on a Homey Pro.
const CHAT_JOB_MAX = 20;
const CHAT_JOB_TTL_MS = 10 * 60 * 1000;

// Every chat turn costs the user API credits and loads the Homey, and the web
// terminal hands this endpoint to anyone holding its link. Cap both the turns
// running at once and the turns per window, so a script looping on the
// endpoint cannot run up a bill.
const CHAT_MAX_PENDING = 3;
const CHAT_RATE_MAX = 30;
const CHAT_RATE_WINDOW_MS = 10 * 60 * 1000;

function rateLimitError(message) {
  const err = new Error(message);
  err.statusCode = 429;
  return err;
}

module.exports = class FlowMindApp extends Homey.App {
  async onInit() {
    this.log('FlowMind is starting…');
    // v0.5.5 removed the script-execution tool; drop the old opt-in setting so
    // no install keeps a stale "enabled" flag around.
    try {
      this.homey.settings.unset('enableCodeExecution');
    } catch (err) { /* never set on this install */ }
    this._chatJobs = new Map();
    this._chatStarts = [];
    this.homeyContext = new HomeyContext(this.homey);
    try {
      await this.homeyContext.init();
      this.log('Connected to the Homey Web API.');
    } catch (err) {
      // Don't crash the app: surface the problem when the user chats instead.
      this.error('Could not initialise the Homey Web API yet:', err.message);
    }
    this._registerFlowCards();

    // Desktop web terminal on the LAN (Homey's settings modal is ~330px wide
    // on desktop, which is unusable for a chat terminal).
    this._webTerminal = new WebTerminal(this);
    if (this.homey.settings.get(SETTINGS.WEB_TERMINAL)) {
      this._webTerminal.start();
    }
  }

  async onUninit() {
    if (this._webTerminal) this._webTerminal.stop();
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
      keysSet: {
        zen: Boolean(this.homey.settings.get(SETTINGS.ZEN_KEY)),
        anthropic: Boolean(this.homey.settings.get(SETTINGS.ANTHROPIC_KEY)),
        openai: Boolean(this.homey.settings.get(SETTINGS.OPENAI_KEY)),
        gemini: Boolean(this.homey.settings.get(SETTINGS.GEMINI_KEY)),
        compatible: Boolean(this.homey.settings.get(SETTINGS.COMPATIBLE_KEY)),
      },
      // Local Homey API key status: flows can only be created in 'local' mode.
      homeyApi: this.homeyContext.getApiStatus(),
      webTerminal: await this._webTerminalStatus(),
    };
  }

  /** Status + ready-to-open URL for the desktop web terminal. */
  async _webTerminalStatus() {
    const enabled = Boolean(this.homey.settings.get(SETTINGS.WEB_TERMINAL));
    let url = null;
    if (enabled && this._webTerminal) {
      try {
        const address = await this.homey.cloud.getLocalAddress();
        const host = String(address).replace(/^https?:\/\//, '').replace(/:\d+$/, '');
        // The token rides in the fragment, which the browser never sends to
        // the server, so it stays out of request lines and logs.
        url = `http://${host}:${WEB_TERMINAL_PORT}/#token=${this._webTerminal.ensureToken()}`;
      } catch (err) {
        this.error('Could not determine the local address for the web terminal:', err.message);
      }
    }
    return {
      enabled,
      url,
      error: this._webTerminal ? this._webTerminal.lastError : null,
    };
  }

  /**
   * Persist configuration. Empty/whitespace API-key values are ignored so the
   * user can update the model/provider without re-entering a key.
   */
  async saveConfig(body = {}) {
    const keyFields = {
      zenApiKey: SETTINGS.ZEN_KEY,
      anthropicApiKey: SETTINGS.ANTHROPIC_KEY,
      openaiApiKey: SETTINGS.OPENAI_KEY,
      geminiApiKey: SETTINGS.GEMINI_KEY,
      compatibleApiKey: SETTINGS.COMPATIBLE_KEY,
    };
    // Check before writing anything, so a rejected save leaves no half state.
    for (const field of Object.keys(keyFields)) {
      if (typeof body[field] === 'string' && looksLikeHomeyApiKey(body[field])) {
        throw new Error(this.homey.__('settings.keyIsHomeyKey'));
      }
    }

    if (typeof body.provider === 'string' && PROVIDERS[body.provider]) {
      this.homey.settings.set(SETTINGS.PROVIDER, body.provider);
    }
    if (typeof body.model === 'string') {
      this.homey.settings.set(SETTINGS.MODEL, body.model);
    }
    if (typeof body.compatibleBaseUrl === 'string') {
      this.homey.settings.set(SETTINGS.COMPATIBLE_BASE_URL, body.compatibleBaseUrl.trim());
    }
    if (typeof body.webTerminalEnabled === 'boolean') {
      this.homey.settings.set(SETTINGS.WEB_TERMINAL, body.webTerminalEnabled);
      if (body.webTerminalEnabled) this._webTerminal.start();
      else this._webTerminal.stop();
    }
    // A leaked link is full control of the house, so it must be revocable.
    if (body.rotateWebTerminalToken === true) {
      this._webTerminal.rotateToken();
    }
    for (const [field, key] of Object.entries(keyFields)) {
      if (typeof body[field] === 'string' && body[field].trim()) {
        this.homey.settings.set(key, body[field].trim());
      }
    }
    // An empty field means "keep the key", so clearing needs its own request.
    if (Object.prototype.hasOwnProperty.call(PROVIDER_KEY_SETTINGS, body.clearProviderKey)) {
      this.homey.settings.unset(PROVIDER_KEY_SETTINGS[body.clearProviderKey]);
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

  /** Throw a 429-style error when too many turns are running or were started. */
  _assertChatAllowed() {
    const now = Date.now();
    this._chatStarts = this._chatStarts.filter((t) => now - t < CHAT_RATE_WINDOW_MS);
    const pending = [...this._chatJobs.values()].filter((j) => j.status === 'pending').length;
    if (pending >= CHAT_MAX_PENDING) {
      throw rateLimitError(this.homey.__('settings.chatBusy'));
    }
    if (this._chatStarts.length >= CHAT_RATE_MAX) {
      throw rateLimitError(this.homey.__('settings.chatRateLimited'));
    }
    this._chatStarts.push(now);
  }

  /**
   * Pick the provider and model for a turn. The chat pickers may choose a
   * provider, but the model must be the saved one (which belongs to the saved
   * provider only) or one from that provider's own list. Arbitrary strings
   * from a client are ignored, and a provider switch no longer drags along a
   * model of another provider (sending a Claude model id to Gemini).
   */
  _resolveProviderAndModel(body = {}) {
    const savedProvider = this.homey.settings.get(SETTINGS.PROVIDER);
    const saved = PROVIDERS[savedProvider] ? savedProvider : DEFAULT_PROVIDER;
    const provider = typeof body.provider === 'string' && PROVIDERS[body.provider] ? body.provider : saved;
    let model = provider === saved ? this.homey.settings.get(SETTINGS.MODEL) || '' : '';
    // The settings form can still save provider B with provider A's model id
    // (the field keeps its text when the dropdown changes). A model listed
    // under another provider is never right for this one.
    const ownedElsewhere = Object.entries(PROVIDERS).some(
      ([id, p]) => id !== provider && p.models.includes(model),
    );
    if (ownedElsewhere) model = '';
    if (typeof body.model === 'string' && PROVIDERS[provider].models.includes(body.model)) {
      model = body.model;
    }
    return { provider, model };
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
    this._assertChatAllowed();

    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      id: jobId, status: 'pending', createdAt: Date.now(), result: null, error: null, steps: [],
    };
    this._chatJobs.set(jobId, job);

    // Stream tool-step progress: realtime for the settings page, and buffered
    // on the job for the web terminal, which polls instead. Capped so a
    // runaway turn cannot grow the job unbounded.
    const onStep = (step) => {
      if (job.steps.length < 100) job.steps.push(step);
      try {
        this.homey.api.realtime('chatStep', { jobId, ...step });
      } catch (err) { /* page may be closed; harmless */ }
    };

    this.chat(body, onStep)
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
    return { status: 'pending', steps: job.steps || [] };
  }

  /**
   * Run one assistant turn.
   * @param {object} body
   * @param {Array<{role,content}>} body.messages full chat history
   */
  async chat(body = {}, onStep = null) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw new Error('No messages provided.');

    const { provider, model } = this._resolveProviderAndModel(body);
    const apiKey = this._keyFor(provider);
    const baseUrl =
      provider === 'compatible' ? this.homey.settings.get(SETTINGS.COMPATIBLE_BASE_URL) || '' : undefined;

    if (provider === 'compatible' && !baseUrl) {
      throw new Error('Set a base URL for the OpenAI-compatible provider in the settings first.');
    }
    if (!apiKey && !PROVIDERS[provider].needsBaseUrl) {
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
      onStep,
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
