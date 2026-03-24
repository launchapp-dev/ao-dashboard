<div align="center">

![header](https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,50:161b22,100:1f6feb&height=200&section=header&text=AO%20Dashboard&fontSize=70&fontColor=f0f6fc&animation=fadeIn&fontAlignY=35&desc=Fleet%20Monitoring%20for%20the%20Agent%20Orchestrator&descAlignY=55&descSize=20&descColor=8b949e)

<br/>

[![Typing SVG](https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=500&size=18&duration=3000&pause=1500&color=58A6FF&center=true&vCenter=true&multiline=true&repeat=true&random=false&width=600&height=60&lines=Visualize+your+AO+fleet+in+real+time.;Stream+daemon+logs%2C+workflows%2C+and+agent+activity.)](https://github.com/launchapp-dev/ao-dashboard)

<br/>

<a href="https://github.com/launchapp-dev/ao"><img src="https://img.shields.io/badge/AO_CLI-required-1f6feb?style=for-the-badge&labelColor=0d1117&logo=github&logoColor=f0f6fc" alt="AO CLI" /></a>
&nbsp;
<img src="https://img.shields.io/badge/Tauri_2-Rust_+_React-f0f6fc?style=for-the-badge&labelColor=0d1117&logo=tauri&logoColor=f0f6fc" alt="Tauri" />
&nbsp;
<img src="https://img.shields.io/badge/macOS%20%7C%20Linux%20%7C%20Windows-f0f6fc?style=for-the-badge&labelColor=0d1117&logo=apple&logoColor=f0f6fc" alt="Platforms" />
&nbsp;
<img src="https://img.shields.io/github/license/launchapp-dev/ao-dashboard?style=for-the-badge&labelColor=0d1117&color=1f6feb" alt="License" />

</div>

<br/>

## What is AO Dashboard?

A desktop app that gives you a god's-eye view of your [AO](https://github.com/launchapp-dev/ao) fleet. See every daemon, every workflow, every agent — streaming in real time.

```
┌─────────────────────────────────────────────────────────────────┐
│  AO Fleet                        4 running  12 agents  3 queued│
│  [Overview]  [Flow]  [Stream]                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │ nextjs      │  │ nuxt        │  │ sveltekit   │            │
│  │ ● running   │  │ ● running   │  │ ● running   │            │
│  │ agents 3/5  │  │ agents 4/5  │  │ agents 2/5  │            │
│  │ queue  6    │  │ queue  3    │  │ queue  1    │            │
│  │ ▓▓▓▓░░ 60% │  │ ▓▓▓▓▓░ 80% │  │ ▓▓░░░░ 40% │            │
│  │ → scaffold  │  │ → triage    │  │ → review    │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│                                                                 │
│  DAEMON STATUS        TASK DISTRIBUTION                         │
│  ┌───────┐           ┌──────────────────────┐                  │
│  │ ●●●●  │           │ ▓▓▓▓▓▓▓▓░░░░░░░░░░ │                  │
│  │  4/4  │           │ done ready backlog   │                  │
│  └───────┘           └──────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Features

- **Fleet Overview** — Health status, agent counts, task distribution charts, per-project drill-down
- **Flow View** — React Flow graph of project → workflow → phase topology
- **Event Stream** — Real-time log viewer with level/project/text filtering
- **Project Detail** — Filter logs by workflow, model, or active run with live streaming
- **Phased Loading** — Projects instant, health in parallel, workflows/tasks in background
- **Persistent Cache** — Workflow and task data cached for instant startup

---

## Prerequisites

- [AO CLI](https://github.com/launchapp-dev/ao) installed at `~/.local/bin/ao`
- At least one AO project with a running daemon
- Rust toolchain
- Node.js + pnpm

## Getting Started

```bash
git clone https://github.com/launchapp-dev/ao-dashboard.git
cd ao-dashboard
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build
```

---

## How It Works

```
~/.ao/*                    ao daemon health         ao daemon stream --json
   │                            │                          │
   ▼                            ▼                          ▼
┌──────────┐            ┌──────────────┐           ┌──────────────┐
│ Discover │            │  Health Poll │           │  Event Stream│
│ Projects │            │  (parallel)  │           │  (per proj)  │
└────┬─────┘            └──────┬───────┘           └──────┬───────┘
     │                         │                          │
     └─────────────────────────┼──────────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │   React Frontend    │
                    │   Overview │ Flow   │
                    │   Stream  │ Detail  │
                    └─────────────────────┘
```

The Rust backend discovers AO projects from `~/.ao/`, runs `ao daemon health` and `ao daemon stream --json` for each project in parallel, and emits structured events to the React frontend via Tauri IPC.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Recharts, React Flow |
| Backend | Tauri 2, Rust, tokio |
| Persistence | tauri-plugin-store |
| Data Source | AO CLI (`ao daemon health`, `ao daemon stream`) |

---

## License

MIT — see [LICENSE](LICENSE)
