'use strict';

/**
 * Provider-agnostic tool definitions.
 *
 * Every tool is described once, in a neutral shape:
 *   { name, description, input_schema (JSON Schema) }
 *
 * The LLM providers (lib/llm/*.js) translate this shape into their own
 * function-calling format (Anthropic `tools`, OpenAI `tools[].function`).
 * Execution is centralised in HomeyContext.executeTool().
 */

const TOOL_DEFINITIONS = [
  {
    name: 'get_system_overview',
    description:
      'Get a compact overview of the whole Homey: counts of devices, zones, flows and moods, plus the zone tree and the list of device classes present. Call this first to orient yourself before doing anything else.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_devices',
    description:
      'List devices with their id, name, zone, class, virtualClass, available capabilities and the current value of each capability. Use the filters to keep the response small.',
    input_schema: {
      type: 'object',
      properties: {
        zoneId: { type: 'string', description: 'Only return devices in this zone id.' },
        class: {
          type: 'string',
          description: 'Only return devices of this class, e.g. "light", "socket", "thermostat", "sensor".',
        },
        search: {
          type: 'string',
          description: 'Case-insensitive substring match on the device name.',
        },
      },
    },
  },
  {
    name: 'list_zones',
    description: 'List all zones (rooms) with id, name and parent zone id.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_flows',
    description:
      'List existing flows. Returns id, name, type ("standard" or "advanced") and enabled state. Use get_flow to inspect a single flow in detail.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['standard', 'advanced', 'all'],
          description: 'Which flow type to list. Defaults to "all".',
        },
        search: { type: 'string', description: 'Case-insensitive substring match on the flow name.' },
      },
    },
  },
  {
    name: 'get_flow',
    description:
      'Get the full definition of a single flow, including its trigger/conditions/actions (standard) or its node-based card graph (advanced). Use this to learn the exact structure before editing or copying a flow.',
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        type: {
          type: 'string',
          enum: ['standard', 'advanced'],
          description: 'The flow type. If omitted it is auto-detected.',
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'list_moods',
    description: 'List all moods (light scenes) with id, name and the zone they belong to.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'control_device',
    description:
      'Set a single capability value on a device. Examples: onoff=true/false, dim=0..1, target_temperature=21, light_hue=0..1. deviceId MUST come from a list_devices/get_system_overview result fetched in THIS conversation — ids from your memory of earlier turns may be stale or wrong, and inventing ids fires real commands at the wrong targets. When in doubt, list first.',
    input_schema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        capabilityId: {
          type: 'string',
          description: 'The capability to set, e.g. "onoff", "dim", "target_temperature".',
        },
        value: {
          description:
            'The new value, as a real JSON type: true/false (not "true") for onoff, a number (not "21") for dim/target_temperature, a string for enum capabilities.',
        },
      },
      required: ['deviceId', 'capabilityId', 'value'],
    },
  },
  {
    name: 'activate_mood',
    description: 'Activate (set) a mood / light scene by its id.',
    input_schema: {
      type: 'object',
      properties: { moodId: { type: 'string' } },
      required: ['moodId'],
    },
  },
  {
    name: 'start_flow',
    description: 'Trigger/run an existing flow by its id (works for flows that can be started).',
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        type: { type: 'string', enum: ['standard', 'advanced'] },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'list_flow_cards',
    description:
      'List the available Flow cards you can use to build flows. Returns card id, title, hint and argument definitions. `kind` selects trigger/condition/action cards. Filter with `search` to avoid huge responses. For device-specific actions you usually do NOT need this: use the device card id pattern documented in the system prompt.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['trigger', 'condition', 'action'] },
        search: { type: 'string', description: 'Case-insensitive substring match on card id/title.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'search_flow_card_autocomplete',
    description:
      'Look up the allowed values for a flow-card argument of type "autocomplete" (e.g. the user of a push notification, a playlist, a speaker favourite). Returns candidate objects; pass the chosen object VERBATIM (all fields) as the argument value in the card args. ALWAYS use this before filling an autocomplete argument — never invent the value.',
    input_schema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'Full flow-card id, e.g. homey:manager:mobile:push_text.' },
        kind: { type: 'string', enum: ['trigger', 'condition', 'action'] },
        argName: { type: 'string', description: 'Name of the autocomplete argument, e.g. "user".' },
        query: { type: 'string', description: 'Optional search text to filter the values.' },
      },
      required: ['cardId', 'kind', 'argName'],
    },
  },
  {
    name: 'create_standard_flow',
    description:
      'Create a new standard (basic) flow. Provide the full flow object: { name, enabled, trigger, conditions, actions }. See the system prompt for the exact card structure. Prefer creating flows only after the user confirmed the plan.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        trigger: {
          type: 'object',
          description: 'One trigger card: { id, args, droptoken? }.',
          properties: {
            id: { type: 'string' },
            args: { type: 'object' },
            droptoken: { type: 'string' },
          },
          required: ['id', 'args'],
        },
        conditions: {
          type: 'array',
          description: 'Condition cards: { id, args, group ("group1|group2|group3"), inverted }.',
          items: { type: 'object' },
        },
        actions: {
          type: 'array',
          description: 'Action cards: { id, args, group ("then|else"), delay?, duration?, droptoken? }.',
          items: { type: 'object' },
        },
      },
      required: ['name', 'enabled', 'trigger', 'conditions', 'actions'],
    },
  },
  {
    name: 'create_advanced_flow',
    description:
      'Create a new Advanced Flow (node-based). Provide { name, enabled, cards } where `cards` is an object keyed by generated UUIDs. Each card has type (start|trigger|condition|action|delay|all|any|note), x, y and connection arrays (outputSuccess / outputError / outputTrue / outputFalse) referencing other card UUIDs. See the system prompt for the exact schema and a worked example.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        cards: {
          type: 'object',
          description: 'Map of cardUuid -> card object. See system prompt for the schema per card type.',
        },
      },
      required: ['name', 'enabled', 'cards'],
    },
  },
  {
    name: 'update_standard_flow',
    description:
      'Update an existing standard flow. Provide the flowId and the fields to change ({ name?, enabled?, trigger?, conditions?, actions? }). A JSON backup of the current flow is made automatically before the change. Only do this after the user confirmed.',
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        trigger: { type: 'object' },
        conditions: { type: 'array', items: { type: 'object' } },
        actions: { type: 'array', items: { type: 'object' } },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'update_advanced_flow',
    description:
      'Update an existing Advanced Flow. Provide flowId and the fields to change ({ name?, enabled?, cards? }). When you pass `cards` it fully replaces the graph — first read the current flow with get_flow so you keep the parts you want. A JSON backup is made automatically. Only do this after the user confirmed.',
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        cards: { type: 'object', description: 'Full card graph (same schema as create_advanced_flow).' },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'delete_flow',
    description:
      'Delete a flow (standard or advanced) by id. A JSON backup is made automatically before deletion so it can be restored. This is destructive — only do this after the user explicitly confirmed.',
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        type: { type: 'string', enum: ['standard', 'advanced'] },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'list_backups',
    description:
      'List the automatic backups of flows that were made before an edit or deletion. Returns backupId, flow name, type and timestamp.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'restore_backup',
    description:
      'Restore a flow from a backup (see list_backups). Recreates the flow from the stored JSON. Confirm with the user first.',
    input_schema: {
      type: 'object',
      properties: { backupId: { type: 'string' } },
      required: ['backupId'],
    },
  },
  {
    name: 'run_script',
    description:
      'Run a short JavaScript snippet on the Homey (like HomeyScript). The code runs with `await` support and has access to `homeyApi` (the Homey Web API client) and `console.log`. Return a value or log output. Use this for advanced/one-off tasks that the other tools do not cover. Must be enabled by the user in the app settings; if disabled it returns an error. Explain what the script does and confirm before running anything that changes state.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript source. `homeyApi` and `console` are in scope; top-level await is allowed.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Save a lasting fact or preference to persistent memory (kept across conversations, shown in every system prompt). Use when the user shares something worth remembering long-term: routines ("we sleep at 23:00"), preferences ("the nursery must stay at 19°C"), naming ("the big lamp = the floor lamp in the living room"). Keep it short and factual. Do NOT save one-off commands or things already visible in the system.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember, short and self-contained (max 500 chars).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_memories',
    description: 'List all saved memories with their ids. The current memories are also already included in your system prompt.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_memory',
    description: 'Delete a saved memory by its id (see the "[id]" prefix in the memories list). Use when the user asks to forget something or when a memory is outdated.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_insights_logs',
    description:
      'List the available Insights logs (historic sensor/energy data), e.g. temperature, power or humidity per device. Returns log id, uri, title, type, units and last value. Use `search` to filter (e.g. a device name or "temperature").',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Case-insensitive substring match on log id/title/uri.' },
      },
    },
  },
  {
    name: 'get_insights_entries',
    description:
      'Get the historic data points of one Insights log (see list_insights_logs for uri + id). Use `resolution` to pick the window: lastHour, last6Hours, last24Hours, last7Days, last14Days, last31Days, today, yesterday, thisWeek, lastWeek, thisMonth, lastMonth, thisYear, lastYear. Large series are sampled down to ~200 points.',
    input_schema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'The log uri, e.g. "homey:device:<id>".' },
        id: { type: 'string', description: 'The log id, e.g. "measure_temperature".' },
        resolution: { type: 'string', description: 'Time window, e.g. "last24Hours" or "last7Days".' },
      },
      required: ['uri', 'id'],
    },
  },
];

module.exports = { TOOL_DEFINITIONS };
