# ProjectDockHub

A free, open source desktop app that runs your whole local development environment in Docker, managed from a simple GUI.
You do not need to type Docker or terminal commands.

Works on **Windows, macOS and Linux**.

## What it does

Create a project in three steps: **Name → Setup → Create**. ProjectDockHub pulls the images, builds what is needed, starts the containers and shows live progress and logs.

**Stacks**

| Stack | Notes |
|---|---|
| Laravel | nginx + PHP, optional Node/Vite |
| Next.js, NestJS, Vue, Nuxt | Node, with the official generator if you want a fresh app |
| Any Docker Hub image | Python, Go, Rust, Java, Ruby, Node and more |

**Services you can add with a tick box**

MySQL, PostgreSQL, MongoDB, Redis, phpMyAdmin, Adminer, Mailpit, and any extra image from Docker Hub.

**Features**

- Start, stop, restart and live status for every project
- Fresh app installs using the official generators (Laravel, Next.js, NestJS, Vue, Nuxt), or open a folder you already have
- Databases with their own user, name and password, data kept in Docker volumes
- One-click "Copy .env" for the app inside Docker or on your computer
- Ports are always unique, so projects do not clash
- Safe by default: everything is bound to `127.0.0.1`, LAN sharing is opt-in per project
- Export and import your project list (no passwords included)
- Runs in the system tray, one copy at a time
- Light and dark friendly window, works on small screens

## Install

Download the installer for your system from the [Releases](../../releases) page.

| System | File |
|---|---|
| Windows | `ProjectDockHub-Setup-x.y.z.exe` |
| macOS | `.dmg` (Intel and Apple Silicon) |
| Linux | `.AppImage` or `.deb` |

You also need **Docker**: [Docker Desktop](https://www.docker.com/products/docker-desktop/) on Windows and macOS, or Docker Engine on Linux. ProjectDockHub tells you if Docker is missing or not running.

### First start warnings

The installers are not code signed yet, so your system may warn you the first time. This is expected for new open source apps.

- **Windows:** "Windows protected your PC" → click **More info** → **Run anyway**.
- **macOS:** right-click the app → **Open**, or System Settings → Privacy & Security → **Open Anyway**.
- **Linux AppImage:** `chmod +x ProjectDockHub-*.AppImage`, then run it. For the `.deb`: `sudo apt install ./ProjectDockHub-*.deb`.

## Development

Requirements: Node.js 20 or 22, and Docker.

```bash
npm install
npm start        # run the app
npm test         # run the tests
```

Build installers:

```bash
npm run build:windows
npm run build:mac
npm run build:linux
```

Output goes to `dist/`. A GitHub Actions workflow (`.github/workflows/build.yml`) builds all three systems.
A Windows installer must be built on Windows, and a macOS `.dmg` on macOS.

More details are in [`PLANNING.md`](PLANNING.md) and [`HANDOVER.md`](HANDOVER.md).

## Privacy

ProjectDockHub runs locally. It has no accounts and no telemetry. It talks to Docker on your machine and to Docker Hub (to search images and list versions). Database passwords are stored on your computer only, in the app data folder.

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Windows releases are built from this repository by the GitHub Actions workflow in [`.github/workflows/build.yml`](.github/workflows/build.yml). Only binaries built from this source are signed.
- Every release needs a manual approval before it is signed.
- **Authors, reviewers and approvers:** the project maintainers, [TonmoyTom](https://github.com/TonmoyTom). Changes from other contributors are reviewed by a maintainer before they are merged.
- All team members use multi-factor authentication for GitHub and SignPath.
- **Privacy:** see [Privacy](#privacy) above. The signed app has no accounts and no telemetry. It only talks to Docker on your machine and to Docker Hub.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before you send a change. See [`SECURITY.md`](SECURITY.md) to report a security problem.

## License

MIT. See [`LICENSE`](LICENSE).
