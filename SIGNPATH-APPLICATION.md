# SignPath Foundation application

Submitted through https://signpath.org/apply. Notes for later (resubmitting, or setting up signing after approval).

## Project

- **Project name:** ProjectDockHub
- **Repository URL:** https://github.com/TonmoyTom/env-hub
- **Homepage URL:** https://github.com/TonmoyTom/env-hub/releases/tag/v0.0.2
- **Download URL:** https://github.com/TonmoyTom/env-hub#code-signing-policy
- **Privacy Policy URL:** https://github.com/TonmoyTom/env-hub#privacy
- **Wikipedia URL:** none
- **License:** MIT
- **Maintainer type:** Individual
- **Build system:** GitHub Actions (`.github/workflows/build.yml`)

## Tagline

Create and manage Docker-based development projects from one desktop app.

## Description

ProjectDockHub is an open source desktop app (Electron) that creates and manages Docker-based development projects. You pick a stack, it generates the Docker Compose setup, and you start, stop and open projects from one window. It runs locally, has no accounts and no telemetry, and only talks to Docker on your machine and to Docker Hub.

## Reputation

New open source project, first public release v0.0.2. Source, tests and CI are public on GitHub. Usage numbers are still small.

## Requirements checklist

- [x] OSI license (MIT, `LICENSE`)
- [x] Public repository
- [x] Automated build in CI
- [x] "Code signing policy" section with SignPath attribution in `README.md`
- [x] Privacy statement in `README.md`
- [x] Released: v0.0.2
- [ ] Two-factor authentication on GitHub
- [ ] Release description mentions: "Free code signing provided by SignPath.io, certificate by SignPath Foundation."

## After approval

1. Create the SignPath project, then add the SignPath GitHub Action to `.github/workflows/build.yml` for the Windows build.
2. Keep the product name metadata set to `ProjectDockHub` and the version the same in each build.
3. Each release needs a manual approval before signing.
4. Update the "not code signed yet" note in `README.md` once signed builds are out.
