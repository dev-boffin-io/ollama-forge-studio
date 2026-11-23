# Ollama Forge Studio v1.0

An agentic coding studio for any Ollama endpoint (local or a Cloudflare tunnel URL).
Zero runtime dependencies — Node 18+ (Node 22.5+ for long-term memory / recall, which needs `node:sqlite`).

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
   ├─ uploads/  tool-output/  plans/  agents/  skills/  commands/  plugins/
   ├─ backups/  snapshot.git/  recall.db  config.json
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

# Optional: embed an extended skill library from <path>/skills (off by default)
npm run build -- --with-remotes=/path/to/remotes
npm run build -- --with-remotes=/path/to/remotes --remote-max-mb=256 --remote-file-max-kb=2048
```

- `--with-remotes` embeds `<path>/skills` as a hidden bundled skill layer; the path must contain a `skills/` folder.
  Only unique skills (by `name`, shallowest copy wins), their `SKILL.md`, and text resources are embedded, up to 64 MB with a
  256 KB per-file cap by default. Raise them with `--remote-max-mb` / `--remote-file-max-kb` (or use `skills.remotesPath` to
  load from disk instead). Larger payloads mean a much larger binary and can make `postject` fail.
  The files unpack to `~/.config/ollama-studio/bundled/<hash>/remotes/skills/` and are never listed in the normal skills prompt.
- Needs **Node ≥ 20.12** (22+ recommended) on the *build* machine; the binary embeds that Node runtime (~100 MB).
- It can't cross-compile: build on each OS/arch you target. `.github/workflows/release.yml` runs `npm run check` and `npm test` on pushes to `main`/`master` and on pull requests;
  the Linux, macOS and Windows binaries are built only for `v*` tags and manual runs (Actions tab). A `v*` tag also attaches them to a GitHub release (the only job with write access).
- The UI (`public/*`) is embedded in the binary. Without a source tree, the global `config.json` is read/written at
  `~/.config/ollama-studio/config.json` (`$XDG_CONFIG_HOME` honoured) next to your global agents/commands/skills.
  Per-project data still lives in `~/.studio/<project>/`. Set `OLLAMA_STUDIO_CONFIG` to use a different config file
  (the tests use this to keep `config.json` out of the source tree).
- `git` is still needed on PATH for snapshots/undo (as in source mode); the studio runs fine without it.

## Security model

The studio can edit files and run commands as *you*, so it protects its own HTTP API:

| Situation | What is enforced |
|---|---|
| Default (`--host 127.0.0.1`) | Only the Host names `localhost`, `127.0.0.1`, `[::1]` are answered (blocks DNS rebinding). Browsers' cross-site requests are refused (`Origin` / `Sec-Fetch-Site` checks) and every write must be `application/json`, so no web page you visit can drive the API. Add more names with `OLLAMA_STUDIO_ALLOWED_HOSTS=a.example,b.example` or `--allow-host`. |
| Reachable from other machines (`--host 0.0.0.0`, a LAN IP, …) | A random **access token** is required. The URL printed at startup contains it (`http://…/?token=…`); the first visit stores it in an HttpOnly `SameSite=Strict` cookie. Scripts can send `Authorization: Bearer <token>`. Fix the token with `OLLAMA_STUDIO_TOKEN`. The same token also protects a loopback server when `OLLAMA_STUDIO_TOKEN` is set. |
| All responses | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`. JSON bodies are capped at 8 MB (chat 32 MB, file save 64 MB); uploads stream with their own `maxUploadMB` limit. |

**Project trust.** Plugins that live *inside* a project (`.studio/plugins`, `.claude/plugins`, `.agents/plugins`) and a project's own `node_modules/.bin` (for LSP servers) are code from whoever owns that folder.
They are ignored until you trust the project: answer the prompt at startup (`y` always / `o` this run), start with `--trust`, call `POST /api/trust {"trust":true}`, or set `OLLAMA_STUDIO_TRUST_PROJECT=1`.
Trusted folders are remembered in `~/.studio/trusted-projects.json`. Plugins in your own home (`~/.config/ollama-studio/plugins`, `~/.studio/<project>/plugins`) never need it.

**Secrets.** Commands run by the agent (`bash`, background processes, the terminal, command plugins) get your environment *without* variables that look like secrets (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*CREDENTIALS*`, the `apiKeyEnv` variables of your providers, `OLLAMA_STUDIO_TOKEN`).
Change that with `"bashEnv": { "allow": ["GITHUB_TOKEN"] }`, `{ "deny": ["FOO_*"] }` or `{ "inherit": true }`. `config.json` is written with mode `0600` (directories `0700`).

**webfetch (SSRF).** Redirects are followed manually (max 5) and a public URL may never lead to a private address; hostnames are resolved and refused if they point to loopback / private / link-local / CGNAT / IPv6-ULA / IPv4-mapped addresses.
`localhost` / LAN URLs that you type still work after the usual permission question. For an intranet hostname that resolves to a private IP set `"webfetch": { "allowPrivate": true }`.
Known limit: the name is resolved once before connecting, so a hostile DNS server that changes its answer between that check and the connection is not covered; use the Docker sandbox and a firewall if you fetch untrusted URLs.

**Permissions.** `edit` is allowed by default (confined to the project, undoable); `bash` asks. `git diff|log` stay auto-allowed but their `--output`, `--ext-diff`, `--textconv`, `-c` flags ask.
For stricter use: `"permission": { "edit": "ask" }` and `"sandbox": { "enabled": true }` (Docker).

Not covered: the VS Code extension does not send the token yet, so use it with a loopback server; and a model can still do anything *you approve* — read prompts before pressing Allow. See `SECURITY.md`.

## Tests

```bash
npm test        # Node's built-in test runner (zero dependencies): unit tests + a real server boot smoke test
```

Covers the permission rule engine, fuzzy `edit_file` matching, path-safe workspace ops (incl. symlink escapes),
config layering, sessions (fork / archive / export), provider resolution and key masking, the XSS-safe markdown
renderer, attachment classification, skills, tool visibility per agent, lifecycle hooks, plugin loading/tools/routes,
Docker sandbox argument construction and fail-closed behavior, the VS Code SSE client, and an end-to-end HTTP API check
against a live `server.js`. Sandbox tests do not need a Docker daemon. Every test file runs in its own process with a
throwaway `OLLAMA_STUDIO_HOME` — nothing in your real `~/.studio/` or `config.json` is touched.

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
- **Semantic search (optional)** – set `"embedModel"` in `config.json` (a model ref such as `"nomic-embed-text"` or `"openai/text-embedding-3-small"`;
  Ollama `/api/embed` and OpenAI-compatible `/embeddings` are supported). Every snippet is then also embedded in the background
  (Float32 vectors in the same `recall.db`, cosine similarity in plain JS — no extension, no dependency) and both the automatic
  recall and the `recall` tool fuse BM25 and vector rankings with Reciprocal Rank Fusion, so related text is found even without a
  shared keyword or in another language. Existing history is embedded in the background too. If the embedding server is
  unreachable the memory silently stays keyword-only (and retries after a minute). Changing `embedModel` re-embeds everything.
- Deleting a session also deletes its index rows. Needs **Node ≥ 22.5** (built-in `node:sqlite`; the single binary includes it).
  On older Node the feature silently turns itself off.

Model "thinking" output is saved with the session and shown again when you reopen it, as a collapsible "💭 Thinking" block (never sent back to the model).

Assistant replies are rendered as markdown (headings, bold/italic, lists incl. Bengali numerals, tables, quotes, links, inline code and
syntax-coloured code blocks with a Copy button) by the dependency-free, XSS-safe `public/markdown.js`.

## Fleet, event bus and dashboard (Chat · Fleet · Memory tabs)

The chat pane has three tabs.

- **Fleet** – a *fleet* is a named group of agents (each one a normal saved session). Create one, add agents (`build`, `plan`, your
  custom ones, `auto`), then **dispatch** a task to one agent or to all idle ones. At most `fleet.maxParallel` (default 3) agents run
  at once; the rest wait in a queue. Cards show live status (idle · queued · running · **needs input** · done · failed), the last
  task and the last report; *Open* jumps to the agent's chat (that is where you answer a permission prompt).
  **Handoffs** are triggers on the event bus: *"when A finishes → start B"* with A's final report put into B's message
  (template placeholders `{{result}}`, `{{task}}`, `{{from}}`; `when done | failed | always`). Chains are capped at
  `fleet.maxChain` (default 8) automatic hops so a loop A → B → A cannot run away. Fleets are saved per project in
  `~/.studio/<project>/fleets.json`; runs that were active when the studio stopped come back as idle.
- **Memory** – the memory/context explorer: index size, semantic-index progress, the context meter of the open session
  (live vs. archived messages, compactions, summaries), the snippets that were injected into the last turn, and a search box
  (whole project / this session) that shows for every hit whether it came from BM25, the vectors or both.
- **Event bus** (`lib/events.js`) – the studio announces `agent_started`, `agent_finished_task`, `agent_failed`, `agent_aborted`
  (also for subagents, with `isChild`), `memory_recalled`, `memory_embedded` and `fleet_updated`. The dashboard listens through
  `GET /api/events` (SSE; resumes from `Last-Event-ID`, `?since=N`, `?types=a,b`), plugins can use `require('./events').bus`.

```jsonc
// config.json
{ "embedModel": "nomic-embed-text", "fleet": { "maxParallel": 3, "maxChain": 8 } }
```

## Agents

| Agent     | Mode     | Access                                              |
|-----------|----------|-----------------------------------------------------|
| `build`   | primary  | Full access (default)                               |
| `plan`    | primary  | Read-only: analyse and produce a plan               |
| `auto`    | primary  | Rotates between the primary agents ([below](#auto-mode)) |
| `general` | subagent | Multi-step delegated work, own child session        |
| `explore` | subagent | Read-only fast codebase search                      |

Switch primary agents from the dropdown in the chat header. Primary agents can delegate to subagents with the
`task` tool; every subagent run is stored as a child session (subagents cannot spawn subagents).

**Bundled agents:** every `examples/agents/*.md` ships with the app
and is available out of the box — also inside the single-file executable. They are the *lowest* layer
(bundled < `agents.paths` < global < project), so a file with the same name in your own folders replaces the bundled one.
Set `OLLAMA_STUDIO_NO_BUNDLED=1` to switch the bundled agents, skills, commands and plugins off.

| Bundled agent           | Access                                                                  | Job |
|-------------------------|-------------------------------------------------------------------------|-----|
| `reviewer`              | read-only (`git diff/log/show`)                                          | code review with file:line findings |
| `security-agent`        | read-only (+ `npm audit`)                                                | secrets / vulnerability / dependency audit |
| `debug-agent`           | full access                                                              | reproduce → root cause → verified fix |
| `architect`             | writes only `.studio/plans/*.md` and `docs/architecture/*.md`, read-only bash | system / schema / API-contract design with Mermaid diagrams |
| `test-engineer`         | edits **test files only** (`*.test.*`, `tests/`, `conftest.py`, …); test runners allowed | writes and runs tests, never touches production code |
| `doc-writer`            | `*.md` and `docs/` freely, other files ask first; read-only bash         | README, API docs, doc comments, checked against the code |
| `performance-optimizer` | edits and commands ask first; reading is free                            | measure-first profiling and optimization |

The bundled agents are role-scoped; see [Skills](#skills) for the operational capabilities they do not own.

The four newest are `mode: all` (pick them in the dropdown or delegate with `task`) with `auto: false`, so they do not
crowd the [auto mode](#auto-mode) rotation. Any agent can run on its own model: add `model: provider/model` to its
frontmatter (e.g. a cheap model for `doc-writer`, a strong one for `architect`). Opt-in `extras/agents/` adds
`release-manager` and `support-triage`; see [Extras](#extras-optional-off-by-default).

### Auto mode

Pick **auto** in the agent dropdown and the studio moves the work between the primary agents step by step
(`build`, `plan` and every custom agent with `mode: primary` or `all`):

1. **Per message** — a quick router call (`smallModel` if set, otherwise the chat model) chooses the agent that fits
   your new message. It prefers the agent that was working before and keeps it whenever the answer is unusable.
2. **During a turn** — the active agent can hand over by itself with the `switch_agent` tool (e.g. finished code →
   a review agent, a failing test run → a debugging agent). The loop then continues as the new agent: its prompt,
   model, tools and permissions.
3. **Subagents still work** — whoever is active keeps the `task` tool and can delegate to `general`, `explore` and
   any `mode: subagent` / `mode: all` agent.

The dropdown stays on `auto` and shows who is working (`auto · fixer`); every hand-over appears as a note in the chat.
`plan` never hands over silently: leaving it still goes through `plan_exit` and your approval. Not every agent belongs in
the rotation — add `auto: false` to its frontmatter to keep it out (it can still be picked by hand). `auto` is a reserved
name. Set `"autoRoute": false` in the config to skip the per-message router call (agents then only change via
`switch_agent`). Note that a hand-over can move the work to an agent with wider permissions than the previous one
(the permission rules of each agent apply as soon as it takes over).

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

`list_files`, `glob` (truncated results signal), `grep` (truncated results signal), `read_file` (line numbers, 5000-line / size cap, binary detection, "did you mean", array of paths), `move_file`, `write_file`, `edit_file` (dry_run), `multi_edit`, `json_edit`, `delete_file`, `bash`, `process` (list / output / kill / **input**), `todo_write`, `task` (subagents, resumable with `task_id`),
`question` (ask you a question, with options), `plan_exit` (plan agent only), `webfetch`, `websearch`, `skill`, `lsp`,
any MCP tools, and plugin tools (`<plugin>_<tool>`). Plugin and MCP tools ask for permission by default.

- **Edit recovery & loop breaker**: a failed `old_string` now returns the *actual* closest lines (numbered like `read_file`) so the model can copy them;
  double-escaped `\\n` and CRLF files are handled; `edit_file` also accepts `start_line` / `end_line` (+ `expect_first_line`) so no `old_string` is needed.
  After 2 failed edits on one file the error tells the model to re-read and switch to a line-range edit. Identical calls ×5, or the same tool failing ×3
  in a row (even with different inputs), are refused outright (grants don't override this); a user-rejected action is remembered and never re-asked.
  **Read-before-edit**: `edit_file`/`multi_edit` are refused unless the file's text is in the model's *live* context (an un-pruned `read_file`, or its own successful write/edit);
  context pruning now keeps the latest `read_file` output of every file that has not changed since (≤12k chars each, ≤36k total).
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
  "task": { "general": "deny" },
  "plugin": { "*": "ask" }
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

`/init` (write AGENTS.md), `/review [commit|branch]`, the bundled `examples/commands/test.md`, plus `commands.paths`,
`~/.studio/<project>/commands/<name>.md` and `~/.config/ollama-studio/commands/` (`$ARGUMENTS`, `$1..$9`, `@path` inlines a
file, optional `agent:`). Bundled commands are loaded below user commands; the opt-in `extras/commands/` adds a deeper
`/review` override and `/verify`. Type `/` in the prompt box for hints.

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

Recursive subagents: `workflow: {maxDepth: 3, maxConcurrent: 20}` — subagents may delegate down to `maxDepth` levels (deeper calls get `Error: Maximum recursion depth (3) reached.`); at most `maxConcurrent` run at once, the rest queue. The `task_tree` tool shows the status of all subtasks.
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

### Using Local OpenAI-compatible Servers (LM Studio, llama.cpp, etc.)

These tools are fully supported via the `openai` provider type because they implement the OpenAI-compatible API standard. To use them, add them to your `config.json` as follows:

#### LM Studio
```json
{
  "providers": {
    "lmstudio": {
      "type": "openai",
      "endpoint": "http://localhost:1234/v1"
    }
  },
  "defaultProvider": "lmstudio"
}
```

#### llama.cpp (Server Mode)
```json
{
  "providers": {
    "llama_cpp": {
      "type": "openai",
      "endpoint": "http://localhost:8080/v1"
    }
  },
  "defaultProvider": "llama_cpp"
}
```


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

## Plugins

Plugins add tools, lifecycle hooks and HTTP routes without changing the core. They are loaded from the bundled
`examples/plugins/` folder (lowest priority), the global `plugins/` folder, the project's `.studio/plugins/`,
`.claude/plugins/` or `.agents/plugins/`, the project data folder, and `config.plugins.paths`. Disable all of them with
`"plugins": { "enabled": false }`. Bundled examples ship with the studio: `now_now` (timestamps and timezones),
`json_format` (JSON validation and formatting), and `http_request` (full HTTP/JSON client with private-network guards,
env-based secret injection, opt-in full/binary bodies, redirect and download support, and permission prompts).

A plugin is a CommonJS file, a folder with `index.js` / `plugin.js`, or a folder with `plugin.json` (optionally with a
`main` entry). Plugin tools are always namespaced, so a `docker` plugin with a `ps` tool becomes `docker_ps`:

```js
module.exports = {
  name: 'hello',
  setup(api) {
    api.registerTool({
      name: 'greet',
      description: 'Greet someone',
      parameters: { type: 'object', properties: { who: { type: 'string' } } },
      handler: async ({ who }) => ({ output: `hello ${who || 'world'}` }),
    });
    api.registerHook('on_tool_call', (event) => ({ allow: event.tool !== 'bash' }));
    api.registerRoute({ method: 'GET', path: '/api/plugins/hello', handler: () => ({ ok: true }) });
  },
};
```

JSON plugins can contribute command tools without any JavaScript:

```json
{ "name": "hello", "tools": { "greet": { "description": "Greet", "command": ["node", "greet.js"] } } }
```

Command tools receive `{ "args": {...}, "workDir": "...", "studioDir": "...", "sessionId": "..." }` as JSON on stdin
and may print JSON. Plugin tools use the `plugin` permission category and **ask by default**; add
`"plugin": { "hello_*": "allow" }` to relax it. Plugin routes must start with `/api/plugins/`. Use
`GET /api/plugins` to inspect loaded plugins or `POST /api/plugins/reload` after changing one. Plugins are trusted
code: only install plugins you would run directly.

## Self-correction loop (verify after every edit)

The agent does not just write code, it proves that the code works. Zero extra model calls; everything below is automatic.

1. **Edit** — `write_file`, `edit_file`, `multi_edit` or `json_edit` changes a file.
2. **Immediate test** — the studio checks that file at once: a syntax check for its type (`node --check`, `JSON.parse`, Python compile,
   `bash -n`) plus the test file that belongs to it (`lib/foo.js` → `test/foo.test.js` for `node --test` projects, `test_foo.py` for
   pytest). The verdict is attached to the tool result as `verify` (`pass` / `fail` / `skipped`).
3. **Error analysis** — on `fail` the result contains the error output and repair instructions: read the log, decide syntax vs. logic
   error, fix the *code* (never weaken or delete a test to get green).
4. **Self-correction** — the model edits again and the check re-runs automatically, until it passes. After `maxFixRounds` failures in a
   row on one file it is told to stop guessing and report the exact error.
5. **Final verification** — when the model wants to end its turn and files changed, the project's **full test command** runs once
   (regression check). A failure goes back to the model together with its output and the turn continues; at most `maxFinalRounds`
   times. Moves and deletes also trigger the final check.

The full suite is deliberately *not* run after every single edit (it can take a minute or more): per edit you get the fast file-level
feedback, the full suite runs once at the end. The final command is auto-detected — `npm|yarn|pnpm test` (the `npm init` placeholder is
ignored), `pytest`, `go test ./...`, `cargo test`, `make test` — and is **never guessed**: a project without a test command is simply
not verified. Commands run through the same runner as `bash`, so the [Docker sandbox](#docker-sandbox) applies when enabled.

```json
"verify": {
  "enabled": true,
  "onEdit": true,
  "final": true,
  "command": "",
  "editCommand": "",
  "editTimeoutSec": 60,
  "finalTimeoutSec": 280,
  "maxFixRounds": 4,
  "maxFinalRounds": 3
}
```

`command` overrides the detected full test command; `editCommand` replaces the built-in per-edit checks (placeholders `{file}` and
`{test}`, e.g. `"npx jest --findRelatedTests {file}"`). `"verify": false` turns the whole loop off. Changes made through plugin/MCP tools
or by `bash` are not checked per edit and do not by themselves trigger the final check: only the built-in file tools mark the turn as
changed. Tests: `test/verify.test.js`.

## Lifecycle hooks

Hooks run at agent and tool boundaries. Configure them in `config.json` or register them from a plugin:

```json
"hooks": {
  "pre_edit": [{ "backup": true }],
  "on_tool_call": [{ "command": ["node", "hooks/audit.js"], "timeout": 10000 }],
  "on_file_change": [{ "command": ["node", "hooks/log-change.js"] }]
}
```

Events: `on_agent_start`, `on_agent_end`, `on_tool_call`, `on_tool_result`, `pre_edit`, `on_file_change`, `on_error`.
`pre_edit` and `on_tool_call` are blocking by default; set `"blocking": false` to observe only. The other events are
observe-only. A hook may be a command, a JS function (plugins), or `{ "backup": true }`. Command hooks receive the event payload as JSON on stdin and in
`OLLAMA_STUDIO_HOOK_PAYLOAD`, with `OLLAMA_STUDIO_HOOK`, `OLLAMA_STUDIO_WORKDIR` and `OLLAMA_STUDIO_SESSION` set. Print
`{ "allow": false, "message": "why" }` to block a blocking event. `{ "backup": true }` copies the old file or folder to
`~/.studio/<project>/backups/<timestamp>/` before an edit. Hook failures are logged; a blocking hook failure stops the
tool (fail closed). Use `"*"` as the event key to run a hook for every event.

## Docker sandbox

Set `sandbox.enabled` to run agent shell commands (and the user terminal) inside a fresh Docker container. The project
is mounted at `/workspace` and the studio data folder at `/workspace/.studio`:

```json
"sandbox": {
  "enabled": true,
  "image": "node:20-bookworm",
  "network": "none",
  "memory": "1g",
  "cpus": "1",
  "mount": "rw"
}
```

Use `"mount": "ro"` for a read-only project, `"network": "bridge"` when the agent must install packages, and
`"extraArgs"` for additional `docker run` flags. `user`, `env`, `pidsLimit`, `init`, `noNewPrivileges`,
`readOnlyRootfs`, `mountStudio` and `docker` (the binary) are also configurable. Sandboxing is **fail closed**: if
Docker or its daemon is unavailable, commands fail instead of silently running on the host. Check availability with
`GET /api/sandbox`. Docker is not bundled with the studio. The sandbox covers agent `bash` and terminal commands;
hooks and plugin tools run in the studio process (plugins are trusted code).

## VS Code extension

The dependency-free extension in `vscode-extension/` (VS Code 1.82+, which includes `fetch`/Web Streams) chats with the
running studio over its REST/SSE API, so agent runs, tools, permissions, hooks, plugins and the sandbox behave exactly
as in the browser. It has no build step:

1. Open the repository in VS Code and press `F5` (Run Extension), then run **Ollama Studio: Open Chat**.
2. Or symlink `vscode-extension/` into `~/.vscode/extensions/` and reload VS Code.

Commands: **Open Chat**, **Send Selection to Chat** (also in the editor context menu), **Start Server**, **Stop Server
Started by Extension**, **Open Settings**. If no studio answers, it starts `server.js` automatically and stops only the
server it started. Settings: `ollamaStudio.serverUrl` (default `http://127.0.0.1:4310`), `autoStart`, `serverPath` and
`nodePath`. See `vscode-extension/README.md` for details.

## LSP

Language servers found on PATH (typescript-language-server, pyright, gopls, rust-analyzer, clangd, bash, json/html/css,
yaml, lua, zls) or defined in `config.lsp` are started lazily. After every `write_file`/`edit_file` the model gets the
errors back (`lsp_errors`) and can fix them, and an `lsp` tool offers goToDefinition, findReferences, hover,
documentSymbol, workspaceSymbol, goToImplementation and diagnostics. `"lsp": false` turns it off.

## Skills

Folders with a `SKILL.md` (`name`, `description` frontmatter) in `~/.studio/<project>/skills/`, `.claude/skills/`, `.agents/skills/`
or the global equivalents (`~/.config/ollama-studio/skills`, `~/.claude/skills`, `~/.agents/skills`, `config.skills.paths`).
The model sees the list and loads one on demand with the `skill` tool.

**Bundled skills:** every folder in `examples/skills/` (`bug-triage`, `code-explorer`, `code-quality-pass`, `commit-style`,
`dependency-setup`, `dependency-upgrade`, `doc-generator`, `documentation-upkeep`, `error-recovery`, `file-operations`,
`git-workflow`, `i18n-l10n`, `project-onboarding`, `refactor-expert`, `release-notes`, `test-and-dev-server`, `test-and-verify`)
is loaded by default and is overridden by a skill of the same `name` in any of the folders above.
In the single-file executable they are embedded at build time (`npm run build`) and unpacked once to
`~/.config/ollama-studio/bundled/<hash>/`, so a skill's `scripts/` and `reference/` files and plugin entrypoints still have
a real path. Bundled commands and plugins live in `examples/commands/` and `examples/plugins/` and follow the same rules.
To ship another default agent, skill, command or plugin, drop it into the matching `examples/` folder and rebuild.

**Agents vs skills:** the seven bundled agents own the roles of **architecture and design** (`architect`), **debugging and
verified fixes** (`debug-agent`), **test authoring and execution** (`test-engineer`), **documentation** (`doc-writer`),
**code review** (`reviewer`), **security auditing** (`security-agent`) and **performance analysis** (`performance-optimizer`).
The skills above supply the operational layer: code exploration, file operations, refactors/formatting, error recovery,
tests and dev servers, dependencies and documentation upkeep. General file management, formatting, dependency
installation/upgrade and dev-server launch are skill/`build` territory, not agent jobs. Skills grant no permissions — the
active agent's `permission:` rules still decide what may be edited or run.

**Automatic shortlist:** every turn, the studio ranks local and bundled-remote skills against the latest user message and
attaches the top 2-3 as `<auto_skills>` in the system prompt; bodies are capped so the vast library stays cheap to use.
Call the `skill` tool by exact name only when you need the full text. Tune it in `config.json`:

```jsonc
{ "skills": {
  "remotesPath": "/path/to/remotes",
  "auto": {
    "enabled": true, "count": 3, "minScore": 1,
    "maxChars": 4000, "totalChars": 12000,
    "include": [], "exclude": ["noisy-skill"],
    "fallback": ["test-and-verify", "bug-triage"]
  }
} }
```

`skills.remotesPath` points at the same `<path>` used by `--with-remotes` (it should contain `skills/`), but loads the library
from disk instead of embedding it — useful when the default 64 MB embed cap is too small. It is also editable in Settings.
Set `auto: false` in a skill's frontmatter to keep it out of the shortlist; `include` pins skills, `exclude` blocks names or
tags. For a large library, add `tags: docker, review` to frontmatter — ranking uses name, description and tags.

**Three-tier loading:** the `skill` tool first loads a normal/local skill by exact name. If that misses, it checks the hidden
bundled remote layer (build with `--with-remotes=/path/to/remotes`), then falls back to web discovery for topic names.
Hidden bundled skills are not listed in the prompt, use a real base directory for their files, and are marked untrusted like
web skills. Local skills always win when the same `name` exists in multiple tiers. Direct `http(s)` URLs keep loading as
one-off remote skills, and web discovery still requires netcheck, `websearch`/`webfetch`, and normal permission approvals.

## Extras (optional, off by default)

`extras/` holds things that are useful to some people but would cost prompt tokens for everyone if they shipped as defaults:
agents `release-manager` and `support-triage`; commands `/review` (deep override) and `/verify`; skills `api-designer`,
`docker-expert`, `database-migration`; and the plugin `text-search` (tool `text_search`: pure Node.js regex/text search, no
external binaries). They are enabled with `agents.paths`, `commands.paths`, `skills.paths` and
`plugins.paths` in the config; see [`extras/README.md`](extras/README.md). They are not embedded in the single-file executable.

## Web tools

`webfetch` (URL -> markdown/text/html, 5 MB cap; localhost/LAN URLs always ask first) and `websearch`
(DuckDuckGo with parallel variants, dedup, TTL cache, recency/site_type, published dates when available, retry/backoff,
clear errors on parse failure; the `html` endpoint falls back to `lite`, then to Exa/SearXNG per `config.websearch`;
optional `autoFetchLimit` extracts short excerpts).

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
  - **Interactive programs (prompts, REPLs, scaffolders):** start with `bash background=true interactive=true` to keep
    stdin open, then answer with `process action=input id=proc_N text="…"` (Enter is appended; `newline=false` for raw
    keystrokes, `close_stdin=true` sends EOF). The result contains the output the program produced in response. Sending
    input is treated like running a command: it follows the agent's `bash` permission rules (an agent without bash cannot
    type into a shell), and "Always allow" remembers only `stdin→<id> *`, never a command hidden in the text. Without
    `interactive`, stdin stays closed (EOF), as before, so ordinary commands never hang waiting for input. This is a plain
    pipe, not a PTY: programs that insist on a real terminal need their non-interactive flags (`--yes`, `--no-input`).
- **Downloads** (`GET /api/download?path=`) are real file downloads: `Content-Length` (the browser shows the total
  size), `Accept-Ranges` + `206 Partial Content` (Pause/Resume and continuing after a dropped connection),
  `ETag`/`If-Range` (a resume never glues a new file onto an old partial one) and streaming from disk. Files inside
  build/output folders (`build`, `dist`, `out`, `target`, `outputs`, …) are refused with `409` — and greyed out in the
  file tree — while a background process is running, and files modified in the last 3 seconds are refused too, so a
  half-written APK can't be downloaded. Folder downloads are zipped on the fly (size unknown by nature).
- **Foreground commands** have stdin closed and are killed as a whole *process group* on timeout or Stop, so a server
  started inside a command can no longer survive and block the run (the old "this session is already running" hang).
- **Terminal (for you, not the model):** the **Terminal** button opens a console panel where you run shell commands
  directly in the working directory. Output streams live over SSE (`stdout`/`stderr` are coloured separately), **Stop**
  kills the whole process group, command history is kept locally (↑/↓), and a reload re-attaches to a command that is
  still running. Each Run is a fresh shell with stdin closed (no interactive prompts); the server owns the process.
  Set `"terminal": false` to hide/disable it.
- **Runs live on the server.** If the tab is closed, the phone suspends the browser, or the connection drops, the agent
  keeps working. Coming back to the tab re-attaches automatically and replays the run (permission/question cards
  included); a session list badge shows **● running**. A 15s keepalive + client watchdog detect frozen sockets.
- **Stop is a real stop:** it aborts the model request and kills running commands. What the model had already written is
  saved (`[response interrupted by the user]`), interrupted tool calls are marked, and the next message ("continue") is told
  the turn was interrupted; the task list (`todo_write`) is part of the prompt, so it resumes instead of restarting.
- **Unfinished-work nudge asks first.** If a turn ends while its own task list is still open (or the model says it will
  continue but makes no tool call), the agent asks **Continue?** with *Yes, continue* / *No, stop* / a custom instruction
  instead of silently forcing another step. Stale todos from earlier turns never trigger it. Set `"nudgePrompt": false`
  to restore automatic nudging.
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
`maxIterations`, `workflow`, `requestTimeoutMs`, `autoCompact`, `wakeOnProcessExit`, `nudgePrompt`, `terminal`, `permission`, `instructions`, `mcp`, `lsp`, `websearch`, `skills`,
`hooks`, `plugins`, `sandbox`, `toolOutput`, `systemPrompt`.

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | workDir, startup session, agents, plugins, sandbox |
| POST | `/api/workdir` `{dir}` | change directory |
| GET/PUT | `/api/config` | config |
| GET | `/api/models` | models of all providers |
| POST | `/api/providers/test` | test a provider (type, endpoint, apiKey) |
| GET | `/api/mcp`, POST `/api/mcp/reload` | MCP status / reconnect |
| GET | `/api/plugins`, POST `/api/plugins/reload` | plugin status / reload |
| GET | `/api/sandbox` | Docker sandbox status / availability |
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
| GET / POST | `/api/terminal`, `/api/terminal/:id` | list / start (`{command}`) a user terminal; DELETE stops it |
| GET | `/api/terminal/:id/stream` | SSE: buffered + live `output` (`stdout`/`stderr`, `seq`) then `exit` |
| POST | `/api/answer` `{id, answer}` | answer a `question` from the agent |
| POST | `/api/sessions/:id/undo` / `redo` | revert / re-apply the last turn |
| GET | `/api/events` | SSE: live studio events (see *Fleet, event bus and dashboard*) |
| GET | `/api/fleet/status` | fleets, members (status, last task/report), links, slots in use |
| POST | `/api/fleet/create` `{name, members:[{agent, model?, title?}]}` | new fleet (members are new sessions) |
| POST | `/api/fleet/member` `{fleetId, agent, model?, title?, sessionId?}` | add an agent (or an existing session) |
| POST | `/api/fleet/dispatch` `{fleetId, member: sessionId\|"all", task}` | send a task → `[{sessionId, status: started\|queued\|busy}]` |
| POST | `/api/fleet/link` `{fleetId, from, to, on?, template?}` / `unlink` `{fleetId, linkId}` | handoff trigger |
| POST | `/api/fleet/stop` `{sessionId}` / `remove` `{fleetId, sessionId?}` | stop / remove member or fleet |
| GET | `/api/memory/status`, `/search?q=&scope=&session=`, `/recent`, `/context?session=` | memory explorer data |
| POST | `/api/memory/reindex` | index every session and (re)start the embedding backfill |

SSE events: `start, iteration, thinking, token, tool_call, tool_result, subagent, sub_event, todos,
permission_request, permission_resolved, question, question_resolved, aborted, retry, agent, title, changes, compacting, metrics, warning, error, done`.

## Layout

```
server.js            HTTP + SSE + CLI
scripts/build.js     single-executable build (bundle + embed UI + inject)
lib/runtime.js       source vs. single-executable differences (embedded assets)
lib/recall.js        SQLite FTS5 history index + keyword retrieval (+ optional vectors, hybrid search)
lib/embed.js         optional embedding client (Ollama /api/embed, OpenAI /embeddings)
lib/events.js        in-process event bus (feeds fleets, the dashboard stream, plugins)
lib/fleet.js         FleetManager: agent groups, dispatch queue, event-driven handoffs
public/panels.js     Chat / Fleet / Memory tabs
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
lib/bundled.js       bundled layer: examples/{agents,skills,commands,plugins} as defaults (source + single executable)
extras/              opt-in agents + commands + skills + plugins, see extras/README.md
lib/auto.js          auto mode: per-message router (agent hand-over lives in lib/tools.js + lib/agent.js)
lib/tools.js         tool schemas, permissions, bash, plugin tool dispatch, hook calls
lib/agent.js         agent loop, subagents, compaction, lifecycle hooks
lib/hooks.js         lifecycle hook registry, command/JS hooks, blocking, backups
lib/plugins.js       external plugin loader: tools, hooks, HTTP routes
lib/sandbox.js       Docker sandbox command construction, availability, cleanup
lib/llm.js           provider layer (resolve, listing, context window)
lib/ollama.js        streaming Ollama client
lib/openai.js        OpenAI-compatible streaming client
lib/anthropic.js     Anthropic (Claude) Messages API client
lib/mcp.js           MCP client (stdio + HTTP)
lib/lsp.js           LSP client + diagnostics
lib/skills.js        SKILL.md loader
lib/web.js           webfetch / websearch
lib/snapshot.js      shadow-git snapshots
lib/procs.js         foreground/background process management (exit events, progress, job logs, interactive stdin)
lib/terminal.js      user terminal: run a shell command in the workdir, stream output over SSE
lib/wake.js          wakes the agent when a background process finishes
lib/serve-file.js    file downloads: Content-Length, Range/resume, build-output guard
public/              UI
vscode-extension/    dependency-free VS Code chat client (REST/SSE, no build step)
test/                unit + smoke tests (`npm test`, node --test)
```
