# Omp Studio

Omp Studio is an independent Electron desktop client for [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp, a fork of the [Pi coding agent](https://github.com/earendil-works/pi)). It brings omp projects, threads, model configuration, extensions, permission controls, automation, and file previews into one desktop workspace.

Current release: `0.5.1` (Windows x64 and macOS arm64 installers).

> Omp Studio is an independent community project. It is not affiliated with or endorsed by the Pi or oh-my-pi maintainers.

## Features

- Manage local projects and threads from a desktop sidebar.
- Chat with streaming responses and configurable model and thinking levels.
- Read and preview Markdown, HTML, source code, images, and common office documents.
- Configure providers and models through omp's shared `models.yml` configuration.
- Use omp extensions and skills from the shared agent directory.
- Run scheduled automations with an explicit sandbox or full-access permission level.
- Keep a versioned omp runtime embedded in each installer and support app-managed runtime updates.
- Use a permission gate for shell commands, project boundaries, and extension actions.

## Screenshots

![Home and projects](guide-assets/01-home-and-projects.png)

## Download

Download the latest `Omp-Studio-Setup-<version>.exe` for Windows x64 or `Omp-Studio-<version>-arm64.dmg` for Apple Silicon macOS from GitHub Releases. The installers are currently unsigned, so Windows SmartScreen or macOS Gatekeeper may show a warning.

On macOS, after dragging the app into `/Applications`, clear the quarantine flag before first launch:

```bash
sudo xattr -cr /Applications/Omp\ Studio.app
```

Each installer contains a pinned native omp runtime binary. On first launch, Omp Studio verifies and copies that embedded runtime into the user data directory. Later app updates reuse the extracted runtime without any runtime download.

## Development requirements

- Windows x64 and macOS arm64 are the supported packaging targets.
- Node.js `24.14.0` or newer within the Node 24 major version for development and packaging.
- npm.
- No global Pi install is required: `npm run bundle` downloads the pinned oh-my-pi (`omp`) runtime binary from GitHub Releases (`ompRuntimeVersion` in `package.json`). A system `omp` install is only needed to run the app in dev without bundling.

## Development

```powershell
npm install
npm run typecheck
npm run test:permission
npm run dev
```

Useful commands:

```powershell
npm run build             # Build the Electron application
npm run bundle             # Build the runtime archive embedded by the installer
npm run dist              # Bundle, build, and create the installer
npm run pack              # Create an unpacked directory build
```

Build output is written to `release/`. `npm run dist` creates the Electron installer with the omp runtime binary embedded inside it; the generated binary in `release/` is retained for QA and does not need to be uploaded separately. The repository pins the omp runtime `17.2.11` in `package.json` (`ompRuntimeVersion`), and the packaging script verifies that version against the latest GitHub release before downloading. Set `OMP_RUNTIME_VERSION` to package a different pinned version.

## Configuration and data

Omp Studio shares the oh-my-pi agent configuration under `~/.omp/agent`, including model, provider, authentication, extension, and session settings. The desktop application's own settings are stored in Electron's user data directory.

API keys are user data. Do not commit `auth.json`, `models.json`, session files, screenshots containing keys, or local configuration directories to this repository.

## Permissions and security

omp can read and write project files and execute tools on the user's behalf. Omp Studio starts new threads in sandbox mode by default. Full access must be selected explicitly for a thread or automation task. These controls reduce accidental actions but do not replace operating-system isolation or user review.

Do not paste API keys or other secrets into public issues, pull requests, screenshots, or example files. For a security issue, contact the project maintainer privately through GitHub before public disclosure.

## Contributing

Bug reports and pull requests are welcome. Before submitting a change:

1. Keep changes focused and explain user-visible behavior.
2. Run `npm run typecheck`.
3. Run `npm run test:permission` when permission or tool execution code changes.
4. Do not include local data, generated bundles, installers, credentials, or QA browser profiles.

## Third-party software

Omp Studio uses Electron, React, Vite, oh-my-pi (omp), Node.js, and other open-source packages. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the component inventory and license references.

## License

The Omp Studio source code is licensed under the [MIT License](LICENSE).

The Pi name, project name, logos, and other trademarks remain the property of their respective owners. The MIT license does not grant trademark rights.
