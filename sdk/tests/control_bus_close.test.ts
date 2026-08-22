// Ported 1:1 from LongHorizon-Harness tests/test_control_bus_close.py
//
// Descriptor-close robustness for control-bus readers.
//
// These tests cover recovery from an *isolated* stolen-descriptor ``EBADF``
// (a stray double-close elsewhere in the process recycling the reader's fd
// number between open and close).  They are defense in depth around the
// root-cause fix for the dashboard walker double-close, not a substitute for
// it: only ``EBADF`` is tolerated, every other error must propagate.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { controlBusHooks, readJsonFile, readJsonl } from "../src/supervisor/control_bus.js";

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-bus-")));
}

function oserror(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Route the reader's own close through ``closeError``, keep others real. */
function readerCloseHarness(closeError: NodeJS.ErrnoException | null) {
  const realOpen = controlBusHooks.openNofollow;
  const realClose = controlBusHooks.closeSync;
  const readerFd: { fd: number } = { fd: -1 };
  const failed: number[] = [];

  controlBusHooks.openNofollow = (target, options) => {
    const fd = realOpen(target, options);
    readerFd.fd = fd;
    return fd;
  };
  controlBusHooks.closeSync = (fd) => {
    realClose(fd);
    if (fd === readerFd.fd && closeError !== null) {
      failed.push(fd);
      throw closeError;
    }
  };
  return {
    failed,
    undo: () => {
      controlBusHooks.openNofollow = realOpen;
      controlBusHooks.closeSync = realClose;
    },
  };
}

test("read_json_file survives EBADF on close", () => {
  // The watcher task that calls this helper runs for the whole run, so the
  // failure has to degrade gracefully instead of storing an exception that
  // resurfaces at shutdown as the process exit status.
  const payload = { requested_action: "stop" };
  const target = path.join(tmpDir(), "status.json");
  fs.writeFileSync(target, JSON.stringify(payload), "utf-8");

  const harness = readerCloseHarness(oserror("EBADF", "Bad file descriptor"));
  let result: Record<string, unknown>;
  try {
    result = readJsonFile(target);
  } finally {
    harness.undo();
  }

  assert.ok(harness.failed.length, "the reader must still attempt to close its descriptor");
  assert.deepEqual(result, payload);
});

test("read_json_file propagates non-EBADF close errors", () => {
  // Swallowing e.g. EIO here would silently turn permission or filesystem
  // failures into an empty control status and legitimate stop/abort requests
  // could be ignored for the rest of the run.
  const target = path.join(tmpDir(), "status.json");
  fs.writeFileSync(target, JSON.stringify({ requested_action: "stop" }), "utf-8");

  const harness = readerCloseHarness(oserror("EIO", "Input/output error"));
  try {
    assert.throws(
      () => readJsonFile(target),
      (error: NodeJS.ErrnoException) => error.code === "EIO",
    );
  } finally {
    harness.undo();
  }
  assert.ok(harness.failed.length);
});

test("read_jsonl propagates non-EBADF close errors", () => {
  const target = path.join(tmpDir(), "control.jsonl");
  fs.writeFileSync(target, `${JSON.stringify({ event: "noop" })}\n`, "utf-8");

  const harness = readerCloseHarness(oserror("EIO", "Input/output error"));
  try {
    assert.throws(
      () => readJsonl(target),
      (error: NodeJS.ErrnoException) => error.code === "EIO",
    );
  } finally {
    harness.undo();
  }
  assert.ok(harness.failed.length);
});

test("read_jsonl survives EBADF on close", () => {
  const record = { event: "noop" };
  const target = path.join(tmpDir(), "control.jsonl");
  fs.writeFileSync(target, `${JSON.stringify(record)}\n`, "utf-8");

  const harness = readerCloseHarness(oserror("EBADF", "Bad file descriptor"));
  let result: Record<string, unknown>[];
  try {
    result = readJsonl(target);
  } finally {
    harness.undo();
  }

  assert.ok(harness.failed.length);
  assert.deepEqual(result, [record]);
});
