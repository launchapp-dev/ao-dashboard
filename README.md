# AO Dashboard

A desktop fleet monitoring app for [AO](https://github.com/andretcrs/ao) — the agent orchestrator CLI. Built with Tauri 2, React, and Rust.

Visualize daemon health, streaming events, active workflows, and task progress across all your AO-managed projects in real time.

## Features

- **Fleet Overview** — God's eye view with health status, agent counts, task distribution charts, and per-project drill-down
- **Flow View** — React Flow graph showing project → workflow → phase topology
- **Event Stream** — Real-time log viewer with filtering by level, project, and text search
- **Project Detail** — Sidebar filtering by workflow, model, and active run with live log streaming
- **Phased Loading** — Projects load instantly, health in parallel, workflows/tasks in background
- **Persistent Cache** — Workflows and task data cached via tauri-plugin-store for instant startup

## Requirements

- [AO CLI](https://github.com/andretcrs/ao) installed at `~/.local/bin/ao`
- At least one AO project with a running daemon
- Rust toolchain (for building Tauri)
- Node.js + pnpm

## Getting Started

```sh
pnpm install
pnpm tauri dev
```

## Build

```sh
pnpm tauri build
```

## How It Works

The Rust backend discovers AO projects from `~/.ao/`, runs `ao daemon health` and `ao daemon stream --json` for each, and emits structured events to the React frontend via Tauri's IPC.

## Stack

- **Frontend**: React 19, Recharts, React Flow (@xyflow/react), TypeScript
- **Backend**: Tauri 2, Rust, tokio (parallel CLI execution with timeouts)
- **Persistence**: tauri-plugin-store

## License

MIT
