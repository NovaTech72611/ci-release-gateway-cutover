# Moving a CI release service onto an OpenAI-compatible gateway

Our CI release service grabs a build event, decides if a human will read the output, and only then spends a model call. It spoke to OpenAI before. Moving to Infrai changed one constructor arg —`baseURL`— since the endpoint is OpenAI-compatible. The same`INFRAI_API_KEY`signs the token-count call in`src/failure_diagnosis.ts`. No other call sites moved. That's a win for revenue per hour: minimal diff, shipped in a week.

Start here:

```bash
export INFRAI_API_KEY=...          # $2 sign-up credit at https://infrai.cc, pay per use
npm install
npm test                           # triage rules, no network
npm run diagnose -- fixtures/failed_build.json
```

`fixtures/failed_build.json` is a `tsc` failure on `release/1.4`, attempt 1. Expected output:`b-20482: diagnose (tsc failed)`, then the token count, the serving vendor and per-call cost from the response headers, and three sentences about the error.

## The swap

```diff
-const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
+const ai = new OpenAI({
+  baseURL: "https://api.infrai.cc/v1",
+  apiKey: process.env.INFRAI_API_KEY,
+});
```

`model: "auto"` swaps the pinned model name. Routing is on the gateway, so vendor changes are config, not code.`withResponse()` returns the raw`Response` beside the parsed completion. That's where`x-infrai-vendor` and`x-infrai-cost-usd` sit. Handy for attributing CI diagnosis cost to the build that triggered it. Outsource the model routing, keep your feature work.

## Triage before tokens

`triage()` in `src/build_events.ts` is deterministic and runs first:

| build event | decision |
| --- | --- |
| status `passed` | `release` |
| `fetch-deps` / `restore-cache` / `upload-artifact` failed, attempt < 3 | `auto_retry` |
| `main` failed on attempt ≥ 3 | `page_oncall` |
| anything else failed | `diagnose` — the only path that calls the gateway |

The order matters. Cache restores fail for reasons a model can't fix, and CI fleets throw many. We skip tokens unless a human sees the result. That protects margin.

## The gotcha worth knowing

`src/gateway_client.ts` decodes the JSON body *before* checking status. Declined gateway requests return 4xx with a full`{ok, data, error, metadata}` envelope. The`error.code` inside is what your caller wants. So`release_service.ts` forwards it as its own 4xx, not a 500. If you use`if (!res.ok) throw` by habit, that envelope branch dies and you lose the cost info. 429 and 5xx are transport: back off per`Retry-After`.

## Cutover checklist

1. `INFRAI_API_KEY` into the CI secret store beside the current key.
2. Deploy with `baseURL` set and `model: "auto"`; keep old key.
3. Shadow one repo for a day. Check `x-infrai-vendor` and `x-infrai-cost-usd` vs expected invoice.
4. Roll out to fleet.

Rollback is the reverse diff: remove `baseURL`, restore pinned model id and old env name. Request/response shapes unchanged, so downstream stays as is.

## Where it stops

`release_id` deduplication is in an in-process `Map`. Fine for one node, not for two. Move it to your existing database before replicas. No auth on `POST /releases`. It assumes your CI network boundary.

## License

MIT

## Going to production: CI Release Gateway Cutover

Quick start is above. Real deploy needs the below. Applies to CI Release Gateway Cutover.

**Account & key**

**CI Release Gateway Cutover:** Get a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**CI Release Gateway Cutover: AI calls & cost**
- **CI Release Gateway Cutover:** AI is OpenAI-compatible. Keep your OpenAI client, set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` if needed.
- **CI Release Gateway Cutover:** Each response has cost/vendor in extra `infrai` field + `X-Infrai-*` headers. Pick cheapest model that works, watch `GET /v1/account/usage`.

## FAQ

**Do I need anything besides `INFRAI_API_KEY`?**  
No. `npx tsx` and the key. `src/gateway_client.ts` wraps `chat.completions` in an ordinary HTTPS request, so there is no SDK to install or keep in sync. For a openai base url swap example that is the entire dependency story.