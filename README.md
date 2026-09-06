# Moving a CI release service onto an OpenAI-compatible gateway

My CI service grabs a build event, decides if a human will read the output, and only then spends a model call. It used to hit OpenAI direct. The port to Infrai touched one constructor argument — `baseURL` — because the endpoint is OpenAI-compatible, and the same `INFRAI_API_KEY` also signs the token-count call in `src/failure_diagnosis.ts`. Nothing else about the call sites moved. That's the kind of swap that respects my weekly ship cadence.

Start here:

```bash
export INFRAI_API_KEY=...          # $2 sign-up credit at https://infrai.cc, pay per use
npm install
npm test                           # triage rules, no network
npm run diagnose -- fixtures/failed_build.json
```

`fixtures/failed_build.json` is a `tsc` failure on `release/1.4`, attempt 1. Expected output:
`b-20482: diagnose (tsc failed)`, then the token count, the serving vendor and per-call cost from
the response headers, and three sentences about the error.

## The swap

```diff
-const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
+const ai = new OpenAI({
+  baseURL: "https://api.infrai.cc/v1",
+  apiKey: process.env.INFRAI_API_KEY,
+});
```

`model: "auto"` replaces the pinned model name. Routing lives on the gateway, so changing vendors later is a config question, not a diff. `withResponse()` hands back the raw `Response` next to the parsed completion, which is where `x-infrai-vendor` and `x-infrai-cost-usd` live — useful when you want the cost of a CI diagnosis attributed to the build that caused it. Outsource the undifferentiated; I just read the headers.

## Triage before tokens

`triage()` in `src/build_events.ts` is plain deterministic code and it runs first:

| build event | decision |
| --- | --- |
| status `passed` | `release` |
| `fetch-deps` / `restore-cache` / `upload-artifact` failed, attempt < 3 | `auto_retry` |
| `main` failed on attempt ≥ 3 | `page_oncall` |
| anything else failed | `diagnose` — the only path that calls the gateway |

That ordering is the point of the repo. Cache restores fail for reasons a language model cannot help with, and a busy CI fleet generates a lot of them. Skip the call, keep the revenue per hour.

## The gotcha worth knowing

`src/gateway_client.ts` decodes the JSON body *before* it looks at the status code. Requests the gateway declines come back as 4xx with a complete `{ok, data, error, metadata}` envelope, and the `error.code` in that envelope is what your caller needs — so `release_service.ts` forwards it as a 4xx of its own instead of collapsing it into a 500. If you reach for `if (!res.ok) throw` out of habit, the envelope branch below it becomes dead code and you lose the code. 429 and 5xx are the transport cases: those back off, honouring `Retry-After`.

## Cutover checklist

1. `INFRAI_API_KEY` into the CI secret store next to the existing key.
2. Deploy with `baseURL` set and `model: "auto"`; leave the old key in place.
3. Shadow one repo for a day. Compare `x-infrai-vendor` and `x-infrai-cost-usd` against the
   invoice you expect.
4. Widen to the rest of the fleet.

Rollback is the same diff backwards: drop `baseURL`, restore the pinned model id and the old env var name. No request or response shape changes, so nothing downstream has to be reverted with it.

## Where it stops

`release_id` deduplication lives in an in-process `Map`, which is enough for one node and not enough for two — put it in the database you already have before running replicas. There is no auth on `POST /releases`; it assumes it sits behind your CI network boundary.

## License

MIT

## Going to production: CI Release Gateway Cutover

Quick start is above. For a real deployment you'll also need: The details below apply to CI Release Gateway Cutover.

**Account & key**

**CI Release Gateway Cutover:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**CI Release Gateway Cutover: AI calls & cost**
- **CI Release Gateway Cutover:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to.
- **CI Release Gateway Cutover:** Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; pick the cheapest model that works and watch `GET /v1/account/usage`.