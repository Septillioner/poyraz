# Evals

The eval harness is **not** part of the npm package. It ships only in the git repository so you (or contributors) can measure agent behavior across models and scenarios.

## When to use it

- Compare models on the same coding/tooling scenarios.
- Regression-check prompt or policy changes before you ship a host app.

If you only need to run agents in production, you can ignore this page.

## Setup

1. Clone the Poyraz repository.
2. Install dependencies and set provider keys (`OPENAI_API_KEY`, etc., or `~/.poyraz/.env`).
3. From the repo root:

```bash
npm run eval -- --model gpt-4o-mini
npm run eval -- --model gpt-4o --difficulty easy
npm run eval -- --scenario <scenario-id>
npm run eval -- --all
```

| Arg | Meaning |
|-----|---------|
| `--model <id>` | Model to evaluate (repeatable) |
| `--all` | Built-in short model list |
| `--scenario <id>` | Run one scenario (repeatable) |
| `--difficulty <tier>` | `easy` \| `medium` \| `hard` \| `challenging` |

Default model if omitted: `EVAL_MODEL` or `gpt-4o-mini`.

Also available: `npm run eval:compare`, `npm run eval:visualize`.

## Scores

Each scenario reports `traceScore`, `outcomeScore`, `efficiencyScore`, a `composite` score, and `passed` (composite ≥ threshold). Results and history are written under `evals/results/` and `evals/history/` in the clone.

To extend the scenario bank, open a PR against the repository.
