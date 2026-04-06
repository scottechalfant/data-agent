# Running the RTIC Data Agent Locally

## Prerequisites

- **Python 3.12+** — must be a non-Anaconda install (`/usr/local/bin/python3` works on macOS)
- **Node.js 20+** and npm
- **GCP access** — Application Default Credentials with BigQuery and Vertex AI permissions
- **GCS bucket** — `gs://velky-brands-data-agent` must exist with a `knowledge/` folder containing at least `datamodel.md`

## 1. GCP Authentication

The app needs ADC (Application Default Credentials) to access BigQuery, Vertex AI (Gemini), and GCS.

```bash
gcloud auth application-default login --scopes=\
https://www.googleapis.com/auth/cloud-platform,\
https://www.googleapis.com/auth/bigquery
```

This writes credentials to `~/.config/gcloud/application_default_credentials.json`.

**Important:** If you have a `GOOGLE_APPLICATION_CREDENTIALS` environment variable set in your shell profile (e.g. pointing to another project's service account), it will override ADC. The backend `.env` file handles this — see step 3.

## 2. Enable the Vertex AI API (one-time)

```bash
gcloud services enable aiplatform.googleapis.com --project=velky-brands
```

## 3. Backend Setup

```bash
cd backend

# Create a virtual env using non-Anaconda Python
/usr/local/bin/python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create your .env file
cp .env.example .env
```

Edit `.env` and set:

```
GOOGLE_CLOUD_PROJECT=velky-brands
GEMINI_MODEL=gemini-2.5-pro
BQ_MAX_ROWS=5000
BQ_MAX_BYTES_BILLED=107374182400

GCS_BUCKET=velky-brands-data-agent

SLACK_WEBHOOK_URL=                # leave empty to skip Slack notifications
SLACK_CHANNEL=#data-insights

GOOGLE_APPLICATION_CREDENTIALS=/Users/<you>/.config/gcloud/application_default_credentials.json
```

The `GOOGLE_APPLICATION_CREDENTIALS` line is critical — it overrides any conflicting credentials in your shell environment.

### Start the backend

```bash
source .venv/bin/activate
uvicorn app.main:app --reload --port 8080
```

On startup you'll see logs for:
- Loading knowledge files from GCS
- Loading memories from GCS
- Summarizing knowledge files with Gemini (takes a few seconds per file)

Verify it's running:

```bash
curl http://localhost:8080/health
```

You should see `{"status":"ok","knowledge":[...]}` with your knowledge files listed.

## 4. Frontend Setup

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

Vite starts at `http://localhost:5173` and proxies all `/api/*` requests to `localhost:8080`.

## 5. Use the App

Open **http://localhost:5173** in your browser. You should see the RTIC Data Agent chat interface.

Try a question like:
- "What were total D2C sales last week?"
- "Show me the top 10 products by revenue this month"
- "What items are below safety stock?"

Each response includes a **"Show logic"** link that expands to show the step-by-step execution trace, including SQL queries.

## Project Structure

```
agent/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, startup tasks
│   │   ├── config.py            # Settings from .env
│   │   ├── agent/
│   │   │   ├── core.py          # Agent loop (Gemini + tool calling)
│   │   │   ├── tools.py         # BQ tools, knowledge, charts, memory
│   │   │   ├── prompts.py       # System prompt + scheduled prompts
│   │   │   ├── knowledge.py     # GCS knowledge loading + summarization
│   │   │   └── types.py         # Data classes
│   │   ├── api/
│   │   │   ├── chat.py          # POST /api/chat
│   │   │   └── scheduled.py     # POST /api/scheduled/*
│   │   └── services/
│   │       ├── storage.py       # GCS conversation/report persistence
│   │       └── slack.py         # Slack webhook notifications
│   ├── knowledge/               # Local copy of knowledge docs (source of truth is GCS)
│   ├── .env                     # Local config (not committed)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Tab layout (Chat / Reports)
│   │   ├── components/
│   │   │   ├── MessageList.tsx   # Chat messages with markdown rendering
│   │   │   ├── ChatInput.tsx     # Input box
│   │   │   ├── DataTable.tsx     # Auto-formatted data tables
│   │   │   ├── Chart.tsx         # Recharts visualizations
│   │   │   ├── LogicPanel.tsx    # Expandable step-by-step execution trace
│   │   │   └── TrendReports.tsx  # Scheduled report viewer
│   │   ├── hooks/useChat.ts     # Chat state + API calls
│   │   ├── types/api.ts         # TypeScript interfaces
│   │   └── utils/format.ts      # Number/currency/column formatting
│   └── vite.config.ts           # Dev server + API proxy
├── deploy/
│   └── setup-scheduler.sh       # Cloud Scheduler setup
├── Dockerfile                   # Multi-stage build (frontend + backend)
├── DEPLOY.md                    # Production deployment guide
└── LOCAL_DEV.md                 # This file
```

## How the Agent Works

1. **Startup** — Loads knowledge docs from GCS, loads memories from GCS, uses Gemini to summarize each knowledge file into a concise index.

2. **Per request** — The agent follows a 4-step workflow:
   - **Research** — Reads knowledge file summaries, loads relevant docs via `read_knowledge_file`
   - **Query** — Writes and executes SQL against BigQuery via `run_query`
   - **Analyze** — Interprets results, computes derived metrics
   - **Respond** — Returns text, tables, and/or charts; optionally saves memories

3. **System prompt** — Built from `prompts.py` + knowledge file summaries + memories. All three are concatenated and sent as the Gemini system instruction on every request.

4. **Conversation state** — Stored as JSON files in GCS (`gs://velky-brands-data-agent/conversations/`). Multi-turn conversations maintain full Gemini history.

## Troubleshooting

| Problem | Fix |
|---|---|
| `ModuleNotFoundError: No module named 'fastapi'` | You're not in the venv. Run `source .venv/bin/activate` |
| `google.auth.exceptions.DefaultCredentialsError` | Check that `GOOGLE_APPLICATION_CREDENTIALS` in `.env` points to a valid ADC file |
| `The file ... does not have a valid type` | Your shell's `GOOGLE_APPLICATION_CREDENTIALS` is overriding `.env`. The `.env` file should fix this — restart uvicorn |
| `venv` creation fails with Anaconda errors | Use `/usr/local/bin/python3` explicitly instead of `python3` |
| Frontend shows `{"detail":"Not Found"}` at localhost:8080 | That's expected — the frontend runs on Vite at `localhost:5173`, not directly on the backend port |
| Gemini model not found | Run `gcloud services enable aiplatform.googleapis.com --project=velky-brands` |
| GCS bucket not found | Run `gsutil mb -l us-central1 gs://velky-brands-data-agent` |
| Startup is slow | Knowledge summarization calls Gemini once per file. This only happens on cold start. |

## Testing Without the UI

```bash
# Health check
curl http://localhost:8080/health

# Send a chat message
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What were total D2C sales yesterday?"}'

# Continue a conversation (use the conversation_id from the previous response)
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Break that down by channel", "conversation_id": "YOUR_ID_HERE"}'
```
