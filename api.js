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

  // Starts a chat turn and returns a job id straight away. Homey cancels app
  // API requests from a settings page after ~10s, which is far less than an
  // assistant turn needs, so the answer is collected via getChatJob instead.
  async chat({ homey, body }) {
    return homey.app.startChat(body || {});
  },

  async getChatJob({ homey, params }) {
    return homey.app.getChatJob({ jobId: params && params.jobId });
  },

  async getMemories({ homey }) {
    return homey.app.getMemories();
  },

  async deleteMemory({ homey, params }) {
    return homey.app.deleteMemory({ id: params && params.id });
  },
};
