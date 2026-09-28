# Where the calls live

Two paths: a command-line tool that already covers developer workflows, and the SDKs for product
code. Pick the first when it fits; writing an SDK client for something `jev-axi diff` already does
is wasted work.

## Path 1: the jev-axi CLI

Covers log triage, diff and commit review, ranking and filtering files or items, semantic search in
a file, screening untrusted text, agent safety hooks, guarded shell commands, git hooks, and a
GitHub Action for pull requests and CI. Team-specific question sets live in `.jev-axi/recipes/*.yaml`
and run with `jev-axi recipe run <name>`.

Use the reviewed fork build and launcher, not a registry installation. See
`docs/OPENCODE_ZEN.md` in the fork root for backend selection, credential setup, and launcher
instructions. After the user has set up that launcher:

```sh
jev-axi                       # status and command list
npm test 2>&1 | jev-axi triage
jev-axi recipe new release-risk --project
```

If the jev-axi skill is installed, its `references/repo-setup.md` walks through every repository
integration. Otherwise `jev-axi <command> --help` documents each one.

## Path 2: the SDKs

JavaScript/TypeScript (`@typesafe-ai/sdk`, Node 20+):

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();            // reads TYPESAFE_API_KEY

const { answers } = await client.systemOne({
  state: { ticket: { subject, body }, order },   // string, object, or array of text
  model: "jev-1.13.0",                           // pin when thresholds are tuned
  questions: {
    department: choice("Which team should handle this ticket?", {
      billing: "Charges, invoices, refunds",
      technical: "The product is broken or erroring",
      other: "None of the above",
    }),
    urgent: noul("Is the customer blocked right now, with no workaround?"),
    frustration: score("How upset does the customer sound?", [
      "Neutral or friendly",
      "Mildly annoyed but civil",
      "Angry, threatening to leave",
    ]),
  },
});

if (answers.department.confidence >= 0.6) route(answers.department.choice);
if (answers.urgent.noul >= 0.75) page();
```

Python (`typesafe-sdk`, 3.10+) mirrors this with `TypeSafeClient` / `AsyncTypeSafeClient`, the
`Choice`, `Score`, `Noul`, and `NoulCriteria` types, and `result.nouls` / `.choices` / `.scores`.
Environment variables for both: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`,
`TYPESAFE_LOG_LEVEL`. There is also a Vercel AI SDK provider (`@ai-sdk/typesafe-ai`), the AI
Gateway model `typesafe-ai/jev`, and community clients for Rust, Go, Ruby, Elixir, .NET, PHP, and
Scala.

Check the current signatures in the installed package's README or the docs before writing code;
the shapes above are from `@typesafe-ai/sdk` 0.6.0.

## Integration points, and what each demands

| Point | Fits when | Watch |
| --- | --- | --- |
| **Sync request path** (before/after an LLM call, on submit, on fetch) | one call of ~0.1 to 0.5 s is acceptable | Set a timeout below your own budget and decide what a timeout means |
| **Queue or webhook worker** | the item can wait seconds | Bounded concurrency, retries, idempotency |
| **Batch job** | labeling, backfills, audits | Checkpoint progress; 8 to 16 workers, not 100 |
| **CI step** | per-commit or per-PR checks | Fail open on API errors unless the check is the point |
| **Agent hook** | before a tool call, after a tool result | Keep well inside the harness timeout; decide routine cases locally |
| **Client-side UI** | live judgments as the user types | Keep the key server-side; debounce; cache per input |

## Operational rules worth writing into the first version

- **Batch every question about the same state into one request.** This is the single biggest cost
  and latency lever.
- **Pin the model version** (`jev-1.13.0`, not `jev-latest`) once thresholds are tuned, and log
  `response.model` so a change is visible.
- **Bound concurrency.** The public endpoint rate-limits above roughly 8 workers in one cookbook;
  100 simultaneous requests produced 529s where 16 ran fine. Use the SDK's retries.
- **Cache on a hash of (model version, state, questions)** and invalidate when the version moves.
- **Decide the failure policy explicitly** for timeouts, 5xx, malformed answers, and a missing key:
  fail open (routers, most hooks) or fail closed (destructive actions, high-risk gates). Write it
  down; "a 200 is not an answer", so validate the response shape too.
- **Log every decision** with state reference, question version, probabilities, threshold, and the
  action taken. Jev gives no rationale, so this log is your audit trail and your future eval set.
- **Redact secrets and PII before sending**, and keep questions and thresholds in one reviewed file.
- **Never let an answer become executable**: map typed answers to pre-enumerated, validated actions,
  never to selectors, SQL, or shell.
- **Deterministic rules first.** Hard allows and hard denies belong in code; send the ambiguous
  middle to Jev.
