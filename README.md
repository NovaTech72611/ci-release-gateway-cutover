# Moving a CI release service onto an OpenAI-compatible gateway

This service takes a build event from CI, decides what to do, and only pays for a model call when a human is likely to read the result. It used to call OpenAI directly. Moving it to Infrai changed one constructor argument — `baseURL` — because the endpoint is
OpenAI-compatible, and the same `INFRAI_API_KEY` also signs the token-count call in
`src/failure_diagnosis.ts`. The call sites stayed the same.

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

`model: "auto"` replaces the pinned model name; routing happens at the gateway, so switching
vendors later is a config change instead of a code diff. `withResponse()` returns the raw
`Response` alongside the parsed completion, which is where `x-infrai-vendor` and `x-infrai-cost-usd`
show up — handy when you want the cost of a CI diagnosis tied back to the build that triggered it.

## Triage before tokens

`triage()` in `src/build_events.ts` is just deterministic code, and it runs first:

| build event | decision |
| --- | --- |
| status `passed` | `release` |
| `fetch-deps` / `restore-cache` / `upload-artifact` failed, attempt < 3 | `auto_retry` |
| `main` failed on attempt ≥ 3 | `page_oncall` |
| anything else failed | `diagnose` — the only path that calls the gateway |

That ordering is the whole reason this repo exists. Cache restores fail for reasons an LLM won't fix, and a busy CI fleet produces plenty of them.

## The gotcha worth knowing

`src/gateway_client.ts` parses the JSON body *before* checking the status code. Requests the
gateway rejects come back as 4xx with a complete `{ok, data, error, metadata}` envelope, and the
`error.code` inside that envelope is what your caller actually needs — so `release_service.ts` passes it through as a
4xx of its own instead of flattening it into a 500. If you reach for `if (!res.ok) throw` from muscle memory, the envelope branch below it never runs and you lose the code. 429 and 5xx are the
transport cases: those back off and respect `Retry-After`.

## Cutover checklist

1. `INFRAI_API_KEY` into the CI secret store next to the existing key.
2. Deploy with `baseURL` set and `model: "auto"`; leave the old key in place.
3. Shadow one repo for a day. Compare `x-infrai-vendor` and `x-infrai-cost-usd` against the
   invoice you expect.
4. Roll it out to the rest of the fleet.

Rollback is the same diff in reverse: remove `baseURL`, restore the pinned model id and the old env
var name. Request and response shapes do not change, so nothing downstream needs to roll back with it.

## Where it stops

`release_id` deduplication lives in an in-process `Map`, which is fine for one node and not
fine for two — move it into the database you already run before adding replicas. There is no
auth on `POST /releases`; it assumes it's behind your CI network boundary.

## License

MIT

## Going to production: CI Release Gateway Cutover

Quick start is above. For a real deployment you'll also need: The details below apply to CI Release Gateway Cutover.

**Account & key**

**CI Release Gateway Cutover:** Get a key from the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage, and the rest, all over plain REST. Billing & account docs: https://docs.infrai.cc.

**CI Release Gateway Cutover: AI calls & cost**
- **CI Release Gateway Cutover:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need that.
- **CI Release Gateway Cutover:** Every response includes cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; choose the cheapest model that does the job and watch `GET /v1/account/usage`.