'use strict';

const { HomeyAPI } = require('homey-api');
const { normalizeAdvancedFlowCards } = require('./flowNormalize');

/** Best-effort JSON-safe copy; falls back to a string for circular/complex values. */
function safeSerialize(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return String(value);
  }
}

// Bounds for data stored in app settings. The Homey Pro has limited storage
// and CPU, and every memory is injected into every system prompt, so both the
// counts and the serialized sizes stay small.
const MEMORY_MAX_COUNT = 50;
const MEMORY_MAX_TEXT = 500;
const MEMORY_PROMPT_BUDGET = 4000; // max characters injected into the prompt
const BACKUP_MAX_COUNT = 15;
const BACKUP_MAX_JSON = 300000; // ~300 KB for all flow backups together

function stringifyArg(x) {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch (err) {
    return String(x);
  }
}

/**
 * Coerce a capability value to the type Homey expects.
 *
 * The tool schema cannot pin `value` to one type — onoff wants a boolean, dim
 * a number, a thermostat mode a string — so models regularly send "false" or
 * "21" as text, and Homey rejects that outright ("Expected: boolean. Got:
 * string"). Coercing here fixes it for every provider at once.
 *
 * @param {*} value
 * @param {string} type  capability type: boolean | number | string | enum
 */
function coerceCapabilityValue(value, type) {
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'on', 'yes', 'aan'].includes(text)) return true;
    if (['false', '0', 'off', 'no', 'uit'].includes(text)) return false;
    throw new Error(`Cannot use "${value}" as a boolean value.`);
  }
  if (type === 'number') {
    if (typeof value === 'number') return value;
    // Accept a decimal comma: models echo back localised numbers ("21,5").
    const num = Number(String(value).trim().replace(',', '.'));
    if (!Number.isFinite(num)) throw new Error(`Cannot use "${value}" as a number.`);
    return num;
  }
  if (type === 'string' || type === 'enum') return String(value);
  return value;
}

/**
 * HomeyContext wraps the Homey Web API (via the in-app HomeyAPI client) and
 * exposes every capability the AI assistant needs:
 *   - reading the whole system (devices, zones, flows, moods)
 *   - controlling device capabilities
 *   - activating moods and starting flows
 *   - creating standard and advanced flows
 *
 * The public `executeTool(name, input)` method is the single entry point used
 * by the LLM tool loop. It always resolves to a JSON-serialisable value and
 * never throws (errors are returned as `{ error }`) so the model can recover.
 *
 * API shapes were verified against the Homey Apps SDK v3 / node-homey-api:
 *   HomeyAPI.createAppAPI({ homey })            -> requires "homey:manager:api"
 *   api.devices.getDevices()                    -> { [id]: Device }
 *   device.setCapabilityValue({ capabilityId, value })
 *   api.zones.getZones()                        -> { [id]: Zone }
 *   api.flow.getFlows() / getAdvancedFlows()    -> { [id]: (Advanced)Flow }
 *   api.flow.createFlow({ flow })               -> POST /manager/flow/flow
 *   api.flow.createAdvancedFlow({ advancedflow })-> POST /manager/flow/advancedflow
 *   api.flow.getFlowCardTriggers/Conditions/Actions() -> { [cardId]: Card }
 *   api.moods.getMoods()                        -> { [id]: Mood }
 */
class HomeyContext {
  constructor(homey) {
    this.homey = homey;
    this.api = null;
    // 'local' when connected with the user's Homey API key, 'app' otherwise.
    // The app token cannot create flows (Athom grants apps only
    // homey.flow.readonly + homey.flow.start), so flow-writing tools only work
    // in 'local' mode. See CLAUDE.md "Missing Scopes".
    this.apiMode = null;
    this.localApiError = null;
  }

  _getLocalApiKey() {
    try {
      const key = this.homey.settings.get('homeyApiKey');
      return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch (err) {
      return null;
    }
  }

  async init() {
    if (this.api) return this.api;
    const localKey = this._getLocalApiKey();
    this.localApiError = null;
    if (localKey) {
      try {
        // The app runs on the Homey itself; ManagerCloud knows the LAN address
        // (e.g. "192.168.1.100:80"), so the user only has to paste the key.
        const address = await this.homey.cloud.getLocalAddress();
        this.api = await HomeyAPI.createLocalAPI({
          address: `http://${String(address).replace(/^https?:\/\//, '')}`,
          token: localKey,
        });
        this.apiMode = 'local';
        return this.api;
      } catch (err) {
        // Fall back to the app token so chat and device control keep working;
        // flow-writing tools will explain the problem via executeTool.
        this.localApiError = err && err.message ? err.message : String(err);
        try {
          this.homey.app.error(`Local API connection failed: ${this.localApiError}`);
        } catch (logErr) {
          /* logging must never break init */
        }
      }
    }
    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    this.apiMode = 'app';
    return this.api;
  }

  /** Drop the current client and reconnect (used after the API key changes). */
  async reset() {
    const old = this.api;
    this.api = null;
    this.apiMode = null;
    if (old && typeof old.destroy === 'function') {
      try {
        old.destroy();
      } catch (err) {
        /* a stale client that fails to close is harmless */
      }
    }
    return this.init();
  }

  /** Connection status for the settings page. */
  getApiStatus() {
    return {
      keySet: Boolean(this._getLocalApiKey()),
      mode: this.apiMode,
      error: this.localApiError,
    };
  }

  async _ensure() {
    if (!this.api) await this.init();
    return this.api;
  }

  // ---------------------------------------------------------------------------
  // Reading the system
  // ---------------------------------------------------------------------------

  async _getZoneMap() {
    const api = await this._ensure();
    return api.zones.getZones();
  }

  _summariseDevice(device, zoneMap) {
    const capabilities = {};
    const capsObj = device.capabilitiesObj || {};
    for (const capId of device.capabilities || []) {
      const cap = capsObj[capId];
      capabilities[capId] = cap
        ? { value: cap.value, ...(cap.units ? { units: cap.units } : {}) }
        : { value: null };
    }
    return {
      id: device.id,
      name: device.name,
      zoneId: device.zone || null,
      zoneName: (zoneMap && device.zone && zoneMap[device.zone] && zoneMap[device.zone].name) || null,
      class: device.virtualClass || device.class || null,
      available: device.available !== false,
      capabilities,
    };
  }

  async listDevices({ zoneId, class: deviceClass, search } = {}) {
    const api = await this._ensure();
    const [devices, zoneMap] = await Promise.all([api.devices.getDevices(), this._getZoneMap()]);
    let list = Object.values(devices).map((d) => this._summariseDevice(d, zoneMap));
    if (zoneId) list = list.filter((d) => d.zoneId === zoneId);
    if (deviceClass) list = list.filter((d) => d.class === deviceClass);
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((d) => (d.name || '').toLowerCase().includes(q));
    }
    return { count: list.length, devices: list };
  }

  async listZones() {
    const zoneMap = await this._getZoneMap();
    const zones = Object.values(zoneMap).map((z) => ({
      id: z.id,
      name: z.name,
      parentId: z.parent || null,
    }));
    return { count: zones.length, zones };
  }

  async listMoods() {
    const api = await this._ensure();
    const moodMap = await api.moods.getMoods();
    const moods = Object.values(moodMap).map((m) => ({
      id: m.id,
      name: m.name,
      zoneId: m.zone || null,
    }));
    return { count: moods.length, moods };
  }

  async listFlows({ type = 'all', search } = {}) {
    const api = await this._ensure();
    const out = [];
    if (type === 'all' || type === 'standard') {
      const flows = await api.flow.getFlows();
      for (const f of Object.values(flows)) {
        out.push({ id: f.id, name: f.name, type: 'standard', enabled: f.enabled !== false });
      }
    }
    if (type === 'all' || type === 'advanced') {
      const advanced = await api.flow.getAdvancedFlows();
      for (const f of Object.values(advanced)) {
        out.push({ id: f.id, name: f.name, type: 'advanced', enabled: f.enabled !== false });
      }
    }
    let list = out;
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((f) => (f.name || '').toLowerCase().includes(q));
    }
    return { count: list.length, flows: list };
  }

  async getFlow({ flowId, type } = {}) {
    const api = await this._ensure();
    // Auto-detect if the caller did not tell us the type.
    if (type === 'advanced') {
      return { type: 'advanced', flow: await api.flow.getAdvancedFlow({ id: flowId }) };
    }
    if (type === 'standard') {
      return { type: 'standard', flow: await api.flow.getFlow({ id: flowId }) };
    }
    try {
      const flow = await api.flow.getFlow({ id: flowId });
      return { type: 'standard', flow };
    } catch (err) {
      const flow = await api.flow.getAdvancedFlow({ id: flowId });
      return { type: 'advanced', flow };
    }
  }

  async getSystemOverview() {
    const api = await this._ensure();
    const [devices, zoneMap, flows, advanced, moods] = await Promise.all([
      api.devices.getDevices(),
      api.zones.getZones(),
      api.flow.getFlows(),
      api.flow.getAdvancedFlows(),
      api.moods.getMoods().catch(() => ({})),
    ]);

    const deviceList = Object.values(devices);
    const classCounts = {};
    for (const d of deviceList) {
      const c = d.virtualClass || d.class || 'unknown';
      classCounts[c] = (classCounts[c] || 0) + 1;
    }

    const zones = Object.values(zoneMap).map((z) => ({
      id: z.id,
      name: z.name,
      parentId: z.parent || null,
    }));

    return {
      counts: {
        devices: deviceList.length,
        zones: zones.length,
        standardFlows: Object.keys(flows).length,
        advancedFlows: Object.keys(advanced).length,
        moods: Object.keys(moods).length,
      },
      deviceClasses: classCounts,
      zones,
    };
  }

  async listFlowCards({ kind, search } = {}) {
    const api = await this._ensure();
    let cardMap;
    if (kind === 'trigger') cardMap = await api.flow.getFlowCardTriggers();
    else if (kind === 'condition') cardMap = await api.flow.getFlowCardConditions();
    else if (kind === 'action') cardMap = await api.flow.getFlowCardActions();
    else throw new Error(`Unknown card kind: ${kind}`);

    let cards = Object.values(cardMap).map((c) => ({
      id: c.id,
      uri: c.uri || c.uriObj?.id || null,
      title: c.titleFormatted || c.title || null,
      hint: c.hint || null,
      args: Array.isArray(c.args)
        ? c.args.map((a) => ({ name: a.name, type: a.type, title: a.title }))
        : undefined,
    }));

    if (search) {
      const q = String(search).toLowerCase();
      cards = cards.filter(
        (c) =>
          (c.id || '').toLowerCase().includes(q) ||
          (c.title || '').toLowerCase().includes(q),
      );
    }
    // Cap the payload — full card lists can be very large.
    const capped = cards.slice(0, 60);
    return { kind, count: cards.length, returned: capped.length, cards: capped };
  }

  // ---------------------------------------------------------------------------
  // Controlling the system
  // ---------------------------------------------------------------------------

  async controlDevice({ deviceId, capabilityId, value } = {}) {
    const api = await this._ensure();
    const device = await api.devices.getDevice({ id: deviceId });

    // Use the device's own capability definition to convert the value, so a
    // model sending "false" instead of false still switches the device.
    const capability = device.capabilitiesObj && device.capabilitiesObj[capabilityId];
    if (!capability) {
      const available = device.capabilities ? device.capabilities.join(', ') : 'unknown';
      return { error: `Device "${device.name}" has no capability "${capabilityId}". Available: ${available}` };
    }
    const coerced = coerceCapabilityValue(value, capability.type);

    await device.setCapabilityValue({ capabilityId, value: coerced });
    return { ok: true, deviceId, device: device.name, capabilityId, value: coerced };
  }

  async activateMood({ moodId } = {}) {
    const api = await this._ensure();
    await api.moods.setMood({ id: moodId });
    return { ok: true, moodId };
  }

  async startFlow({ flowId, type } = {}) {
    const api = await this._ensure();
    if (type === 'advanced') {
      await api.flow.triggerAdvancedFlow({ id: flowId });
    } else {
      await api.flow.triggerFlow({ id: flowId });
    }
    return { ok: true, flowId };
  }

  // ---------------------------------------------------------------------------
  // Creating flows
  // ---------------------------------------------------------------------------

  async createStandardFlow(flow) {
    const api = await this._ensure();
    const created = await api.flow.createFlow({ flow });
    return { ok: true, id: created.id, name: created.name, type: 'standard' };
  }

  async createAdvancedFlow(advancedflow) {
    const api = await this._ensure();
    const normalized = {
      ...advancedflow,
      cards: normalizeAdvancedFlowCards(advancedflow.cards),
    };
    const created = await api.flow.createAdvancedFlow({ advancedflow: normalized });
    return { ok: true, id: created.id, name: created.name, type: 'advanced' };
  }

  // ---------------------------------------------------------------------------
  // Editing / deleting flows (with automatic backup)
  // ---------------------------------------------------------------------------

  _getBackups() {
    try {
      return this.homey.settings.get('flowBackups') || [];
    } catch (err) {
      return [];
    }
  }

  _saveBackups(list) {
    // Keep a bounded ring buffer so settings storage never grows unbounded.
    // Advanced-flow JSON can be big, so cap the total serialized size too —
    // app settings live on the Homey Pro's limited storage.
    const trimmed = list.slice(-BACKUP_MAX_COUNT);
    while (trimmed.length > 1 && JSON.stringify(trimmed).length > BACKUP_MAX_JSON) {
      trimmed.shift();
    }
    this.homey.settings.set('flowBackups', trimmed);
  }

  /** Snapshot a flow to settings before it is changed or deleted. */
  async _backupFlow(flowId, typeHint) {
    const { type, flow } = await this.getFlow({ flowId, type: typeHint });
    const backupId = `bk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const backups = this._getBackups();
    backups.push({
      backupId,
      flowId,
      type,
      name: flow && flow.name ? flow.name : '(unknown)',
      createdAt: new Date().toISOString(),
      flow,
    });
    this._saveBackups(backups);
    return { backupId, type, name: backups[backups.length - 1].name };
  }

  async updateStandardFlow({ flowId, ...fields } = {}) {
    const api = await this._ensure();
    const backup = await this._backupFlow(flowId, 'standard');
    const flow = {};
    for (const key of ['name', 'enabled', 'trigger', 'conditions', 'actions', 'folder']) {
      if (fields[key] !== undefined) flow[key] = fields[key];
    }
    const updated = await api.flow.updateFlow({ id: flowId, flow });
    return { ok: true, id: flowId, name: updated.name, type: 'standard', backupId: backup.backupId };
  }

  async updateAdvancedFlowById({ flowId, name, enabled, cards } = {}) {
    const api = await this._ensure();
    const backup = await this._backupFlow(flowId, 'advanced');
    const advancedflow = {};
    if (name !== undefined) advancedflow.name = name;
    if (enabled !== undefined) advancedflow.enabled = enabled;
    if (cards !== undefined) advancedflow.cards = normalizeAdvancedFlowCards(cards);
    const updated = await api.flow.updateAdvancedFlow({ id: flowId, advancedflow });
    return { ok: true, id: flowId, name: updated.name, type: 'advanced', backupId: backup.backupId };
  }

  async deleteFlowById({ flowId, type } = {}) {
    const api = await this._ensure();
    const backup = await this._backupFlow(flowId, type);
    if (backup.type === 'advanced') {
      await api.flow.deleteAdvancedFlow({ id: flowId });
    } else {
      await api.flow.deleteFlow({ id: flowId });
    }
    return { ok: true, deleted: flowId, type: backup.type, backupId: backup.backupId };
  }

  async listBackups() {
    const backups = this._getBackups().map((b) => ({
      backupId: b.backupId,
      name: b.name,
      type: b.type,
      flowId: b.flowId,
      createdAt: b.createdAt,
    }));
    return { count: backups.length, backups };
  }

  async restoreBackup({ backupId } = {}) {
    const backup = this._getBackups().find((b) => b.backupId === backupId);
    if (!backup) return { error: `No backup found with id ${backupId}` };
    const f = backup.flow || {};
    if (backup.type === 'advanced') {
      return this.createAdvancedFlow({
        name: f.name,
        enabled: f.enabled !== false,
        cards: f.cards || {},
      });
    }
    return this.createStandardFlow({
      name: f.name,
      enabled: f.enabled !== false,
      trigger: f.trigger,
      conditions: f.conditions || [],
      actions: f.actions || [],
    });
  }

  // ---------------------------------------------------------------------------
  // Running JavaScript on the Homey (HomeyScript-style), gated by a setting
  // ---------------------------------------------------------------------------

  async runScript({ code } = {}) {
    let enabled = false;
    try {
      enabled = Boolean(this.homey.settings.get('enableCodeExecution'));
    } catch (err) {
      enabled = false;
    }
    if (!enabled) {
      return {
        error:
          'Code execution is disabled. Enable the "Run scripts" toggle in the app settings first.',
      };
    }
    if (typeof code !== 'string' || !code.trim()) return { error: 'No code provided.' };

    const vm = require('vm');
    const api = await this._ensure();
    const logs = [];
    const sandboxConsole = {
      log: (...a) => logs.push(a.map((x) => stringifyArg(x)).join(' ')),
      error: (...a) => logs.push('ERROR: ' + a.map((x) => stringifyArg(x)).join(' ')),
    };
    const context = vm.createContext({
      homeyApi: api,
      console: sandboxConsole,
      setTimeout,
      clearTimeout,
    });
    const wrapped = `(async () => {\n${code}\n})()`;
    try {
      const script = new vm.Script(wrapped, { filename: 'flowmind-script.js' });
      const runPromise = script.runInContext(context);
      const result = await Promise.race([
        Promise.resolve(runPromise),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Script timed out after 10s')), 10000),
        ),
      ]);
      return { ok: true, result: safeSerialize(result), logs };
    } catch (err) {
      return { error: err && err.message ? err.message : String(err), logs };
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent memory (facts & preferences the AI keeps across conversations)
  // ---------------------------------------------------------------------------

  _getMemories() {
    try {
      return this.homey.settings.get('aiMemories') || [];
    } catch (err) {
      return [];
    }
  }

  _setMemories(list) {
    // Bounded so settings storage never grows unbounded.
    this.homey.settings.set('aiMemories', list.slice(-MEMORY_MAX_COUNT));
  }

  async saveMemory({ text } = {}) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return { error: 'No text provided.' };
    if (value.length > MEMORY_MAX_TEXT) {
      return { error: `Memory too long (max ${MEMORY_MAX_TEXT} characters). Summarise it.` };
    }
    const memories = this._getMemories();
    // Update instead of duplicate when the exact same fact is saved again.
    const existing = memories.find((m) => m.text === value);
    if (existing) {
      return { ok: true, id: existing.id, count: memories.length, limit: MEMORY_MAX_COUNT, note: 'Already saved.' };
    }
    if (memories.length >= MEMORY_MAX_COUNT) {
      return {
        error:
          `Memory is full (${MEMORY_MAX_COUNT} facts). Consolidate first: merge related memories ` +
          'into one with save_memory and remove outdated ones with delete_memory, then try again.',
      };
    }
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    memories.push({ id, text: value, createdAt: new Date().toISOString() });
    this._setMemories(memories);
    const result = { ok: true, id, count: memories.length, limit: MEMORY_MAX_COUNT };
    if (memories.length >= MEMORY_MAX_COUNT - 5) {
      result.warning =
        `Memory is almost full (${memories.length}/${MEMORY_MAX_COUNT}). ` +
        'Merge related memories and delete outdated ones.';
    }
    return result;
  }

  async deleteMemory({ id } = {}) {
    const memories = this._getMemories();
    const next = memories.filter((m) => m.id !== id);
    if (next.length === memories.length) return { error: `No memory found with id ${id}` };
    this._setMemories(next);
    return { ok: true, deleted: id };
  }

  async listMemories() {
    const memories = this._getMemories();
    return { count: memories.length, limit: MEMORY_MAX_COUNT, memories };
  }

  /**
   * Formatted block for injection into the system prompt ('' when empty).
   * Bounded by MEMORY_PROMPT_BUDGET: newest memories win, and the model is
   * told when older ones were omitted (it can still fetch them via
   * list_memories).
   */
  getMemoriesText() {
    const memories = this._getMemories();
    if (!memories.length) return '';
    const lines = [];
    let used = 0;
    let omitted = 0;
    for (let i = memories.length - 1; i >= 0; i -= 1) {
      const line = `- [${memories[i].id}] ${memories[i].text}`;
      if (used + line.length > MEMORY_PROMPT_BUDGET) {
        omitted = i + 1;
        break;
      }
      lines.unshift(line);
      used += line.length + 1;
    }
    if (omitted) {
      lines.unshift(`(${omitted} older memories omitted — use list_memories to see them all)`);
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Insights (historic sensor/energy data)
  // ---------------------------------------------------------------------------

  async listInsightsLogs({ search } = {}) {
    const api = await this._ensure();
    const logMap = await api.insights.getLogs();
    let logs = Object.values(logMap).map((l) => ({
      id: l.id,
      uri: l.uri || null,
      title: l.title || l.id,
      type: l.type || null,
      units: l.units || null,
      lastValue: l.lastValue !== undefined ? l.lastValue : null,
    }));
    if (search) {
      const q = String(search).toLowerCase();
      logs = logs.filter(
        (l) =>
          (l.id || '').toLowerCase().includes(q) ||
          (l.title || '').toLowerCase().includes(q) ||
          (l.uri || '').toLowerCase().includes(q),
      );
    }
    const capped = logs.slice(0, 80);
    return { count: logs.length, returned: capped.length, logs: capped };
  }

  async getInsightsEntries({ uri, id, resolution } = {}) {
    const api = await this._ensure();
    const result = await api.insights.getLogEntries({ uri, id, resolution });
    const data = safeSerialize(result) || {};
    // Entry sets can be huge; sample evenly so the payload stays LLM-sized.
    if (Array.isArray(data.values) && data.values.length > 200) {
      const step = Math.ceil(data.values.length / 200);
      data.sampled = { originalCount: data.values.length, step };
      data.values = data.values.filter((_, i) => i % step === 0);
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Tool dispatch
  // ---------------------------------------------------------------------------

  /**
   * Execute a single named tool. Never throws — failures come back as
   * { error: string } so the LLM can read and recover from them.
   * @param {string} name
   * @param {object} input
   * @returns {Promise<any>}
   */
  async executeTool(name, input = {}) {
    try {
      switch (name) {
        case 'get_system_overview':
          return await this.getSystemOverview();
        case 'list_devices':
          return await this.listDevices(input);
        case 'list_zones':
          return await this.listZones();
        case 'list_flows':
          return await this.listFlows(input);
        case 'get_flow':
          return await this.getFlow(input);
        case 'list_moods':
          return await this.listMoods();
        case 'control_device':
          return await this.controlDevice(input);
        case 'activate_mood':
          return await this.activateMood(input);
        case 'start_flow':
          return await this.startFlow(input);
        case 'list_flow_cards':
          return await this.listFlowCards(input);
        case 'create_standard_flow':
          return await this.createStandardFlow(input);
        case 'create_advanced_flow':
          return await this.createAdvancedFlow(input);
        case 'update_standard_flow':
          return await this.updateStandardFlow(input);
        case 'update_advanced_flow':
          return await this.updateAdvancedFlowById(input);
        case 'delete_flow':
          return await this.deleteFlowById(input);
        case 'list_backups':
          return await this.listBackups();
        case 'restore_backup':
          return await this.restoreBackup(input);
        case 'run_script':
          return await this.runScript(input);
        case 'save_memory':
          return await this.saveMemory(input);
        case 'delete_memory':
          return await this.deleteMemory(input);
        case 'list_memories':
          return await this.listMemories();
        case 'list_insights_logs':
          return await this.listInsightsLogs(input);
        case 'get_insights_entries':
          return await this.getInsightsEntries(input);
        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      let message = err && err.message ? err.message : String(err);
      // The app token cannot write flows. Tell the model the real fix so it
      // never sends the user down a dead end (like enabling "Run scripts",
      // which uses the same token and would fail identically).
      if (/missing scopes/i.test(message) && this.apiMode !== 'local') {
        message +=
          '. Creating or changing flows needs a Homey API key: ask the user to create one' +
          ' at my.homey.app → Settings → System → API keys and paste it into the FlowMind' +
          ' settings under "Homey API key". Do NOT suggest the "Run scripts" toggle — it uses' +
          ' the same restricted token and cannot help.';
      }
      return { error: message };
    }
  }
}

module.exports = HomeyContext;
