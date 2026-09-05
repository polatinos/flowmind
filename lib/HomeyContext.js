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
// check_flows must stay small enough to survive a flow run (maxSteps 6, tight
// time budget), so the finding list is capped and the remainder is counted.
const DIAGNOSE_MAX_FINDINGS = 25;

// How long to wait before trying the user's API key again after the local
// connection failed. Long enough not to hammer a struggling Homey, short
// enough that a passing glitch does not outlive the user's patience.
const LOCAL_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

// Tools that write flows. Athom grants apps only homey.flow.readonly +
// homey.flow.start, so these need the user's own API key ('local' mode).
// They are refused up front rather than after a "Missing Scopes" round trip.
const FLOW_WRITING_TOOLS = new Set([
  'create_standard_flow',
  'create_advanced_flow',
  'update_standard_flow',
  'update_advanced_flow',
  'delete_flow',
  'restore_backup',
]);

/** The one instruction that actually unblocks flow writing, per failure case. */
function flowWriteBlockedMessage(status) {
  const howTo =
    'Ask the user to create a key at my.homey.app -> Settings -> System -> API keys' +
    ' and paste it into the FlowMind settings under "Homey API key". That key is the' +
    ' only route: the app\'s own token stays restricted whatever else is tried.';
  if (status.reason === 'key_failed') {
    // Same flattening as the system-prompt block: this text is read by the
    // model, so keep it to one tidy line.
    const why = String(status.error || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return (
      'The saved Homey API key is not working, so flows cannot be created, changed or deleted' +
      `${why ? ` (${why})` : ''}. Ask the user to check the key in the FlowMind` +
      ' settings, or to make a new one at my.homey.app -> Settings -> System -> API keys.'
    );
  }
  return `No Homey API key is set, so flows cannot be created, changed or deleted. ${howTo}`;
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
    // When the local connection last failed. A failure used to stick until the
    // app restarted, so one bad moment on a busy Homey meant hours of telling
    // the user their perfectly good key was broken.
    this.localFailedAt = 0;
  }

  _getLocalApiKey() {
    try {
      const key = this.homey.settings.get('homeyApiKey');
      return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch (err) {
      return null;
    }
  }

  /** Close a client we are done with; a failure to close is never fatal. */
  static _destroy(client) {
    if (client && typeof client.destroy === 'function') {
      try {
        client.destroy();
      } catch (err) {
        /* a stale client that fails to close is harmless */
      }
    }
  }

  /**
   * Build a local client for `key` and prove the key works, WITHOUT touching
   * `this.api`. Returns the client, or null after recording why it failed.
   *
   * Building separately is what lets the caller keep a working connection
   * until a replacement is ready — tearing the old one down first means a
   * failure here leaves the app with no client at all.
   */
  async _buildLocalApi(key) {
    let client = null;
    try {
      // The app runs on the Homey itself; ManagerCloud knows the LAN address
      // (e.g. "192.168.1.100:80"), so the user only has to paste the key.
      const address = await this.homey.cloud.getLocalAddress();
      client = await HomeyAPI.createLocalAPI({
        address: `http://${String(address).replace(/^https?:\/\//, '')}`,
        token: key,
      });
      // createLocalAPI only GETs the unauthenticated /ping and checks for an
      // X-Homey-ID header — it never tries the token. So a typo'd, expired or
      // revoked key still hands back a client, and every call afterwards fails
      // with "Invalid Token" while the settings page cheerfully reports the key
      // as working. /session/me needs no scopes (spec: `scopes: []`), so it
      // fails only when the token itself is refused.
      await client.sessions.getSessionMe();
      this.localApiError = null;
      this.localFailedAt = 0;
      return client;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      // Only an authentication failure proves the key is bad. If this endpoint
      // is missing or unroutable on some firmware, refusing the key would be
      // worse than the bug this check exists for: it would demote every user
      // with a perfectly good key. In that case trust the connection, which is
      // how it worked before the check existed.
      const status = err && err.statusCode;
      const refused = status === 401 || status === 403
        || /invalid token|unauthorized|forbidden|not authenticated/i.test(message);
      const reachedHomey = Boolean(client);
      if (reachedHomey && !refused) {
        try {
          this.homey.app.error(`Could not verify the API key (${message}); trusting it.`);
        } catch (logErr) {
          /* logging must never break init */
        }
        this.localApiError = null;
        this.localFailedAt = 0;
        return client;
      }
      HomeyContext._destroy(client);
      this.localApiError = message;
      this.localFailedAt = Date.now();
      try {
        this.homey.app.error(`Local API connection failed: ${message}`);
      } catch (logErr) {
        /* logging must never break init */
      }
      return null;
    }
  }

  async init() {
    if (this.api) return this.api;
    const localKey = this._getLocalApiKey();
    this.localApiError = null;
    if (localKey) {
      const local = await this._buildLocalApi(localKey);
      if (local) {
        this.api = local;
        this.apiMode = 'local';
        return this.api;
      }
      // Fall through to the app token so chat and device control keep working;
      // flow-writing tools explain the problem via executeTool.
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
    HomeyContext._destroy(old);
    return this.init();
  }

  /**
   * Try the user's key again after an earlier failure, keeping the current
   * client until the new one is proven.
   *
   * Deliberately not `reset()`: that nulls `this.api` first, so a Homey that
   * is briefly unable to hand out an app token would leave the app with no
   * client at all and every tool in that turn failing.
   */
  async _retryLocalApi() {
    const key = this._getLocalApiKey();
    if (!key) return false;
    const local = await this._buildLocalApi(key);
    if (!local) return false;
    const old = this.api;
    this.api = local;
    this.apiMode = 'local';
    if (old !== local) HomeyContext._destroy(old);
    return true;
  }

  /** Connection status for the settings page. */
  getApiStatus() {
    return {
      keySet: Boolean(this._getLocalApiKey()),
      mode: this.apiMode,
      error: this.localApiError,
    };
  }

  /**
   * Whether flow-writing tools can work right now, connecting first if needed.
   *
   * The assistant used to find this out only by calling a flow tool and
   * reading "Missing Scopes" off the failure — so it happily spent a whole
   * conversation designing a flow it could never save. The answer belongs in
   * the system prompt instead, before the model starts planning.
   */
  async getFlowWriteStatus() {
    const keySet = Boolean(this._getLocalApiKey());
    try {
      await this._ensure();
      // A failed local connection is remembered until reset() or a restart, so
      // one bad moment — and this Homey drops out under memory pressure —
      // would otherwise tell the user for hours that a valid key is broken.
      // Retry at most once per cooldown; the cost is a single ping.
      if (keySet && this.apiMode !== 'local'
          && Date.now() - this.localFailedAt >= LOCAL_RETRY_COOLDOWN_MS) {
        this.localFailedAt = Date.now();
        try {
          await this._retryLocalApi();
        } catch (retryErr) {
          /* still down: the status below reports it, chat keeps working */
        }
      }
    } catch (err) {
      return {
        canWrite: false,
        keySet,
        reason: keySet ? 'key_failed' : 'no_key',
        error: err && err.message ? err.message : String(err),
      };
    }
    if (this.apiMode === 'local') return { canWrite: true, keySet: true, reason: 'ok', error: null };
    return {
      canWrite: false,
      keySet,
      reason: keySet ? 'key_failed' : 'no_key',
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

  // ---------------------------------------------------------------------------
  // Diagnosing flows
  // ---------------------------------------------------------------------------

  /**
   * Describe why a single card is dead, or return null when it is fine.
   *
   * @param {object} card     a standard-flow card or an advanced-flow node
   * @param {object} devices  { [deviceId]: Device }
   * @param {object|null} apps  { [appId]: App }, or null when unavailable
   */
  _cardProblem(card, devices, apps) {
    if (!card || typeof card !== 'object') return null;
    const id = typeof card.id === 'string' ? card.id : '';
    const owner = typeof card.ownerUri === 'string' ? card.ownerUri : '';

    const device = id.match(/^homey:device:([0-9a-fA-F-]{36}):/);
    if (device && !devices[device[1]]) {
      return { problem: 'missing_device', detail: `points at device ${device[1]}, which no longer exists` };
    }

    // Without the app list we simply skip these checks; the caller reports that.
    if (apps) {
      // Advanced-flow nodes carry the app in ownerUri; standard-flow cards only
      // have it in their own id. Check both so neither shape slips through.
      const ownerApp = owner.match(/^homey:app:([^:]+)/) || id.match(/^homey:app:([^:]+):/);
      if (ownerApp) {
        const bad = this._appProblem(ownerApp[1], apps, 'belongs to');
        if (bad) return bad;
      }
      // restart_app hides the app id in its argument, so the card itself stays
      // valid and Homey keeps reporting the flow as healthy. This is the case
      // Flow Checker misses.
      if (id === 'homey:manager:apps:restart_app') {
        const target = card.args && card.args.app && card.args.app.id;
        if (target) {
          const bad = this._appProblem(target, apps, 'restarts');
          if (bad) return bad;
        }
      }
    }
    return null;
  }

  /**
   * Judge one app reference. An app that is merely disabled or crashed fails
   * its cards just as silently as one that was uninstalled, so all three count.
   */
  _appProblem(appId, apps, verb) {
    const app = apps[appId];
    if (!app) {
      return { problem: 'missing_app', detail: `${verb} app "${appId}", which is not installed` };
    }
    if (app.enabled === false) {
      return { problem: 'app_disabled', detail: `${verb} app "${appId}", which is installed but switched off` };
    }
    if (app.crashed === true) {
      return { problem: 'app_crashed', detail: `${verb} app "${appId}", which has crashed` };
    }
    return null;
  }

  /**
   * Count the cards that stop being reachable once `brokenKey` fails.
   *
   * Walking downstream naively over-reports: cards often have several incoming
   * edges, and one that a second trigger still reaches has not stalled. So walk
   * the graph twice — healthy, and with the broken card only following its
   * error branch — and take the difference.
   *
   * A filled outputError is a deliberate fallback by the user, so that branch
   * keeps running and must not be counted as lost.
   *
   * Known limit: an `all` join only fires once every input arrives, so it dies
   * as soon as one of them does. The diff below keeps it alive while any other
   * route survives, which under-reports that case. Never over-reports.
   */
  _unreachableAfter(cards, brokenKey) {
    const next = (card, degraded) => {
      if (degraded) return card.outputError || [];
      return [
        ...(card.outputSuccess || []),
        ...(card.outputTrue || []),
        ...(card.outputFalse || []),
        ...(card.outputError || []),
      ];
    };
    const walk = (failing) => {
      const seen = new Set();
      // Advanced flows may contain loops, so `seen` doubles as the cycle guard.
      // A manually startable advanced flow has a `start` card instead of a
      // trigger (see CLAUDE.md), and FlowMind's own helper flows use exactly
      // that. Miss it and such a flow has no roots at all, so nothing walks.
      const stack = Object.keys(cards).filter(
        (k) => cards[k] && (cards[k].type === 'trigger' || cards[k].type === 'start'),
      );
      while (stack.length) {
        const key = stack.pop();
        if (seen.has(key)) continue;
        seen.add(key);
        const card = cards[key];
        if (!card) continue;
        for (const edge of next(card, key === failing)) {
          if (!seen.has(edge)) stack.push(edge);
        }
      }
      return seen;
    };
    const healthy = walk(null);
    const degraded = walk(brokenKey);
    let lost = 0;
    for (const key of healthy) {
      if (key !== brokenKey && !degraded.has(key)) lost += 1;
    }
    return lost;
  }

  /**
   * Inspect every flow and report the ones that silently do nothing.
   *
   * Homey only sets `broken` when a card itself disappears, so a card whose
   * *argument* names a removed app reads as healthy while failing at runtime —
   * and in an advanced flow it takes every card behind it down with it.
   */
  async checkFlows({ flowId } = {}) {
    const api = await this._ensure();
    const [devices, standardFlows, advancedFlows] = await Promise.all([
      api.devices.getDevices(),
      api.flow.getFlows(),
      api.flow.getAdvancedFlows(),
    ]);

    // getApps needs the homey.app.readonly scope, which the app token may not
    // carry. Degrade loudly rather than quietly checking less than we claim.
    let apps = null;
    let appCheckSkipped = null;
    try {
      apps = await api.apps.getApps();
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      appCheckSkipped =
        `Could not read the installed apps (${reason}), so cards pointing at missing, disabled ` +
        'or crashed apps were NOT checked.' +
        // Only promise the API key when the failure is actually about scopes;
        // on a timeout that advice would just send the user down a dead end.
        (/missing scopes/i.test(reason)
          ? ' Setting a Homey API key in the FlowMind settings enables this check.'
          : '');
    }

    const findings = [];
    let omitted = 0;
    const add = (finding) => {
      if (findings.length < DIAGNOSE_MAX_FINDINGS) findings.push(finding);
      else omitted += 1;
    };

    let checked = 0;
    for (const flow of Object.values(standardFlows)) {
      if (flowId && flow.id !== flowId) continue;
      checked += 1;
      const cards = [
        { card: flow.trigger, where: 'trigger' },
        ...(flow.conditions || []).map((c, i) => ({ card: c, where: `condition ${i + 1}` })),
        ...(flow.actions || []).map((c, i) => ({ card: c, where: `action ${i + 1}` })),
      ];
      for (const { card, where } of cards) {
        const problem = this._cardProblem(card, devices, apps);
        if (!problem) continue;
        add({
          flow: flow.name,
          flowId: flow.id,
          type: 'standard',
          enabled: flow.enabled !== false,
          homeyReportsBroken: flow.broken === true,
          card: where,
          cardId: (card && card.id) || null,
          ...problem,
        });
      }
    }

    for (const flow of Object.values(advancedFlows)) {
      if (flowId && flow.id !== flowId) continue;
      checked += 1;
      const cards = flow.cards || {};
      const keys = Object.keys(cards);
      // Sticky notes are decoration, so counting them would inflate "x of y".
      const realCards = keys.filter((k) => cards[k] && cards[k].type !== 'note').length;
      for (const key of keys) {
        const card = cards[key];
        const problem = this._cardProblem(card, devices, apps);
        if (!problem) continue;
        const blocks = this._unreachableAfter(cards, key);
        add({
          flow: flow.name,
          flowId: flow.id,
          type: 'advanced',
          enabled: flow.enabled !== false,
          homeyReportsBroken: flow.broken === true,
          card: key,
          cardId: (card && card.id) || null,
          ...problem,
          blocksCards: blocks,
          totalCards: realCards,
          ...(blocks > 0
            ? { consequence: `${blocks} of ${realCards} cards in this flow no longer run` }
            : {}),
        });
      }
    }

    // A typo'd or stale flowId matches nothing, and silence would read as
    // "this flow is fine" about a flow that does not exist.
    if (flowId && checked === 0) {
      return { error: `No flow found with id ${flowId}. Use list_flows to look up the correct id.` };
    }

    return {
      flowsChecked: checked,
      problemsFound: findings.length + omitted,
      findings,
      ...(omitted > 0
        ? { omitted, note: `${omitted} further problem(s) were left out of this list.` }
        : {}),
      ...(appCheckSkipped ? { warning: appCheckSkipped } : {}),
      ...(findings.length === 0 && omitted === 0 ? { summary: 'No dead cards found.' } : {}),
    };
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
        ? c.args.map((a) => ({
            name: a.name,
            type: a.type,
            title: a.title,
            // Dropdowns carry their allowed values inline; autocomplete args
            // need a search_flow_card_autocomplete call instead.
            ...(a.type === 'dropdown' && Array.isArray(a.values) ? { values: a.values } : {}),
          }))
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

  /**
   * Resolve the allowed values for an "autocomplete" flow-card argument (the
   * user of a push notification, a playlist, a favourite, …). The model must
   * pass the chosen result object verbatim as the argument value.
   */
  async searchFlowCardAutocomplete({ cardId, kind, argName, query } = {}) {
    const api = await this._ensure();
    if (!['trigger', 'condition', 'action'].includes(kind)) {
      throw new Error(`Unknown card kind: ${kind}`);
    }
    const results = await api.flow.getFlowCardAutocomplete({
      id: cardId,
      type: kind,
      name: argName,
      query: query || '',
    });
    const list = Array.isArray(results) ? results.slice(0, 40) : results;
    return { cardId, argName, results: safeSerialize(list) };
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

  /**
   * Guard against invented device ids. Models must copy ids from tool
   * results, but the chat history only carries text, so they sometimes
   * fabricate a UUID — and Homey happily stores a flow whose device cards
   * point nowhere, which then silently does nothing at runtime (seen live:
   * "Neon achtertuin 20 sec uit"). Reject such flows with a clear error so
   * the model looks the id up instead.
   */
  async _assertDeviceCardsExist(cards) {
    const ids = new Set();
    for (const card of cards) {
      if (!card || typeof card.id !== 'string') continue;
      const m = card.id.match(/^homey:device:([0-9a-fA-F-]{36}):/);
      if (m) ids.add(m[1]);
    }
    if (!ids.size) return;
    const api = await this._ensure();
    const devices = await api.devices.getDevices();
    const missing = [...ids].filter((id) => !devices[id]);
    if (missing.length) {
      throw new Error(
        `Unknown device id(s) in flow cards: ${missing.join(', ')}. ` +
        'Device ids MUST come from a list_devices or get_flow result in this conversation — ' +
        'look the device up first and use its exact id.',
      );
    }
  }

  async createStandardFlow(flow) {
    const api = await this._ensure();
    await this._assertDeviceCardsExist([
      flow.trigger,
      ...(flow.conditions || []),
      ...(flow.actions || []),
    ]);
    const created = await api.flow.createFlow({ flow });
    return { ok: true, id: created.id, name: created.name, type: 'standard' };
  }

  async createAdvancedFlow(advancedflow) {
    const api = await this._ensure();
    const normalized = {
      ...advancedflow,
      cards: normalizeAdvancedFlowCards(advancedflow.cards),
    };
    await this._assertDeviceCardsExist(Object.values(normalized.cards || {}));
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
    const flow = {};
    for (const key of ['name', 'enabled', 'trigger', 'conditions', 'actions', 'folder']) {
      if (fields[key] !== undefined) flow[key] = fields[key];
    }
    await this._assertDeviceCardsExist([
      ...(flow.trigger ? [flow.trigger] : []),
      ...(flow.conditions || []),
      ...(flow.actions || []),
    ]);
    const backup = await this._backupFlow(flowId, 'standard');
    const updated = await api.flow.updateFlow({ id: flowId, flow });
    return { ok: true, id: flowId, name: updated.name, type: 'standard', backupId: backup.backupId };
  }

  async updateAdvancedFlowById({ flowId, name, enabled, cards } = {}) {
    const api = await this._ensure();
    const advancedflow = {};
    if (name !== undefined) advancedflow.name = name;
    if (enabled !== undefined) advancedflow.enabled = enabled;
    if (cards !== undefined) {
      advancedflow.cards = normalizeAdvancedFlowCards(cards);
      await this._assertDeviceCardsExist(Object.values(advancedflow.cards));
    }
    const backup = await this._backupFlow(flowId, 'advanced');
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

  // Note: FlowMind deliberately has no "run JavaScript" tool. Node's `vm` is
  // not a security boundary — any host object handed to the context (the API
  // client, setTimeout) reaches the real `process` via
  // `obj.constructor.constructor('return process')()`, which is full app
  // authority. Since the code would be chosen by an LLM whose input includes
  // strings the user does not control (device and flow names), that is not a
  // risk worth carrying. Removed in v0.5.5; use flows instead.

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
      if (FLOW_WRITING_TOOLS.has(name)) {
        const status = await this.getFlowWriteStatus();
        if (!status.canWrite) {
          return { error: flowWriteBlockedMessage(status) };
        }
      }
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
        case 'check_flows':
          return await this.checkFlows(input);
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
        case 'search_flow_card_autocomplete':
          return await this.searchFlowCardAutocomplete(input);
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
      // never sends the user down a dead end.
      if (/missing scopes/i.test(message) && this.apiMode !== 'local') {
        message +=
          '. Creating or changing flows needs a Homey API key: ask the user to create one' +
          ' at my.homey.app → Settings → System → API keys and paste it into the FlowMind' +
          ' settings under "Homey API key". There is no other route — the app token stays' +
          ' restricted whatever else is tried.';
      }
      return { error: message };
    }
  }
}

module.exports = HomeyContext;
