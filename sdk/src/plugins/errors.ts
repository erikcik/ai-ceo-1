// Ported 1:1 from LongHorizon-Harness src/lh_harness/plugins/errors.py

/** Raised when a plugin cannot be inspected or made ready. */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}
