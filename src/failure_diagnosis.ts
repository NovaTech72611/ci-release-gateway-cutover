import { ai, callGateway } from "./gateway_client.ts";
import type { BuildEvent } from "./build_events.ts";

/** Keeps a runaway log tail out of the prompt before we spend a call on it. */
export async function countTokens(input: string): Promise<number> {
  const data = await callGateway<{ tokens?: number; count?: number }>(
    "/ai/tokens/count",
    { model: "auto", messages: [{ role: "user", content: input }] },
  );
  return data.tokens ?? data.count ?? 0;
}

export type Diagnosis = {
  build_id: string;
  log_tokens: number;
  summary: string;
  vendor: string | null;
  cost_usd: string | null;
};

const MAX_LOG_TOKENS = 4000;

export async function diagnose(event: BuildEvent): Promise<Diagnosis> {
  const logTokens = await countTokens(event.log_tail);
  const logTail = logTokens > MAX_LOG_TOKENS
    ? event.log_tail.slice(-8000)
    : event.log_tail;

  const { data: completion, response } = await ai.chat.completions.create({
    model: "auto",
    messages: [
      {
        role: "system",
        content:
          "You read CI logs. Answer in at most three sentences: the failing step, the likely cause, the next command to run.",
      },
      {
        role: "user",
        content: `repo=${event.repo} branch=${event.branch} step=${event.failed_step ?? "unknown"}\n---\n${logTail}`,
      },
    ],
  }).withResponse();

  return {
    build_id: event.build_id,
    log_tokens: logTokens,
    summary: completion.choices[0]?.message?.content ?? "",
    vendor: response.headers.get("x-infrai-vendor"),
    cost_usd: response.headers.get("x-infrai-cost-usd"),
  };
}
