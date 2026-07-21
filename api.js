'use strict';

/**
 * Web API endpoints for the app settings page (chat UI).
 * Route names/paths are declared in app.json under "api"; the handlers here
 * must match those names. `homey.app` is the FlowMindApp instance from app.js.
 */
module.exports = {
  async getConfig({ homey }) {
    return homey.app.getConfig();
  },

  async saveConfig({ homey, body }) {
    return homey.app.saveConfig(body || {});
  },

  async chat({ homey, body }) {
    return homey.app.chat(body || {});
  },

  async getMemories({ homey }) {
    return homey.app.getMemories();
  },

  async deleteMemory({ homey, params }) {
    return homey.app.deleteMemory({ id: params && params.id });
  },
};
