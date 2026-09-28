# Reading jev-axi results

## Output and bands

Output is compact key-value text. Add `--json` when you need to parse it.

| Signal | Meaning | What to do |
| --- | --- | --- |
| `band: act` | confidence 0.75 or higher | Rely on the answer. |
| `band: confirm` | 0.45 to 0.75 | Plausible; verify cheaply (open the file, read the lines) before acting. |
| `band: escalate` | below 0.45 | Don't rely on it. Read the material yourself or ask the user. |
| `*_exists` below ~0.35 | nothing in the input really matches | The ranking is only the least bad option; widen the search. |
| `usage: ... cached` | an identical request for the selected backend and model was answered within the default 24-hour TTL | No model call. A cold cache needs a provider call; `cacheTtlHours` changes the TTL and 0 disables it. Zen still requires a credential for a hit. |

For yes/no answers, confidence is the distance from 0.5: a `p_yes` of 0.05 is a confident no.

## Errors and exit codes

Errors print `error:` and `code:` with a `help:` hint on stdout. Exit code 2 means a usage mistake:
fix the flags as the hint says. Commands that need input and get none say which flag or path to
pass. Exit code 1 means an API problem: for `RATE_LIMITED` or `NETWORK`, retry once, then continue
without jev-axi. `AUTH_REQUIRED` means no valid key: skip jev-axi for the rest of the
task and tell the user which selected backend lacks or rejected its credential, without printing
the credential. A local `--check-backend` cannot validate a key remotely. `guard` exits 3 on block;
`progress` exits 3 on any verdict other than `finish`.

## Limits

- One request holds about 32k tokens of input. `files`, `rank`, `filter`, `find`, and `diff` split
  larger inputs automatically; `check`, `pick`, `rate`, `ask`, and `guard` reject oversized input,
  so trim it or use `find` on the relevant file instead.
- `triage` reads the last 255 lines; `diff` reads the first 6000 characters of each file's patch.
- A choice question accepts at most 255 options.
