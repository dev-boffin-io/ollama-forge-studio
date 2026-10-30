# Ollama Forge Studio v1.0

An agentic coding studio for any Ollama endpoint (local or a Cloudflare tunnel URL).
Zero runtime dependencies — just Node 18+.

```
Browser ──HTTP/SSE──► server.js ──REST──► Ollama endpoint
                          │
                          └─ agent loop + tools ─► <the directory you launched it in>
                                   └─ sessions / agents / config ─► ~/.studio/<project>/  (in your HOME, not in the project)
```

## Where data is stored

Nothing is written into your project. All studio data lives in your home directory:

```
~/.studio/
└─ <project-name>-<hash>/        one folder per project directory (name + short hash of its full path)
   ├─ project.json               which directory this folder belongs to
   ├─ sessions/                  conversations (kept separate per project)
   ├─ uploads/  tool-output/  plans/  agents/  skills/  commands/
   ├─ snapshot.git/  recall.db  config.json
```

Set `OLLAMA_STUDIO_HOME` to use another root. Inside tool paths the agent still sees this folder as `.studio/…`
(e.g. `.studio/uploads/x.png`), which is mapped to the folder above.

## Run — works in whatever directory you open it

```bash
cd ~/my-project
node /path/to/ollama-forge-studio/server.js         # or: npm link  →  ollama-forge-studio  (alias: ollama-studio)
ollama-forge-studio ~/other/project                         # open a specific directory
ollama-forge-studio -c                                      # resume the most recent session in this dir
ollama-forge-studio -s ses_xxxxx --agent plan               # resume a specific session with an agent
ollama-forge-studio --port 5000                             # auto-picks the next free port if busy
```

The agent's file tools are confined to that directory (path traversal and symlink escapes are blocked).
Launching from the app's own folder falls back to `./workspace/` so the studio never edits itself.
You can also switch directory from the UI (click the path in the header).

## Single binary

Build one self-contained executable (Node's Single Executable Applications — no Node install or `node_modules`
needed on the target machine):

```bash
npm run build            # → dist/ollama-forge-studio  (dist/ollama-forge-studio.exe on Windows)
./dist/ollama-forge-studio ~/my-project
```

- Needs **Node ≥ 20.12** (22+ recommended) on the *build* machine; the binary embeds that Node runtime (~100 MB).
- It can't cross-compile: build on each OS/arch you target. `.github/workflows/release.yml` runs on **every commit** (any branch) and   on pull requests: first `npm run check` (syntax + module load) and `npm test`,
  then builds Linux, macOS and Windows binaries, kept as run artifacts for 30 days. Pushing a `v*` tag also attaches them to a GitHub release;
  it can be started manually from the Actions tab too.
- The UI (`public/*`) is embedded in the binary. Without a source tree, the global `config.json` is read/written at
  `~/.config/ollama-studio/config.json` (`$XDG_CONFIG_HOME` honoured) next to your global agents/commands/skills.
  Per-project data still lives in `~/.studio/<project>/`.
- `git` is still needed on PATH for snapshots/undo (as in source mode); the studio runs fine without it.

## Tests

```bash
npm test        # Node's built-in test runner (zero dependencies): unit tests + a real server boot smoke test
```

Covers the permission rule engine, fuzzy `edit_file` matching, path-safe workspace ops (incl. symlink escapes),
config layering, sessions (fork / archive / export), provider resolution and key masking, the XSS-safe markdown
renderer, attachment classification, skills, tool visibility per agent, and an end-to-end HTTP API check against a
live `server.js`. Every test file runs in its own process with a throwaway `OLLAMA_STUDIO_HOME` — nothing in your
real `~/.studio/` or `config.json` is touched.

## Attachments (any file type)

Use the **📎** button, drag & drop files onto the chat, or paste them (e.g. a screenshot) into the message box. Files are stored in
`~/.studio/<project>/uploads/` (so the agent can also open them with its tools) and, when you send, turned into something the *chosen model*
can use — with fallbacks when it can't read that kind of file:

| File | What the model gets |
|---|---|
| **Image** | a vision-capable model (Ollama `/api/show` says `vision`; OpenAI-type models are recognised by name) receives the image itself → else `visionModel` (config) describes it → else OCR via `tesseract` (English + Bengali if installed) → else size/dimensions + path and a note that it can't see it |
| Text / code / CSV / JSON … | inlined (capped to ~35 % of the context window; the rest stays readable via the path) |
| PDF | `pdftotext` if installed, else a built-in extractor (scanned PDFs without a text layer are reported as unreadable) |
| docx / xlsx / pptx / odt / ods / odp | text pulled out of the file (built in, no tools needed) |
| zip | listing of the archive |
| audio / video / other binary | metadata + path, with a hint to use shell tools (ffmpeg, whisper…) |

Config (`config.json`): `"visionModel": "provider/model"` (a vision model used only to describe images for text-only chat models),
`"vision": true|false` (override auto-detection), `"maxUploadMB": 500`, `"attachInlineChars": N` (inline text budget per message).
Chips under each message show how every file was handled (amber = the model could only get the path). Uploaded files are only ever
served back as downloads (images inline), never rendered as pages.

## Message menu

**Hold** a message (or **right-click** on desktop) → **Copy** (markdown source) · **Copy text** (plain text) · **Edit** · **Resend**.
- *Edit* on your message removes it and everything after it, then sends the edited text (attachments are kept). On a reply it
  edits the stored text in place.
- *Resend* / *Regenerate* re-runs the turn from that message. Files the agent changed in later turns are kept — use **Undo** for those.
- Messages that are still streaming have Edit/Resend disabled.

## Export, summaries and full history

- **`/export`** in the chat box downloads the whole session as Markdown (`/export json` for JSON, with sub-agent sessions).
  The same file is available at `GET /api/sessions/<id>/export?format=md|json`.
- Summarising (automatic or **Compact**) only changes what the *model* sees. Every message that is folded into a summary is
  kept verbatim in `~/.studio/<project>/sessions/<id>.archive.jsonl`, and tool outputs that get pruned keep their original text, so the
  export always contains the **complete** session (user turns, thinking, tool calls with full results, and each summary at the
  point where it was made). Forks inherit this history; deleting a session deletes its archive.
  (Sessions that were summarised *before* this feature cannot be restored — only what is still in the session file is exported.)
- **Summaries** button / **`/summaries`** opens every summary of the session (with date and how many messages it covers);
  the current summary is also shown in the chat as a collapsible "📝 Summary" card.
- Other built-ins: `/compact`. Custom commands still work as before.

## Long-term memory (history recall)

"Unlimited" context without an embedding model: every message (and tool output) is also indexed in a local
**SQLite FTS5** database, `~/.studio/<project>/recall.db` (BM25 keyword ranking; Bengali and English words are tokenised properly).
Compaction and pruning can drop text from the live context, but it stays searchable:

- **Automatic** – for each new user message the best 3 matching snippets that are *not* already visible
  (older sessions, or parts of this session that were summarised/pruned) are added to the system prompt, and the chat shows
  "🔎 recalled N earlier snippet(s)". Turn off with `"recallAuto": false` in `config.json`.
- **`recall` tool** – the model can search the whole project history itself (`query`, `limit`, `scope: project|session`).
  Hide it from an agent with `permission: { recall: deny }`.
- Deleting a session also deletes its index rows. Needs **Node ≥ 22.5** (built-in `node:sqlite`; the single binary includes it).
  On older Node the feature silently turns itself off.

Model "thinking" output is saved with the session and shown again when you reopen it, as a collapsible "💭 Thinking" block (never sent back to the model).

Assistant replies are rendered as markdown (headings, bold/italic, lists incl. Bengali numerals, tables, quotes, links, inline code and
syntax-coloured code blocks with a Copy button) by the dependency-free, XSS-safe `public/markdown.js`.

## Agents

| Agent     | Mode     | Access                                              |
|-----------|----------|-----------------------------------------------------|
| `build`   | primary  | Full access (default)                               |
| `plan`    | primary  | Read-only: analyse and produce a plan               |
| `general` | subagent | Multi-step delegated work, own child session        |
| `explore` | subagent | Read-only fast codebase search                      |

Switch primary agents from the dropdown in the chat header. Primary agents can delegate to subagents with the
`task` tool; every subagent run is stored as a child session (subagents cannot spawn subagents).

**Custom agents** are markdown files — `~/.studio/<project>/agents/<name>.md` (per project) or
`~/.config/ollama-studio/agents/<name>.md` (global). See `examples/agents/reviewer.md`:

```markdown
---
description: Reviews code
mode: all                # primary | subagent | all
model: llama3.1:8b       # optional per-agent model
temperature: 0.1
permission:
  edit: deny             # allow | ask | deny
  bash: deny
---
System prompt for the agent goes here.
```

Denied tools are hidden from the model and also blocked at execution time.

## Sessions

Every conversation is saved to `~/.studio/<project>/sessions/<id>.json` after **every step** (atomic writes), so an abort
or crash never loses work. Reopen the studio in the same directory and the sessions are there.

- Resume any session from the sidebar, or `-c` / `-s <id>` on the command line.
- **Fork** — branch a session to try another approach.
- **Compact** — prune old tool output and summarise old context (also happens automatically at ~75% of `numCtx`).
- Export with children: `GET /api/sessions/:id/export`.
- Interrupted tool calls are repaired on resume so history stays valid.

## Tools

`list_files`, `glob` (truncated results signal), `grep` (truncated results signal), `read_file` (line numbers, 5000-line / size cap, binary detection, "did you mean", array of paths), `move_file`, `write_file`, `edit_file` (dry_run), `multi_edit`, `json_edit`, `delete_file`, `bash`, `todo_write`, `task` (subagents, resumable with `task_id`),
`question` (ask you a question, with options), `plan_exit` (plan agent only), `webfetch`, `websearch`, `skill`, `lsp`,
and any MCP tools.

- **Fuzzy `edit_file`**: tolerates wrong indentation/whitespace, copied `12:` line-number prefixes and
  small drift in the middle of a block (anchor lines + similarity), with `replace_all` and a "matched span too big" guard.
  Results include a small diff.
- **Long output** (bash/grep) is saved to `~/.studio/<project>/tool-output/` and the model gets a preview + a hint to grep/read
  with offset (old files are pruned after 7 days). Limits scale with `numCtx`.

### Permissions

A flat rule list, **last matching rule wins**. In `config.json`, `~/.studio/<project>/config.json` or an agent's frontmatter:

```json
"permission": {
  "edit": "allow",
  "bash": { "*": "ask", "git status*": "allow", "npm test*": "allow", "rm *": "deny" },
  "read": { "*.env": "ask" },
  "task": { "general": "deny" }
}
```

- Compound commands (`a && b`, pipes) are checked **per segment**; redirects / `$(...)` are never auto-allowed.
- **Always** remembers the *shape* of the command (`git commit *`, `npm run *`), not blanket bash, and can
  never override a `deny`. `rm`, `sudo`, `curl`… are only remembered exactly.
- `.env` files ask before being read; subagents inherit their parent's edit denies.
- **doom-loop guard**: the same tool with identical input 3× in a row asks you before continuing.
- Tools an agent can never use are hidden from the model.

## Plan → Build workflow

`plan` is read-only (bash limited to a safe allowlist, edits only to `~/.studio/<project>/plans/*.md`) and ends with `plan_exit`,
which asks you to approve switching to `build`; the session then continues as `build` with a mode-switch reminder.

## Slash commands

`/init` (write AGENTS.md), `/review [commit|branch]`, and your own in `~/.studio/<project>/commands/<name>.md` or
`~/.config/ollama-studio/commands/` (`$ARGUMENTS`, `$1..$9`, `@path` inlines a file, optional `agent:`).
Type `/` in the prompt box for hints. See `examples/commands/test.md`.

## Undo / Redo

Before the first change to a file in a turn the previous content is journaled. **Undo** restores those files, removes
that turn's messages and puts your prompt back in the input; **Redo** re-applies it. (Changes made by `bash`
are not tracked.)

## Speed, stability and error handling

- **File tree is lazy**: the sidebar loads one folder at a time (`/api/tree?path=`); dependency/cache folders (`node_modules`, `.venv`,
  `site-packages`, …) are skipped by search and shown dimmed. glob/grep/list_files use a bounded, cached scan (6 s budget, 8 s cache).
- **Snapshots never freeze a message and are never switched off**: the first full scan of a huge folder runs in the background
  (started at boot / when you change folder) with no deadline; until it finishes, undo of file-tool edits uses the per-file journal and
  undo of `bash` changes becomes available automatically once it is done (the `bash` tool takes the missing "before" snapshot lazily).
  Later snapshots are incremental; if one exceeds `snapshotTimeoutSec` (default 25) only that message skips it and the next retries.
  `"snapshots": false` is the only way to turn them off.
- **Long chats stay fast**: the chat draws the last 60 messages (older ones behind a button), streaming markdown is throttled,
  huge tool results are previewed in the browser but sent in full to the model; session files are written compactly, serialised and listed from a cache.
- **Readable errors**: Cloudflare/gateway HTML pages become one line with a hint (e.g. `524` = the prompt is too big for the server to answer within
  100 s). On 524/504 the agent shortens the prompt (prune + summarise) before retrying. DNS/refused/reset/timeouts are explained in plain words.
- **First connection**: the model list is fetched with up to 3 quick retries, keeps the last good list if a tunnel hiccups, and retries in the
  background until a server answers.
- **Learns the real context window**: if a server accepts more tokens than the detected window, that larger value is used (no pointless compaction).
- **Logs**: `~/.studio/logs/studio.log` (also `GET /api/logs`); `OLLAMA_STUDIO_LOG=debug` prints everything. `GET /api/health` shows status.
  Unexpected exceptions are logged and never stop the server; a corrupt `config.json` is reported and backed up as `config.json.broken`.

## Large projects

Limits are generous by default: context auto-detect up to 131072 tokens, `read_file` 5000 lines / up to ~1 MB per call, tool output kept up to
10000 lines (the rest saved to disk), `grep` 1000 matches, `glob` 5000 files, project tree 100k entries, files searched up to 10 MB,
undo tracking up to 100 MB per file, uploads up to 500 MB, inline attachment text up to 50 % of the context, 200 agent steps per turn.
Tune with `numCtx`, `autoCtxMax`, `maxIterations`, `maxUploadMB`, `attachInlineChars`, `toolOutput: {maxLines, maxBytes}`.
(A very large `numCtx` needs enough VRAM on your Ollama host.)

## Providers & models

Besides your Ollama endpoint you can add any number of providers (UI: **Providers**, or `config.providers`):
`type: "ollama"` (API key **optional** — plain/local Ollama works without one), `type: "openai"` (OpenAI, Groq, Google Gemini,
OpenRouter, LM Studio, llama.cpp, vLLM, Together... any OpenAI-compatible API) or `type: "anthropic"` (Claude, native Messages API).
In the UI pick a **Preset** (OpenAI / Anthropic / Gemini / Groq / OpenRouter), paste the **API key**, press **Test**. Keys are stored in
`config.json` and never sent back to the browser in full; `apiKeyEnv` can name an environment variable instead.
The default (top-level) provider also accepts an optional `apiKey`.

| Provider | type | endpoint |
|---|---|---|
| OpenAI | `openai` | `https://api.openai.com/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com` |
| Google Gemini | `openai` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `openai` | `https://api.groq.com/openai/v1` |
| OpenRouter | `openai` | `https://openrouter.ai/api/v1` |

Optional per-provider keys: `contextWindow`, `maxTokens` (Anthropic output cap, default 32000, steps down automatically for older models).
Models are referenced as `provider/model` (the top-level `endpoint` is provider `default`); agents can pin a model
in frontmatter (`model: openrouter/anthropic/claude-sonnet-4`). Keys go in `apiKey` or `apiKeyEnv` (env var name) and
are never sent back to the browser (masked). `smallModel` is used for titles and summaries.
**`numCtx: 0` = auto**: the context window is read from the Ollama model (capped by `autoCtxMax`, default 131072) or from
`contextWindow` on the provider (defaults: OpenAI-type 128k, Claude 200k, Gemini 1M); set a number to force it. Compaction and output limits follow it.

## MCP servers

`config.mcp` (see `examples/config.example.json`): `local` (stdio command) or `remote` (Streamable HTTP + headers).
Their tools appear as `<server>_<tool>` and **ask permission by default** (`"mcp": {"github_*": "allow"}` to relax).
**Tools → Reload MCP** in the UI reconnects. OAuth-protected remote servers are not supported (use a header token).

## LSP

Language servers found on PATH (typescript-language-server, pyright, gopls, rust-analyzer, clangd, bash, json/html/css,
yaml, lua, zls) or defined in `config.lsp` are started lazily. After every `write_file`/`edit_file` the model gets the
errors back (`lsp_errors`) and can fix them, and an `lsp` tool offers goToDefinition, findReferences, hover,
documentSymbol, workspaceSymbol, goToImplementation and diagnostics. `"lsp": false` turns it off.

## Skills

Folders with a `SKILL.md` (`name`, `description` frontmatter) in `~/.studio/<project>/skills/`, `.claude/skills/`, `.agents/skills/`
or the global equivalents (`~/.config/ollama-studio/skills`, `~/.claude/skills`, `~/.agents/skills`, `config.skills.paths`).
The model sees the list and loads one on demand with the `skill` tool. Example: `examples/skills/commit-style/`.

## Web tools

`webfetch` (URL -> markdown/text/html, 5 MB cap; localhost/LAN URLs always ask first) and `websearch`
(Exa by default, falling back to DuckDuckGo; or `"websearch": {"provider":"searxng","url":"..."}`).

## Snapshots (shadow git) & parallel subagents

Each turn starts with a whole-tree snapshot in a private repo `~/.studio/<project>/snapshot.git` (your project's `.git` is never
touched; `.gitignore` is honoured; needs `git`). **Undo/Redo use it, so changes made by `bash` are reverted too**, and the
UI shows a "N files changed +a −d" summary after every turn. Without git it falls back to the per-file journal.
Several `task` calls in one model message run **in parallel**.

## Long-running commands, Stop and reconnecting

- **Long jobs and servers (builds, installs, watchers):** `bash` has `background: true`. The model starts the job, tells
  you in one sentence and **ends its turn** — it never sits there polling (polling used to fill the context window).
  The studio itself tracks the process (`lib/procs.js`):
  - **Live card + Stop-only composer.** While a background process of the current session runs, a card above the input
    shows the elapsed time, progress (Gradle `> Task`, `NN%`, `[n/m]` parsed from the output — no model involved),
    the last output line and a **Stop** button. The textarea is locked and the Send button becomes **Stop**.
  - **The studio wakes the agent when the job ends.** When the process exits and the agent is idle, the studio starts a
    short turn by itself with a notification (exit code + end of the output, shown in the chat as `🔔 proc_3 finished`);
    the model reports the result or fixes the error. This costs one short turn instead of dozens of polling calls — no
    token system needed. Rules: a job you stopped never wakes anything; a result the model already read itself is not
    announced again; notices wait while the agent is busy; several jobs ending together give one turn; at most 8
    automatic turns in a row without a message from you. Switch it off with `wakeOnProcessExit: false`
    (Settings → *Wake agent when a background job ends*).
  - **Logs on disk:** every background process also writes `~/.studio/<project>/jobs/<id>-<time>.log` (kept 7 days).
  - The `process` tool (`list` / `output` / `kill`) and **Tools → Background processes → Kill** still work; jobs die
    when the studio exits.
- **Downloads** (`GET /api/download?path=`) are real file downloads: `Content-Length` (the browser shows the total
  size), `Accept-Ranges` + `206 Partial Content` (Pause/Resume and continuing after a dropped connection),
  `ETag`/`If-Range` (a resume never glues a new file onto an old partial one) and streaming from disk. Files inside
  build/output folders (`build`, `dist`, `out`, `target`, `outputs`, …) are refused with `409` — and greyed out in the
  file tree — while a background process is running, and files modified in the last 3 seconds are refused too, so a
  half-written APK can't be downloaded. Folder downloads are zipped on the fly (size unknown by nature).
- **Foreground commands** have stdin closed and are killed as a whole *process group* on timeout or Stop, so a server
  started inside a command can no longer survive and block the run (the old "this session is already running" hang).
- **Runs live on the server.** If the tab is closed, the phone suspends the browser, or the connection drops, the agent
  keeps working. Coming back to the tab re-attaches automatically and replays the run (permission/question cards
  included); a session list badge shows **● running**. A 15s keepalive + client watchdog detect frozen sockets.
- **Stop is a real stop:** it aborts the model request and kills running commands. What the model had already written is
  saved (`[response interrupted by the user]`), interrupted tool calls are marked, and the next message ("continue") is told
  the turn was interrupted; the task list (`todo_write`) is part of the prompt, so it resumes instead of restarting.
- Sending a message to a running session is refused with a hint (or pass `"interrupt": true` to `/api/chat` to stop it first).
- The UI re-opens the last session of the directory on load instead of an empty chat.

## Resilience

- Automatic retry with exponential backoff + jitter (5×) on 429/5xx/network/tunnel errors, shown in the UI.
- Real `prompt_eval_count` from Ollama drives auto-compaction; summaries use a structured template
  (Objective / Important Details / Work State / Next Move / Relevant Files), carry the previous summary forward and
  keep recent turns verbatim.
- At the step limit the model gets a "text only, summarise progress" turn instead of being cut off.
- Short AI-generated session titles.

## Project rules — `AGENTS.md`

Injected into the system prompt: global `~/.config/ollama-studio/AGENTS.md`, plus the nearest `AGENTS.md`/`CLAUDE.md`
walking up from the directory to the git root (first match wins), plus any files listed in `config.instructions`.

## Config

Layered: defaults < `config.json` (global) < `~/.studio/<project>/config.json` (per directory, optional).
Keys: `endpoint`, `model`, `smallModel`, `providers`, `defaultProvider`, `agent`, `temperature`, `numCtx`, `autoCtxMax`,
`maxIterations`, `requestTimeoutMs`, `autoCompact`, `wakeOnProcessExit`, `permission`, `instructions`, `mcp`, `lsp`, `websearch`, `skills`,
`toolOutput`, `systemPrompt`.

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | workDir, startup session, agents |
| POST | `/api/workdir` `{dir}` | change directory |
| GET/PUT | `/api/config` | config |
| GET | `/api/models` | models of all providers |
| POST | `/api/providers/test` | test a provider (type, endpoint, apiKey) |
| GET | `/api/mcp`, POST `/api/mcp/reload` | MCP status / reconnect |
| GET | `/api/agents` | all agents |
| GET/POST | `/api/sessions` | list / create |
| GET/PUT/DELETE | `/api/sessions/:id` | read / rename+switch agent / delete (with children) |
| POST | `/api/sessions/:id/fork` `{upTo?}` | branch |
| POST | `/api/sessions/:id/compact` | summarise context |
| GET | `/api/sessions/:id/export` | JSON incl. child sessions |
| GET | `/api/tree`, GET/PUT/DELETE `/api/file?path=` | files in the directory |
| POST | `/api/chat` `{sessionId?, text, agent?, model?}` | SSE agent run |
| POST | `/api/permission` `{id, reply}` | answer a permission request |
| POST | `/api/abort` `{sessionId}` | stop a run |
| GET | `/api/sessions/:id/attach` | SSE: (re)attach to a running session, replays the run |
| GET / DELETE | `/api/processes[?sessionId=]`, `/api/processes/:id` | background processes (`session_id`, `progress`, `last_line`, `killed`; with `sessionId` also `sessionRunning`) |
| POST | `/api/answer` `{id, answer}` | answer a `question` from the agent |
| POST | `/api/sessions/:id/undo` / `redo` | revert / re-apply the last turn |

SSE events: `start, iteration, thinking, token, tool_call, tool_result, subagent, sub_event, todos,
permission_request, permission_resolved, question, question_resolved, aborted, retry, agent, title, changes, compacting, metrics, warning, error, done`.

## Layout

```
server.js            HTTP + SSE + CLI
scripts/build.js     single-executable build (bundle + embed UI + inject)
lib/runtime.js       source vs. single-executable differences (embedded assets)
lib/recall.js        SQLite FTS5 history index + keyword retrieval
lib/attach.js        chat attachments: storage, text extraction, vision/OCR fallbacks
public/markdown.js   markdown renderer for chat messages
lib/config.js        layered config, working directory
lib/workspace.js     path-safe file ops, glob, grep
lib/permission.js    rule engine (patterns, bash segments, grants)
lib/edit-match.js    fuzzy edit matchers
lib/journal.js       undo / redo
lib/commands.js      slash commands
lib/sessions.js      persistent sessions (+ fork, export)
lib/agents.js        built-in + markdown agents, system prompt, AGENTS.md
lib/tools.js         tool schemas, permissions, bash
lib/agent.js         agent loop, subagents, compaction
lib/llm.js           provider layer (resolve, listing, context window)
lib/ollama.js        streaming Ollama client
lib/openai.js        OpenAI-compatible streaming client
lib/anthropic.js     Anthropic (Claude) Messages API client
lib/mcp.js           MCP client (stdio + HTTP)
lib/lsp.js           LSP client + diagnostics
lib/skills.js        SKILL.md loader
lib/web.js           webfetch / websearch
lib/snapshot.js      shadow-git snapshots
lib/procs.js         foreground/background process management (exit events, progress, job logs)
lib/wake.js          wakes the agent when a background process finishes
lib/serve-file.js    file downloads: Content-Length, Range/resume, build-output guard
public/              UI
test/                unit + smoke tests (`npm test`, node --test)
```
