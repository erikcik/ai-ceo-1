// Ported 1:1 from LongHorizon-Harness src/lh_harness/adapters/base.py
/**
 * The whole adapter interface: one method, four arguments. There is no
 * `AgentRunRequest` record in the Python — the request *is* the argument list,
 * so the port keeps the positional shape.
 */
import type { Environment } from "../environment/base.js";
import type { EpisodeBudget, EpisodeResult } from "../types.js";

export interface AgentAdapter {
  runEpisode(
    prompt: string,
    env: Environment,
    budget: EpisodeBudget,
    liveTrajectoryPath?: string | null,
  ): Promise<EpisodeResult>;
}
