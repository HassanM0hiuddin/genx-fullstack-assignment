# Full Stack Assignment

This repo has both parts of the assignment:

| Folder | Task | Answers |
| --- | --- | --- |
| [`fastapi-webhook-assessment/`](fastapi-webhook-assessment) | Python backend: webhook ingestion under burst load, idempotency, retries | [DECISIONS.md](fastapi-webhook-assessment/DECISIONS.md) |
| [`nextjs-stream-assessment/`](nextjs-stream-assessment) | React / Next.js frontend: stream cancellation, URL filters, render isolation | [DECISIONS.md](nextjs-stream-assessment/DECISIONS.md) |

The first commit is the original starter code from the zip files, and the second commit is my solution, so `git diff` between them shows exactly what changed.

## Running the backend

```bash
cd fastapi-webhook-assessment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest -v -s
```

Python 3.11 to 3.13 works. (3.15 is too new, some dependencies don't have wheels for it yet.)

## Running the frontend

```bash
cd nextjs-stream-assessment
npm install
npm run dev
```

Then open http://localhost:3000. Small render counters are shown on the filter bar, event list, drawer and summary, so you can see that streaming only re-renders the summary.

## CI

GitHub Actions runs the backend tests and the frontend type check and build on Linux on every push. See the Actions tab.
