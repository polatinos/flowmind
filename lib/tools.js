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
      'Set a single capability value on a device. Examples: onoff=true/false, dim=0..1, target_temperature=21, light_hue=0..1. Always confirm the device exists (via list_devices) and use the exact deviceId and capabilityId.',
    input_schema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        capabilityId: {
          type: 'string',
          description: 'The capability to set, e.g. "onoff", "dim", "target_temperature".',
        },
        value: {
          description: 'The new value. Boolean for onoff, number for dim/target_temperature, string for enum capabilities.',
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
];

module.exports = { TOOL_DEFINITIONS };
