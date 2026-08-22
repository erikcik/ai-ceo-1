// Ported 1:1 from LongHorizon-Harness src/lh_harness/webapi/models.py
//
// Small typed models for the public Web protocol.

export type EventEnvelopeDict = {
  schema_version: number;
  event_id: string;
  type: string;
  ts: number;
  run_id: string;
  round: number | null;
  role: string | null;
  status: string | null;
  payload: Record<string, unknown>;
  legacy: Record<string, unknown>;
  offset?: number;
};

/** Frozen dataclass equivalent: the public event envelope. */
export class EventEnvelope {
  readonly schema_version: number;
  readonly event_id: string;
  readonly type: string;
  readonly ts: number;
  readonly run_id: string;
  readonly round: number | null;
  readonly role: string | null;
  readonly status: string | null;
  readonly payload: Record<string, unknown>;
  readonly legacy: Record<string, unknown>;
  readonly offset: number | null;

  constructor(init: {
    schema_version: number;
    event_id: string;
    type: string;
    ts: number;
    run_id: string;
    round?: number | null;
    role?: string | null;
    status?: string | null;
    payload?: Record<string, unknown>;
    legacy?: Record<string, unknown>;
    offset?: number | null;
  }) {
    this.schema_version = init.schema_version;
    this.event_id = init.event_id;
    this.type = init.type;
    this.ts = init.ts;
    this.run_id = init.run_id;
    this.round = init.round ?? null;
    this.role = init.role ?? null;
    this.status = init.status ?? null;
    this.payload = init.payload ?? {};
    this.legacy = init.legacy ?? {};
    this.offset = init.offset ?? null;
    Object.freeze(this);
  }

  toDict(): EventEnvelopeDict {
    const data: EventEnvelopeDict = {
      schema_version: this.schema_version,
      event_id: this.event_id,
      type: this.type,
      ts: this.ts,
      run_id: this.run_id,
      round: this.round,
      role: this.role,
      status: this.status,
      payload: this.payload,
      legacy: this.legacy,
    };
    if (this.offset !== null) {
      data.offset = this.offset;
    }
    return data;
  }
}
