# Ollama Forge Studio for VS Code

A dependency-free VS Code extension (VS Code 1.82+) for chatting with the local Ollama Forge Studio server. It uses
the studio's existing REST + SSE API, so agent runs, tools, permissions, background processes, hooks, plugins and the
Docker sandbox all behave exactly as they do in the browser UI.

## Features

- Chat panel beside the editor (`Ollama Studio: Open Chat`).
- Agent and model pickers populated from the running server.
- Streaming tokens, thinking output, tool calls/results and subagent events.
- Permission prompts (once / always / reject) and agent questions inside VS Code.
- `Ollama Studio: Send Selection to Chat` (also in the editor context menu) inserts the current selection or line as a
  fenced code block.
- Starts `server.js` automatically if no studio is running, and stops only the server it started.

## Run from this repository

1. Open the repository in VS Code.
2. Press `F5` (Run Extension). A second VS Code window opens with the extension loaded.
3. Run `Ollama Studio: Open Chat` from the Command Palette.

The extension looks for `../server.js` next to the extension folder. If you use the single-file executable instead, set
`ollamaStudio.serverPath` to that executable.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `ollamaStudio.serverUrl` | `http://127.0.0.1:4310` | Existing studio server URL. |
| `ollamaStudio.autoStart` | `true` | Start the server if the health check fails. |
| `ollamaStudio.serverPath` | `""` | `server.js` or the single-file executable. Empty = `../server.js`. |
| `ollamaStudio.nodePath` | `node` | Node executable used for `server.js`. |

The extension asks the server for `/api/health`, `/api/state`, `/api/models`, `/api/config`, `/api/sessions`,
`/api/chat` (SSE), `/api/permission` and `/api/answer`. It never reads project files directly; all file access goes
through the studio and therefore through the configured permissions, hooks and sandbox.

## Packaging

The folder is a complete VS Code extension (no build step). To install it locally:

```sh
ln -s "$PWD/vscode-extension" "$HOME/.vscode/extensions/ollama-forge-studio-0.1.0"
```

Then reload VS Code and run `Ollama Studio: Open Chat`.
