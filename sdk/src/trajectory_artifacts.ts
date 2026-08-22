// Ported 1:1 from LongHorizon-Harness src/lh_harness/trajectory_artifacts.py.
//
// Durable Dashboard screenshot records for provider role trajectories.
//
// Provider CLIs may embed screenshots as base64 content blocks in their JSONL
// stdout. That stream remains useful for diagnostics, but it is not a stable
// display protocol. This module materialises screenshots as regular image files
// and writes a provider-neutral trajectory containing `screenshot_file`
// references. These files stay in the private run record; they are not copied
// into the task Workspace or supplied to the Auditor as completion evidence.
// The streaming writer persists each complete event so records survive
// interruption.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseTrajectory, type TrajectoryStep } from "./agent_logs.js";
import { appendJsonl, atomicBytesWrite, openNofollow } from "./supervisor/control_bus.js";
import { pyLstrip, pyStrip } from "./utils/pystr.js";

const _ROLE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const _DATA_IMAGE_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;
const _EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const _MAX_SCREENSHOTS = 256;
const _MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const _MAX_TOTAL_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const _MAX_NORMALIZED_STEPS = 5_000;

export type ScreenshotItem = {
  step_num: number;
  image_index: number;
  screenshot_file: string;
  media_type: string;
  bytes: number;
  sha256: string;
};

export type ScreenshotManifest = {
  schema_version: number;
  role: string;
  trajectory_file: string;
  live: boolean;
  screenshot_count: number;
  total_screenshot_bytes: number;
  screenshots: Record<string, unknown>[];
};

export type TrajectoryArtifactSummary = {
  normalized_trajectory: string;
  screenshot_manifest: string;
  screenshot_count: number;
  total_screenshot_bytes: number;
  screenshots: Record<string, unknown>[];
};

/** Persist screenshots as soon as complete provider JSONL records arrive. */
export class StreamingTrajectoryArtifactWriter {
  readonly roundDir: string;
  readonly roleName: string;
  stepCount = 0;
  totalBytes = 0;
  screenshots: Record<string, unknown>[] = [];
  seenToolIds = new Set<string>();
  readonly trajectoryPath: string;
  readonly manifestPath: string;

  constructor(options: { roundDir: string; roleName: string }) {
    const { roundDir, roleName } = options;
    if (!_ROLE_RE.test(roleName)) throw new Error(`invalid trajectory role: ${pyRepr(roleName)}`);
    this.roundDir = roundDir;
    this.roleName = roleName;
    this.trajectoryPath = path.join(roundDir, `${roleName}_trajectory.jsonl`);
    this.manifestPath = path.join(roundDir, `${roleName}_screenshots.json`);
    removeRoleStepImages(roundDir, roleName);
    atomicBytesWrite(this.trajectoryPath, Buffer.alloc(0));
    this.writeManifest(true);
  }

  static fromLivePath(livePath: string): StreamingTrajectoryArtifactWriter | null {
    const suffix = "_raw_trajectory";
    const extension = path.extname(livePath);
    const stem = path.basename(livePath, extension);
    if (extension !== ".jsonl" || !stem.endsWith(suffix)) return null;
    const roleName = stem.slice(0, stem.length - suffix.length);
    const parent = path.dirname(livePath);
    if (!/^round_\d+$/.test(path.basename(parent))) return null;
    try {
      return new StreamingTrajectoryArtifactWriter({ roundDir: parent, roleName });
    } catch {
      return null;
    }
  }

  consumeLine(line: Buffer | string): void {
    if (this.stepCount >= _MAX_NORMALIZED_STEPS) return;
    const raw = Buffer.isBuffer(line) ? line.toString("utf-8") : String(line);
    for (const sourceStep of parseTrajectory(raw)) {
      if (this.stepCount >= _MAX_NORMALIZED_STEPS) break;
      // Codex sends `item.started` and `item.completed` as separate JSONL
      // records.  Parsing one streamed line at a time means the completion
      // record defensively contains the tool call again, even though the
      // earlier start record already materialised it.  Keep the first call and
      // the later result so the live Dashboard shows one command card that
      // transitions to completed.
      if (sourceStep["kind"] === "tool_use") {
        const toolId = pyStrip(String(sourceStep["id"] || ""));
        if (toolId && this.seenToolIds.has(toolId)) continue;
        if (toolId) this.seenToolIds.add(toolId);
      }
      this.stepCount += 1;
      const [step, newItems, newBytes] = materializeStep(sourceStep, {
        stepIndex: this.stepCount,
        roundDir: this.roundDir,
        roleName: this.roleName,
        screenshotCount: this.screenshots.length,
        totalBytes: this.totalBytes,
      });
      appendJsonl(this.trajectoryPath, step);
      if (newItems.length) {
        this.screenshots.push(...newItems);
        this.totalBytes += newBytes;
        this.writeManifest(true);
      }
    }
  }

  private writeManifest(live: boolean): void {
    const manifest = buildManifest(this.roleName, this.screenshots, this.totalBytes, live);
    atomicBytesWrite(this.manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8"));
  }
}

/** Finalize embedded screenshots in the Dashboard's private run record. */
export function persistTrajectoryArtifacts(
  raw: string,
  options: { roundDir: string; roleName: string },
): TrajectoryArtifactSummary {
  const { roundDir, roleName } = options;
  if (!_ROLE_RE.test(roleName)) throw new Error(`invalid trajectory role: ${pyRepr(roleName)}`);

  removeRoleStepImages(roundDir, roleName);
  const steps = parseTrajectory(raw ? String(raw) : "", { maxSteps: _MAX_NORMALIZED_STEPS });
  const normalized: TrajectoryStep[] = [];
  const screenshots: Record<string, unknown>[] = [];
  let totalBytes = 0;

  let stepIndex = 0;
  for (const sourceStep of steps) {
    stepIndex += 1;
    const [step, newItems, newBytes] = materializeStep(sourceStep, {
      stepIndex,
      roundDir,
      roleName,
      screenshotCount: screenshots.length,
      totalBytes,
    });
    screenshots.push(...newItems);
    totalBytes += newBytes;
    normalized.push(step);
  }

  const trajectoryName = `${roleName}_trajectory.jsonl`;
  const manifestName = `${roleName}_screenshots.json`;
  const trajectoryPayload = jsonlBytes(normalized);
  const manifest = buildManifest(roleName, screenshots, totalBytes, false);
  const manifestPayload = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  atomicBytesWrite(path.join(roundDir, trajectoryName), trajectoryPayload);
  atomicBytesWrite(path.join(roundDir, manifestName), manifestPayload);

  return {
    normalized_trajectory: trajectoryName,
    screenshot_manifest: manifestName,
    screenshot_count: screenshots.length,
    total_screenshot_bytes: totalBytes,
    screenshots,
  };
}

function materializeStep(
  sourceStep: TrajectoryStep,
  options: {
    stepIndex: number;
    roundDir: string;
    roleName: string;
    screenshotCount: number;
    totalBytes: number;
  },
): [TrajectoryStep, Record<string, unknown>[], number] {
  const { stepIndex, roundDir, roleName, screenshotCount, totalBytes } = options;
  const step = stripInlineImages(sourceStep) as TrajectoryStep;
  step["step_num"] = stepIndex;
  const files: string[] = [];
  const items: Record<string, unknown>[] = [];
  let writtenBytes = 0;
  const sourceImages = sourceStep["images"];
  if (Array.isArray(sourceImages)) {
    let imageIndex = 0;
    for (const source of sourceImages) {
      imageIndex += 1;
      if (screenshotCount + items.length >= _MAX_SCREENSHOTS) break;
      const decoded = decodeDataImage(source);
      if (decoded === null) continue;
      const [mediaType, payload] = decoded;
      if (payload.length > _MAX_SCREENSHOT_BYTES) continue;
      if (totalBytes + writtenBytes + payload.length > _MAX_TOTAL_SCREENSHOT_BYTES) continue;
      const extension = _EXTENSION_BY_MEDIA_TYPE[mediaType];
      const filename = `${roleName}_step_${zeroPad(stepIndex, 4)}_${zeroPad(imageIndex, 2)}${extension}`;
      const digest = crypto.createHash("sha256").update(payload).digest("hex");
      atomicBytesWrite(path.join(roundDir, filename), payload);
      files.push(filename);
      items.push({
        step_num: stepIndex,
        image_index: imageIndex,
        screenshot_file: filename,
        media_type: mediaType,
        bytes: payload.length,
        sha256: digest,
      });
      writtenBytes += payload.length;
    }
  }
  if (files.length) {
    step["has_image"] = true;
    step["screenshot_file"] = files[0];
    if (files.length > 1) step["screenshot_files"] = files;
  }
  return [step, items, writtenBytes];
}

function buildManifest(
  roleName: string,
  screenshots: Record<string, unknown>[],
  totalBytes: number,
  live: boolean,
): ScreenshotManifest {
  return {
    schema_version: 1,
    role: roleName,
    trajectory_file: `${roleName}_trajectory.jsonl`,
    live,
    screenshot_count: screenshots.length,
    total_screenshot_bytes: totalBytes,
    screenshots,
  };
}

/** Remove only image files generated by this exact role protocol. */
function removeRoleStepImages(directory: string, roleName: string): void {
  const pattern = new RegExp(`^${reEscape(roleName)}_step_\\d{4}_\\d{2}\\.(?:png|jpg|webp|gif)$`);
  let names: string[];
  try {
    // Python opens the directory with `_open_nofollow(..., directory=True)`
    // first, so a swapped `round_*` link never has its contents listed.
    fs.closeSync(openNofollow(directory, { directory: true }));
    names = fs.readdirSync(directory).filter((name) => pattern.test(name));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(directory, name));
    } catch {
      continue;
    }
  }
}

function decodeDataImage(value: unknown): [string, Buffer] | null {
  if (typeof value !== "string") return null;
  const match = _DATA_IMAGE_RE.exec(pyStrip(value));
  if (match === null) return null;
  let mediaType = match[1].toLowerCase();
  if (mediaType === "image/jpg") mediaType = "image/jpeg";
  const encoded = match[2].replace(/\s+/g, "");
  // Python `base64.b64decode(..., validate=True)`: strict alphabet and padding.
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  let payload: Buffer;
  try {
    payload = Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
  if (!payload.length) return null;
  return [mediaType, payload];
}

/** Copy normalized data while ensuring the small JSONL has no data URLs. */
function stripInlineImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripInlineImages(item));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "images") continue;
      out[String(key)] = stripInlineImages(item);
    }
    return out;
  }
  if (typeof value === "string" && pyLstrip(value).toLowerCase().startsWith("data:image/")) {
    return "[screenshot persisted separately]";
  }
  return value;
}

function jsonlBytes(records: TrajectoryStep[]): Buffer {
  if (!records.length) return Buffer.alloc(0);
  return Buffer.from(records.map((record) => pyJsonDumps(record)).join("\n") + "\n", "utf-8");
}

/**
 * Python `json.dumps(obj, ensure_ascii=False)` — default separators `", "` and
 * `": "`, insertion order preserved, `undefined` written as `null` (a Python
 * `dict.get` miss is `None`, not an absent key).
 */
function pyJsonDumps(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map((item) => pyJsonDumps(item)).join(", ") + "]";
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => JSON.stringify(String(key)) + ": " + pyJsonDumps(item),
    );
    return "{" + parts.join(", ") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

// ----------------------------------------------------------------------------
// Small Python shims
// ----------------------------------------------------------------------------

function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function zeroPad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function newOsError(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = "EPERM";
  return error;
}
