# Sidebar Message Flow

How the GStack Browser sidebar actually works. Read this before touching
sidepanel.js, background.js, content.js, server.ts sidebar endpoints,
or sidebar-agent.ts.

## Components

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────────┐
│  sidepanel.js   │────▶│ background.js│────▶│  server.ts   │────▶│sidebar-agent.ts│
│  (Chrome panel) │     │ (svc worker) │     │  (Bun HTTP)  │     │  (Bun process) │
└─────────────────┘     └──────────────┘     └─────────────┘     └────────────────┘
        ▲                                           │                      │
        │           polls /sidebar-chat             │    polls queue file   │
        └───────────────────────────────────────────┘                      │
                                                    ◀──────────────────────┘
                                                    POST /sidebar-agent/event
```

## Startup Timeline

```
T+0ms     CLI runs `$B connect`
            ├── Server starts on port 34567
            ├── Writes state to .gstack/browse.json (pid, port, token)
            ├── Launches headed Chromium with extension
            └── Clears sidebar-agent-queue.jsonl

T+500ms   sidebar-agent.ts spawned by CLI
            ├── Reads auth token from .gstack/browse.json
            ├── Creates queue file if missing
            ├── Sets lastLine = current line count
            └── Starts polling every 200ms

T+1-3s    Extension loads in Chromium
            ├── background.js: health poll every 1s (fast startup)
            │     └── GET /health → gets auth token
            ├── content.js: injects on welcome page
            │     └── Does NOT fire gstack-extension-ready (waits for sidebar)
            └── Side panel: may auto-open via chrome.sidePanel.open()

T+2-10s   Side panel connects
            ├── tryConnect() → asks background for port/token
            ├── Fallback: direct GET /health for token
            ├── updateConnection(url, token)
            │     ├── Starts chat polling (1s interval)
            │     ├── Starts tab polling (2s interval)
            │     ├── Connects SSE activity stream
            │     └── Sends { type: 'sidebarOpened' } to background
            └── background relays to content script → hides welcome arrow

T+10s+    Ready for messages
```

## Message Flow: User Types → Claude Responds

```
1. User types "go to hn" in sidebar, hits Enter

2. sidepanel.js sendMessage()
   ├── Renders user bubble immediately (optimistic)
   ├── Renders thinking dots immediately
   ├── Switches to fast poll (300ms)
   └── chrome.runtime.sendMessage({ type: 'sidebar-command', message, tabId })

3. background.js
   ├── Gets active Chrome tab URL
   └── POST /sidebar-command { message, activeTabUrl }
       with Authorization: Bearer ${authToken}

4. server.ts /sidebar-command handler
   ├── validateAuth(req)
   ├── syncActiveTabByUrl(extensionUrl) — syncs Playwright tab to Chrome tab
   ├── pickSidebarModel(message) — 'sonnet' for actions, 'opus' for analysis
   ├── Adds user message to chat buffer
   ├── Builds system prompt + args
   └── Appends JSON to ~/.gstack/sidebar-agent-queue.jsonl

5. sidebar-agent.ts poll() (within 200ms)
   ├── Reads new line from queue file
   ├── Parses JSON entry
   ├── Checks processingTabs — skips if tab already has agent running
   └── askClaude(entry) — fire and forget

6. sidebar-agent.ts askClaude()
   ├── spawn('claude', ['-p', prompt, '--model', model, ...])
   ├── Streams stdout line-by-line (stream-json format)
   ├── For each event: POST /sidebar-agent/event { type, tool, text, tabId }
   └── On close: POST /sidebar-agent/event { type: 'agent_done' }

7. server.ts processAgentEvent()
   ├── Adds entry to chat buffer (in-memory + disk)
   ├── On agent_done: sets tab status to 'idle'
   └── On agent_done: processes next queued message for that tab

8. sidepanel.js pollChat() (every 300ms during fast poll)
   ├── GET /sidebar-chat?after=${chatLineCount}&tabId=${tabId}
   ├── Renders new entries (text, tool_use, agent_done)
   └── On agent idle: removes thinking dots, stops fast poll
```

## Arrow Hint Hide Flow (4-step signal chain)

The welcome page shows a right-pointing arrow until the sidebar opens.

```
1. sidepanel.js updateConnection()
   └── chrome.runtime.sendMessage({ type: 'sidebarOpened' })

2. background.js
   └── chrome.tabs.sendMessage(activeTabId, { type: 'sidebarOpened' })

3. content.js onMessage handler
   └── document.dispatchEvent(new CustomEvent('gstack-extension-ready'))

4. welcome.html script
   └── addEventListener('gstack-extension-ready', () => arrow.classList.add('hidden'))
```

The arrow does NOT hide when the extension loads. Only when the sidebar connects.

## Auth Token Flow

```
Server starts → AUTH_TOKEN = crypto.randomUUID()
    │
    ├── GET /health (no auth) → returns { token: AUTH_TOKEN }
    │
    ├── background.js checkHealth() → authToken = data.token
    │     └── Refreshes on EVERY health poll (fixes stale token on restart)
    │
    ├── sidepanel.js tryConnect() → serverToken from background or /health
    │     └── Used for chat polling: Authorization: Bearer ${serverToken}
    │
    └── sidebar-agent.ts refreshToken() → reads from .gstack/browse.json
          └── Used for event relay: Authorization: Bearer ${authToken}
```

If the server restarts, all three components get fresh tokens within 10s
(background health poll interval).

## Model Routing

`pickSidebarModel(message)` in server.ts classifies messages:

| Pattern | Model | Why |
|---------|-------|-----|
| "click @e24", "go to hn", "screenshot" | sonnet | Deterministic tool calls, no thinking needed |
| "what does this page say?", "summarize" | opus | Needs comprehension |
| "find bugs", "check for broken links" | opus | Analysis task |
| "navigate to X and fill the form" | sonnet | Action-oriented, no analysis words |

Analysis words (`what`, `why`, `how`, `summarize`, `describe`, `analyze`, `read X and Y`)
always override action verbs and force opus.

## Known Failure Modes

| Failure | Symptom | Root Cause | Fix |
|---------|---------|------------|-----|
| Stale auth token | "Unauthorized" in input | Server restarted, background had old token | background.js refreshes token on every health poll |
| Tab ID mismatch | Message sent, no response visible | Server assigned tabId 1, sidebar polling tabId 0 | switchChatTab preserves optimistic UI during switch |
| Sidebar agent not running | Messages queue forever | Agent process failed to spawn or crashed | Check `ps aux | grep sidebar-agent` |
| Agent stale token | Agent runs but no events appear in sidebar | sidebar-agent has old token from .gstack/browse.json | Agent re-reads token before each event POST |
| Queue file missing | spawnClaude fails | Race between server start and agent start | Both sides create file if missing |
| Optimistic UI blown away | User bubble + dots vanish | switchChatTab replaced DOM with welcome screen | Preserved DOM when lastOptimisticMsg is set |

## Per-Tab Concurrency

Each browser tab can run its own agent simultaneously:

- Server: `tabAgents: Map<number, TabAgentState>` with per-tab queue (max 5)
- sidebar-agent: `processingTabs: Set<number>` prevents duplicate spawns
- Two messages on same tab: queued sequentially, processed in order
- Two messages on different tabs: run concurrently

## File Locations

| Component | File | Runs in |
|-----------|------|---------|
| Sidebar UI | `extension/sidepanel.js` | Chrome side panel |
| Service worker | `extension/background.js` | Chrome background |
| Content script | `extension/content.js` | Page context |
| Welcome page | `browse/src/welcome.html` | Page context |
| HTTP server | `browse/src/server.ts` | Bun (compiled binary) |
| Agent process | `browse/src/sidebar-agent.ts` | Bun (non-compiled, can spawn) |
| CLI entry | `browse/src/cli.ts` | Bun (compiled binary) |
| Queue file | `~/.gstack/sidebar-agent-queue.jsonl` | Filesystem |
| State file | `.gstack/browse.json` | Filesystem |
| Chat log | `~/.gstack/sessions/<id>/chat.jsonl` | Filesystem |

## Terminal flow

The sidebar has a second primary tab next to Chat: **Terminal**. Where Chat
spawns one-shot `claude -p` per message, Terminal runs **interactive
`claude` in a real PTY** with xterm.js as the renderer.

### Components

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────────┐
│ sidepanel.js +  │────▶│  server.ts   │────▶│terminal-agent.ts │
│  -terminal.js   │     │  (compiled)  │     │  (non-compiled)  │
│  (xterm.js)     │     │              │     │  PTY listener    │
└─────────────────┘     └──────────────┘     └──────────────────┘
        ▲                       │                      │
        │  ws://127.0.0.1:<termPort>/ws (cookie auth)   │ Bun.spawn(claude)
        └───────────────────────┼──────────────────────▶│ terminal: {data}
                                │                      ▼
                                │              ┌──────────────────┐
                                │              │  claude PTY      │
                                │              └──────────────────┘
            POST /pty-session   │
            (Bearer AUTH_TOKEN) │
                                ▼
                       ┌──────────────────┐
                       │ pty-session-     │
                       │ cookie.ts        │
                       │ (HttpOnly cookie)│
                       └──────────────────┘
                                │
                                │ POST /internal/grant (loopback)
                                ▼
                       ┌──────────────────┐
                       │  validTokens Set │
                       │  in agent memory │
                       └──────────────────┘
```

### Startup + first-key timeline

```
T+0ms     CLI runs `$B connect`
            ├── Server starts (compiled)
            └── Spawns terminal-agent.ts via `bun run`

T+500ms   terminal-agent.ts boots
            ├── Bun.serve on 127.0.0.1:0 (random port)
            ├── Writes <stateDir>/terminal-port (server reads it for /health)
            ├── Writes <stateDir>/terminal-internal-token (loopback handshake)
            └── Probes claude → writes claude-available.json

T+1-3s    Extension loads, sidebar opens
            ├── Terminal tab is default-active
            ├── sidepanel-terminal.js: setState(IDLE), shows "Press any key"
            └── No PTY spawned yet (lazy)

T+user-keys  First keystroke fires onAnyKey
            ├── POST /pty-session (Authorization: Bearer AUTH_TOKEN)
            │   └── server mints cookie, posts /internal/grant to agent
            │   └── responds with Set-Cookie: gstack_pty=<HttpOnly>
            │   └── responds with terminalPort
            ├── GET /claude-available (preflight)
            ├── new WebSocket(ws://127.0.0.1:<terminalPort>/ws)
            │   └── Browser carries gstack_pty cookie + Origin automatically
            │   └── Agent validates Origin AND cookie BEFORE upgrading
            ├── On upgrade success, send {type:"resize"} then a single byte
            └── Agent message handler sees first byte → spawnClaude()
```

### Dual-token model

| Token | Lives in | Used for | Lifetime |
|-------|----------|----------|----------|
| `AUTH_TOKEN` | `<stateDir>/browse.json`; in-memory in server.ts | `/pty-session` POST (mint cookie) | server lifetime |
| `gstack_pty` cookie | Browser HttpOnly jar; agent `validTokens` Set | `/ws` upgrade auth | 30 min, dies on WS close |
| `INTERNAL_TOKEN` | `<stateDir>/terminal-internal-token`; in agent memory | server → agent loopback `/internal/grant` | agent lifetime |

`AUTH_TOKEN` is **never** valid for `/ws` directly. The cookie is **never**
valid for `/pty-session` or `/command`. Strict separation prevents an SSE
or sidebar-chat token leak from escalating into shell access.

### Threat model

The Terminal tab **bypasses the entire prompt-injection security stack**
(`content-security.ts` datamarking, `security-classifier.ts` ML scoring,
canary detection, ensemble verdicts). On the Terminal tab the user is
typing directly to claude — there is no untrusted page content in the
loop, so the threat model is "user trusts themselves," same as opening
a terminal locally.

That trust assumption is load-bearing on three transport-layer guarantees:

1. **Local-only listener.** `terminal-agent.ts` binds `127.0.0.1` only.
   The dual-listener tunnel surface (server.ts:95 `TUNNEL_PATHS`) does
   **not** include `/pty-session` or `/terminal/*`, so the tunnel returns
   404 by default-deny.
2. **Origin gate.** `/ws` upgrades require
   `Origin: chrome-extension://<id>`. A localhost web page cannot mount a
   cross-site WebSocket hijack against the shell because its Origin is
   a regular `http(s)://...`.
3. **Cookie auth.** `gstack_pty` is HttpOnly + SameSite=Strict, scoped to
   the local listener, minted only by an authenticated `/pty-session`
   POST. JS injected into a page can't read it; cross-site requests
   can't send it.

Drop any of those three and the whole tab becomes unsafe.

### Lifecycle

- **Lazy spawn**: claude is not started until the user types a key. Idle
  sidebar opens cost nothing.
- **One PTY per WS**: closing the WebSocket SIGINTs claude, then SIGKILLs
  after 3s. The `gstack_pty` cookie is also revoked so a stolen cookie
  can't be replayed against a new PTY.
- **No auto-reconnect**: when the WS closes the user sees "Session ended,
  click to start a new session." Auto-reconnect would burn a fresh
  claude session every reload. v1.1 may add session resumption keyed on
  tab/session id (see TODOS).

### Files

| Component | File | Runs in |
|-----------|------|---------|
| Terminal UI | `extension/sidepanel-terminal.js` + xterm.js in `extension/lib/` | Chrome side panel |
| PTY agent | `browse/src/terminal-agent.ts` | Bun (non-compiled, can spawn) |
| Cookie store | `browse/src/pty-session-cookie.ts` | Bun (compiled, in server.ts) |
| Port file | `<stateDir>/terminal-port` | Filesystem |
| Internal token | `<stateDir>/terminal-internal-token` | Filesystem |
| Claude probe | `<stateDir>/claude-available.json` | Filesystem |
| Active tab | `<stateDir>/active-tab.json` | Filesystem (claude reads) |
