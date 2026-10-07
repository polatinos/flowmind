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
// check_flows also asks apps for their current autocomplete lists (scenes,
// users, variables, favourites). Each lookup may reach a cloud service, so
// cap the number of lookups, how many run at once, the wait for each, and
// the whole pass (check_flows may run inside a flow via ai_do/ai_ask).
// Tarik's home (45 flows) has 36 distinct card/argument pairs; most answer
// locally within milliseconds. Name searches get their own budget, so the
// full lists cannot use up the slots the follow-up searches need.
const DIAGNOSE_MAX_LIST_LOOKUPS = 40;
const DIAGNOSE_MAX_NAME_LOOKUPS = 15;
const DIAGNOSE_LOOKUP_CONCURRENCY = 6;
const DIAGNOSE_LOOKUP_TIMEOUT_MS = 5000;
const DIAGNOSE_LOOKUP_BUDGET_MS = 15000;
const DIAGNOSE_MAX_LOOKUP_ERRORS = 5;

/** Reject when `promise` has not settled within `ms` (it keeps running). */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Autocomplete values identify their entry by `id` or by `data.id`,
// depending on the app (Tuya scenes vs SwitchBot scenes).
function autocompleteId(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.id != null) return String(entry.id);
  if (entry.data && entry.data.id != null) return String(entry.data.id);
  return null;
}

function autocompleteName(entry) {
  return entry && typeof entry.name === 'string' ? entry.name.trim().toLowerCase() : null;
}

/** Does `list` still contain `value`? Undecidable values count as present. */
function autocompleteOffers(list, value) {
  const id = autocompleteId(value);
  if (id) return list.some((entry) => autocompleteId(entry) === id);
  const name = autocompleteName(value);
  return name ? list.some((entry) => autocompleteName(entry) === name) : true;
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

    const deviceMatch = id.match(/^homey:device:([0-9a-fA-F-]{36}):/);
    const device = deviceMatch ? devices[deviceMatch[1]] : null;
    if (deviceMatch && !device) {
      return { problem: 'missing_device', detail: `points at device ${deviceMatch[1]}, which no longer exists` };
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

    // The device exists but Homey has marked it unavailable (offline, logged
    // out, its app crashed), so its cards fail or never fire. When the app
    // behind it is the cause, name the app: that is what the user must fix.
    if (device && device.available === false) {
      const driverApp = String(device.driverId || '').match(/^homey:app:([^:]+):/);
      if (apps && driverApp) {
        const bad = this._appProblem(driverApp[1], apps, `controls device "${device.name}" through`);
        if (bad) return bad;
      }
      return {
        problem: 'device_unavailable',
        detail:
          `points at device "${device.name}", which Homey reports as unavailable` +
          (device.unavailableMessage ? `: ${device.unavailableMessage}` : ''),
      };
    }
    return null;
  }

  /**
   * Find autocomplete arguments whose saved value the app no longer offers.
   *
   * An autocomplete value (a SwitchBot scene, a Tuya scene, a push recipient)
   * is a copy of one entry from the app's list at the moment the card was
   * filled in. When that entry disappears (the scene was deleted, or the app
   * now logs in with another account) Homey still calls the flow healthy,
   * while the card fails on every run. Seen live on 2026-10-07: after the
   * office SwitchBot app switched accounts, a flow still held the old scenes.
   *
   * @param {object} api
   * @param {Array<{card: object, kind: string}>} entries  healthy cards with
   *   their kind (trigger | condition | action)
   * @returns {Promise<{problems: Map<object, object>, errors: Array, unchecked: number}>}
   */
  async _staleAutocompleteArgs(api, entries) {
    const problems = new Map();
    const errors = [];
    let unchecked = 0;
    const objectArgs = (card) =>
      Object.entries((card && card.args) || {}).filter(
        ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
      );
    const candidates = entries.filter(({ card }) => typeof card.id === 'string' && objectArgs(card).length);
    if (!candidates.length) return { problems, errors, unchecked };

    // Device and dropdown values are objects too; only the card definition
    // says which arguments are autocomplete.
    const loaders = {
      trigger: () => api.flow.getFlowCardTriggers(),
      condition: () => api.flow.getFlowCardConditions(),
      action: () => api.flow.getFlowCardActions(),
    };
    const defs = {};
    await Promise.all([...new Set(candidates.map((c) => c.kind))].map(async (kind) => {
      try {
        defs[kind] = await loaders[kind]();
      } catch (err) {
        defs[kind] = {};
      }
    }));

    // Each lookup resolves to the entry list or to an Error, never rejects.
    // A small queue keeps a Homey Pro from running dozens of app listeners
    // at once.
    let active = 0;
    const waiting = [];
    const limited = (task) => new Promise((resolve) => {
      const run = () => {
        active += 1;
        task().then(resolve).finally(() => {
          active -= 1;
          if (waiting.length) waiting.shift()();
        });
      };
      if (active < DIAGNOSE_LOOKUP_CONCURRENCY) run();
      else waiting.push(run);
    });
    const lists = new Map();
    const used = { list: 0, name: 0 };
    const deadline = Date.now() + DIAGNOSE_LOOKUP_BUDGET_MS;
    // Returns null when a budget is spent; the caller counts that as unchecked.
    const lookup = (kind, cardId, argName, query) => {
      const key = JSON.stringify([kind, cardId, argName, query]);
      if (!lists.has(key)) {
        const bucket = query ? 'name' : 'list';
        const cap = query ? DIAGNOSE_MAX_NAME_LOOKUPS : DIAGNOSE_MAX_LIST_LOOKUPS;
        if (used[bucket] >= cap || Date.now() >= deadline) return null;
        used[bucket] += 1;
        lists.set(key, limited(() => {
          // A lookup queued behind slow ones gets only what is left of the pass.
          const remaining = deadline - Date.now();
          if (remaining <= 0) return Promise.resolve(null);
          return withTimeout(
            api.flow.getFlowCardAutocomplete({ id: cardId, type: kind, name: argName, query }),
            Math.min(DIAGNOSE_LOOKUP_TIMEOUT_MS, remaining),
          ).then(
            (result) => (Array.isArray(result) ? result : []),
            (err) => (err instanceof Error ? err : new Error(String(err))),
          );
        }));
      }
      return lists.get(key);
    };
    const entryKeys = (list) => list.map((e) => autocompleteId(e) || autocompleteName(e)).sort().join('\n');

    await Promise.all(candidates.map(async ({ card, kind, flow, where }) => {
      const def = defs[kind] && defs[kind][card.id];
      const argDefs = (def && Array.isArray(def.args) ? def.args : []).filter((a) => a.type === 'autocomplete');
      for (const argDef of argDefs) {
        const value = card.args[argDef.name];
        if (!value || typeof value !== 'object') continue;
        const all = await lookup(kind, card.id, argDef.name, '');
        if (all === null) { unchecked += 1; continue; }
        if (all instanceof Error) {
          // The app cannot list its options at all (often a lapsed login),
          // which usually means the card fails too. Not proof, so report it
          // apart from the findings.
          if (errors.length < DIAGNOSE_MAX_LOOKUP_ERRORS) {
            errors.push({ flow, card: where, cardId: card.id, argument: argDef.name, error: all.message });
          }
          continue;
        }
        if (autocompleteOffers(all, value)) continue;
        // A list may only show the first matches for an empty query, so
        // search by name before calling the value gone.
        let byName = [];
        if (typeof value.name === 'string' && value.name.trim()) {
          const found = await lookup(kind, card.id, argDef.name, value.name.trim());
          if (found === null || found instanceof Error) { unchecked += 1; continue; }
          if (autocompleteOffers(found, value)) continue;
          // An app that ignores the query returns the same list twice. If that
          // list is capped, the value may sit past the cap, so do not call it
          // gone. Every app checked at home on 2026-10-07 did filter.
          if (all.length && entryKeys(found) === entryKeys(all)) { unchecked += 1; continue; }
          byName = found;
        }
        const twin = [...all, ...byName].find(
          (entry) => autocompleteName(entry) && autocompleteName(entry) === autocompleteName(value),
        );
        problems.set(card, {
          problem: 'stale_argument',
          detail:
            `argument "${argDef.name}" is set to "${value.name || autocompleteId(value)}", which the app does ` +
            'not offer right now (deleted, renamed, offline, or the app now uses another account)',
          ...(twin ? { fix: `an entry named "${twin.name}" exists under a new id; re-select it` } : {}),
        });
        return;
      }
    }));
    return { problems, errors, unchecked };
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

    // Pass 1: every card of every flow in scope, with its synchronous verdict.
    const entries = [];
    let checked = 0;
    for (const flow of Object.values(standardFlows)) {
      if (flowId && flow.id !== flowId) continue;
      checked += 1;
      const cards = [
        { card: flow.trigger, where: 'trigger', kind: 'trigger' },
        ...(flow.conditions || []).map((c, i) => ({ card: c, where: `condition ${i + 1}`, kind: 'condition' })),
        ...(flow.actions || []).map((c, i) => ({ card: c, where: `action ${i + 1}`, kind: 'action' })),
      ];
      for (const { card, where, kind } of cards) {
        if (!card) continue;
        entries.push({ flow, type: 'standard', card, where, kind, problem: this._cardProblem(card, devices, apps) });
      }
    }
    for (const flow of Object.values(advancedFlows)) {
      if (flowId && flow.id !== flowId) continue;
      checked += 1;
      for (const [key, card] of Object.entries(flow.cards || {})) {
        if (!card) continue;
        const kind = ['trigger', 'condition', 'action'].includes(card.type) ? card.type : null;
        entries.push({ flow, type: 'advanced', card, where: key, kind, problem: this._cardProblem(card, devices, apps) });
      }
    }

    // A typo'd or stale flowId matches nothing, and silence would read as
    // "this flow is fine" about a flow that does not exist.
    if (flowId && checked === 0) {
      return { error: `No flow found with id ${flowId}. Use list_flows to look up the correct id.` };
    }

    // Pass 2: ask the apps whether the saved autocomplete values still exist.
    const stale = await this._staleAutocompleteArgs(
      api,
      entries
        .filter((e) => !e.problem && e.kind)
        .map((e) => ({ card: e.card, kind: e.kind, flow: e.flow.name, where: e.where })),
    );

    const findings = [];
    let omitted = 0;
    for (const entry of entries) {
      const problem = entry.problem || stale.problems.get(entry.card);
      if (!problem) continue;
      if (findings.length >= DIAGNOSE_MAX_FINDINGS) {
        omitted += 1;
        continue;
      }
      const { flow, card } = entry;
      const finding = {
        flow: flow.name,
        flowId: flow.id,
        type: entry.type,
        enabled: flow.enabled !== false,
        homeyReportsBroken: flow.broken === true,
        card: entry.where,
        cardId: card.id || null,
        ...problem,
      };
      if (entry.type === 'advanced') {
        const cards = flow.cards || {};
        // Sticky notes are decoration, so counting them would inflate "x of y".
        const realCards = Object.keys(cards).filter((k) => cards[k] && cards[k].type !== 'note').length;
        const blocks = this._unreachableAfter(cards, entry.where);
        finding.blocksCards = blocks;
        finding.totalCards = realCards;
        if (blocks > 0) finding.consequence = `${blocks} of ${realCards} cards in this flow no longer run`;
      }
      findings.push(finding);
    }

    const result = {
      flowsChecked: checked,
      problemsFound: findings.length + omitted,
      findings,
    };
    if (omitted > 0) {
      result.omitted = omitted;
      result.note = `${omitted} further problem(s) were left out of this list.`;
    }
    if (stale.errors.length) result.autocompleteErrors = stale.errors;
    if (stale.unchecked > 0) {
      result.argumentsNotChecked =
        `${stale.unchecked} autocomplete argument(s) were not checked, to keep this call fast. ` +
        'Check a single flow with flowId to cover them.';
    }
    if (appCheckSkipped) result.warning = appCheckSkipped;
    if (findings.length === 0 && omitted === 0) result.summary = 'No dead cards found.';
    return result;
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
