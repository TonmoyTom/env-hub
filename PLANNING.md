# envhub: Planning

Working document. Update it when a decision changes, and add a date next to the change.

## Vision

A free, open source desktop app that runs a whole local development environment in Docker, without typing a command.
Stacks: Laravel, NestJS, Next.js, Vue, Nuxt, and any Docker Hub image (Python, Go, Rust, Java, Ruby, Node...).
Services: MySQL, PostgreSQL, MongoDB, Redis, phpMyAdmin, Adminer, Mailpit, and any extra Docker Hub image.

## Key decisions

| Area | Decision | Why |
|---|---|---|
| App framework | Electron (JavaScript) | Team knows JavaScript; Docker libraries exist for Node. Tauri later if RAM becomes a problem. |
| Runtime | Docker only | One engine means one set of bugs. |
| Config source of truth | envhub app data folder | User never edits compose files by hand. |
| Network default | Bind to 127.0.0.1 | Safe by default. LAN sharing is opt-in per project. |
| Admin tools | Not exposed to LAN by default | Database and mail UIs carry more risk. |
| License | MIT | Simple and common for developer tools. |

## Phases

Status on 2026-11-09. The detail of how each part works is in HANDOVER.md.

Done
- Foundation: Electron app, secure window, allowlisted IPC.
- Docker check, compose engine, ports (always unique), start/stop/restart/logs, live status.
- New project wizard: name, setup, create with progress and live logs.
- "Install a fresh app" (official generators for Laravel, Next.js, NestJS, Vue, Nuxt).
- Existing project: open a folder you already have (git clone) for any stack or language.
- Docker image stack: Python, Go, Rust, Java, Ruby, Node, with a starter app and optional "keep installed packages" volume.
- Databases with credentials, data kept in volumes, extra services with data volumes.
- Projects folder can be chosen. Windows installer (choose install folder, licence, shortcuts, picture).
- Application menu: File, Tools > Sync (1, 2, 3), Help > Planning.

Next (in this order)
1. Check everything in the real window (GUI) and fix what the click-through finds. Most parts were checked in code and on real Docker, but not all in the window.
2. Update: "Check for updates" (needs a GitHub repo and releases, then `electron-updater`).
3. Code signing for the installer (Windows SmartScreen warns without it).
4. Mac and Linux builds (dmg, AppImage, deb) with GitHub Actions. Linux file ownership is already handled in code, untested on Linux.
5. Modern UI redesign (see below).
6. More: Docker Compose projects as imports, PHP without Laravel, .NET, a git clone button, backup and restore of database data.

## Decision log

- 2026-11-05: Electron (JavaScript), Docker only, MIT license, Laravel first.
- 2026-11-09: "Install a fresh app" is a question in Setup (Yes = official generator, no placeholder; No = placeholder). node_modules for Node stacks lives in a Docker volume, with a "Packages for editor" button. Details are in HANDOVER.md section 5.
- 2026-11-09: Projects folder is a user setting (File > Projects folder...), earlier folders are remembered, imported projects are never deleted by envhub.
- 2026-11-09: Application menu added. Planning (this file) and the handover notes open from Help. Tools > Sync has three parts: (1) export and import the project list as a file, without passwords, (2) refresh the Docker state, (3) refresh the PHP/Node/database version lists from Docker Hub.
- 2026-11-09: Update checking is planned, but not built: it needs a GitHub repo for releases.

## Planned: modern UI redesign (not started, do it after the features are stable)

The current UI is plain and works, but it is not modern. The redesign is planned for later. Do not start it until the user says so.
Rule for now: new features must keep UI code separate and simple (small functions, no new inline styles), so the redesign is a re-skin and not a rewrite.

Goals:
- A modern, clean look, light and dark theme (follow the system, with a switch).
- A sidebar (Projects, New project, Settings) instead of one long page, and a project card grid with status, stack icon, port and one-click Open.
- A project detail page with tabs: Overview, Services, Logs, Credentials & .env, Settings. The row full of buttons goes away.
- Create wizard as a clear stepper with big stack cards (logo, name) instead of a drop down, and the "install the app now?" choice as two cards.
- Live status without reloads (containers:changed already exists), toasts for results instead of the status line, empty and error states, loading skeletons.
- Keyboard and screen reader support (focus, labels, contrast), responsive for small windows.

How (suggested order):
1. Design first: pick a design system (plain CSS variables and a small component set, no framework, to keep "no bundler"). Sketch the screens (Projects, New project, Project detail, Settings) and get the user's approval.
2. Move the CSS to tokens (colors, spacing, radius, font) in `renderer/styles.css`, then rebuild the components (button, card, badge, tabs, toast, modal).
3. Split `renderer/app.js` (about 1800 lines) into modules under `renderer/views/` (one per screen) before changing the layout, because the current single file makes a redesign risky.
4. Rebuild screens one by one behind the same `window.envhub` API. No main process change should be needed.
5. Check each screen in headless Chromium with the mocked `window.envhub`, then on real Electron.

Risks: `app.js` is large and tightly tied to element ids in `index.html`, so splitting it comes first. Keep the allowlisted IPC unchanged.
