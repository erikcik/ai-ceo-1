// Ported 1:1 from LongHorizon-Harness src/lh_harness/webapi/protocol.py
//
// Versioned protocol metadata for the Web client.

export const API_VERSION = "1";
export const PROTOCOL_VERSION = "1";
export const SERVICE_NAME = "lh-harness";

export const DEFAULT_CAPABILITIES: Record<string, boolean> = {
  websocket: true,
  replay: true,
  approvals: true,
  injections: true,
  run_control: false,
  multi_run: true,
};

export type BuildMetaOptions = {
  endpoint: string;
  capabilities?: Record<string, unknown> | null;
  server_time?: number | null;
  agents?: Record<string, unknown>[] | null;
  models?: Record<string, Record<string, unknown>[]> | null;
  defaults?: Record<string, unknown> | null;
  model_discovery?: Record<string, Record<string, unknown>> | null;
  external_tools?: Record<string, unknown>[] | null;
};

/** Return the stable handshake payload used by both clients. */
export function buildMeta(options: BuildMetaOptions): Record<string, unknown> {
  const merged: Record<string, boolean> = { ...DEFAULT_CAPABILITIES };
  if (options.capabilities) {
    for (const [key, value] of Object.entries(options.capabilities)) {
      merged[String(key)] = Boolean(value);
    }
  }
  const result: Record<string, unknown> = {
    service: SERVICE_NAME,
    api_version: API_VERSION,
    protocol_version: PROTOCOL_VERSION,
    capabilities: merged,
    server_time: options.server_time === undefined || options.server_time === null ? Date.now() / 1000 : options.server_time,
    endpoint: options.endpoint,
  };
  if (options.agents !== undefined && options.agents !== null) {
    result.agents = options.agents;
  }
  if (options.models !== undefined && options.models !== null) {
    result.models = options.models;
  }
  if (options.defaults !== undefined && options.defaults !== null) {
    result.defaults = options.defaults;
  }
  if (options.model_discovery !== undefined && options.model_discovery !== null) {
    result.model_discovery = options.model_discovery;
  }
  if (options.external_tools !== undefined && options.external_tools !== null) {
    result.external_tools = options.external_tools;
  }
  return result;
}
