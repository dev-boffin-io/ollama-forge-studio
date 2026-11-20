# Ollama Forge Studio for VS Code

A dependency-free VS Code extension (VS Code 1.82+) for chatting with the local Ollama Forge Studio server. It uses
the studio's existing REST + SSE API, so agent runs, tools, permissions, background processes, hooks, plugins and the
Docker sandbox all behave exactly as they do in the browser UI.

## Features

- `Ollama Studio: Open Chat` is available from the editor top bar and Command Palette; it opens or reveals the chat beside
  the editor.
- An **Ollama Studio** icon in the right side of the status bar opens the same chat, like Copilot.
- An **Ollama Studio** activity-bar container adds a **Chats** navigator and a compact **Chat** view in the left sidebar.
- The chat header and the Chats navigator both switch between chats in the current folder; changing folders clears the
  active chat so chats from another folder are not reused.
- The last focused text file is shown in the chat header and attached automatically; click the file chip or run
  `Ollama Studio: Attach/Detach Active File` to toggle it. The selected lines (or the cursor line) are sent as context
  with each message.
- Agent and model pickers populated from the running server.
- Streaming tokens, thinking output, tool calls/results and subagent events.
- Permission prompts (once / always / reject) and agent questions inside VS Code.
- `Ollama Studio: Send Selection to Chat` (also in the editor context menu) inserts the current selection or line as a
  fenced code block into every open chat view.
- Starts `server.js` automatically if no studio is running, and stops only the server it started.

## Run from this repository

1. Open the repository in VS Code.
2. Press `F5` (Run Extension). A second VS Code window opens with the extension loaded.
3. Use the Ollama Studio icon in the status bar or editor top bar, or run `Ollama Studio: Open Chat` from the Command Palette.
4. Open the **Ollama Studio** icon in the activity bar to use the sidebar Chat and Chats views.

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

Then reload VS Code, use the editor top-bar chat icon, and open the Ollama Studio activity-bar view for the sidebar
navigator.
