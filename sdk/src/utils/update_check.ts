// Ported 1:1 from LongHorizon-Harness src/lh_harness/utils/update_check.py
//
// The Python version polls PyPI; this port publishes to npm, so it reads the
// npm registry's packument instead. Function names, result shape, timeouts and
// message wording are unchanged apart from saying "npm" where they said "PyPI".
export const NPM_PROJECT_URL = "https://www.npmjs.com/package/lh-harness";
const _NPM_JSON_URL = "https://registry.npmjs.org/lh-harness";
const _MAX_RESPONSE_BYTES = 1024 * 1024;

export type UpdateCheckStatus = "up_to_date" | "update_available" | "failed";

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  current_version: string;
  latest_version: string;
  error: string;
};

function updateCheckResult(
  status: UpdateCheckStatus,
  currentVersion: string,
  latestVersion = "",
  error = "",
): UpdateCheckResult {
  return { status, current_version: currentVersion, latest_version: latestVersion, error };
}

export async function checkForUpdate(
  currentVersion: string,
  options: { timeout?: number } = {},
): Promise<UpdateCheckResult> {
  const timeout = options.timeout ?? 3.0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0.1, timeout) * 1000);
  try {
    const response = await fetch(_NPM_JSON_URL, {
      headers: { Accept: "application/json", "User-Agent": `lh-harness/${currentVersion}` },
      signal: controller.signal,
    });
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.length > _MAX_RESPONSE_BYTES) throw new Error("npm response exceeded 1 MiB");
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    const latestVersion = payload?.["dist-tags"]?.latest;
    if (typeof latestVersion !== "string" || !latestVersion.trim()) {
      throw new Error("npm response did not contain dist-tags.latest");
    }
    const current = parseVersion(currentVersion);
    const latest = parseVersion(latestVersion);
    const status: UpdateCheckStatus = compareVersions(latest, current) > 0 ? "update_available" : "up_to_date";
    return updateCheckResult(status, currentVersion, latestVersion);
  } catch (exc) {
    return updateCheckResult("failed", currentVersion, "", exc instanceof Error ? exc.message : String(exc));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Non-blocking variant of `check_for_update`.
 *
 * Python spawns a daemon thread named `lh-harness-update-check`; the promise
 * here plays the same role -- `result(timeout)` waits at most `timeout` seconds
 * and returns `null` when the check has not finished, so the CLI never blocks
 * beyond the caller-specified wait.
 */
export class UpdateCheckHandle {
  private _result: UpdateCheckResult | null = null;
  private _done = false;
  private readonly _promise: Promise<void>;

  constructor(currentVersion: string, options: { timeout?: number } = {}) {
    this._promise = checkForUpdate(currentVersion, options)
      .then((result) => {
        this._result = result;
      })
      .catch(() => {
        /* `check_for_update` never raises; the finally below still runs */
      })
      .finally(() => {
        this._done = true;
      });
  }

  async result(timeout = 0): Promise<UpdateCheckResult | null> {
    await Promise.race([
      this._promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, timeout) * 1000);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    return this._done ? this._result : null;
  }
}

export function startUpdateCheck(
  currentVersion: string,
  options: { timeout?: number } = {},
): UpdateCheckHandle {
  return new UpdateCheckHandle(currentVersion, options);
}

type ParsedVersion = { release: number[]; pre: (string | number)[] | null };

/** `packaging.version.Version`, reduced to what a published version can be. */
export function parseVersion(value: string): ParsedVersion {
  const match = /^\s*v?(\d+(?:\.\d+)*)(?:[-.]?([0-9A-Za-z.-]+))?\s*$/.exec(String(value));
  if (!match) throw new Error(`Invalid version: '${value}'`);
  const release = match[1].split(".").map((part) => Number(part));
  if (release.some((part) => !Number.isFinite(part))) throw new Error(`Invalid version: '${value}'`);
  const rest = match[2];
  if (!rest) return { release, pre: null };
  const pre = rest
    .split(/[.-]/)
    .filter((part) => part !== "")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { release, pre };
}

export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.release[index] ?? 0;
    const b = right.release[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  // A release outranks any pre-release of the same numbers.
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const preLength = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < preLength; index += 1) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
