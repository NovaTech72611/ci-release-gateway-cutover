import { createServer } from "node:http";
import { ReleaseRequest, triage } from "./build_events.ts";
import { diagnose } from "./failure_diagnosis.ts";
import { GatewayError } from "./gateway_client.ts";

/** release_id -> stored outcome, so a replayed publish returns the first result. */
const applied = new Map<string, unknown>();

async function handle(body: unknown) {
  const parsed = ReleaseRequest.safeParse(body);
  if (!parsed.success) {
    return { status: 400, payload: { error: "INVALID_BODY", issues: parsed.error.issues } };
  }
  const req = parsed.data;

  const seen = applied.get(req.release_id);
  if (seen) return { status: 200, payload: seen };

  const decision = triage(req.event);
  const result: Record<string, unknown> = {
    release_id: req.release_id,
    repo: req.repo,
    version: req.version,
    ...decision,
  };

  if (decision.action === "diagnose") {
    result.diagnosis = await diagnose(req.event);
  }

  applied.set(req.release_id, result);
  return { status: 200, payload: result };
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/releases") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    try {
      const parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const { status, payload } = await handle(parsedBody);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      // A rejected request stays a client error for our caller, with the code intact.
      if (err instanceof GatewayError) {
        const status = err.status >= 400 && err.status < 500 ? err.status : 502;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.code, message: err.message }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "BAD_REQUEST", message: String(err) }));
    }
  });
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`release service on http://127.0.0.1:${port}/releases`);
});

export { handle };
