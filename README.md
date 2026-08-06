# Pi Studio

Pi Studio is an independent Electron desktop client for the [Pi coding agent](https://github.com/earendil-works/pi). It brings Pi projects, threads, model configuration, extensions, permission controls, automation, and file previews into one desktop workspace.

Current release: `0.2.4` (Windows x64 installer).

> Pi Studio is an independent community project. It is not affiliated with or endorsed by the Pi maintainers.

## Features

- Manage local projects and Pi threads from a desktop sidebar.
- Chat with streaming responses and configurable model and thinking levels.
- Read and preview Markdown, HTML, source code, images, and common office documents.
- Configure providers and models through Pi's shared `models.json` configuration.
- Use Pi extensions and plugins from the shared Pi agent directory.
- Run scheduled automations with an explicit sandbox or full-access permission level.
- Keep a bundled Pi runtime and support app-managed runtime updates.
- Use a permission gate for shell commands, project boundaries, and extension actions.

## Download

Download the latest `Pi-Studio-Setup-<version>.exe` from GitHub Releases and install it on a Windows x64 machine. The installer is currently unsigned, so Windows SmartScreen may show a warning.

The release package contains a bundled Node.js runtime and Pi coding agent. You do not need a separate Node.js or Pi installation to run the installed application.

## Development requirements

- Windows x64 is the primary tested target.
- Node.js `22.19.0` or newer for development and packaging.
- npm.
- A global Pi coding agent installation is required by the packaging script:

```powershell
npm install -g @earendil-works/pi-coding-agent@0.82.1
```

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
npm run bundle            # Bundle Node.js and the Pi runtime
npm run dist              # Bundle, build, and create the installer
npm run pack              # Create an unpacked directory build
```

Build output is written to `release/`. The packaging script uses the Node.js executable running the command and the installed Pi coding agent, so use pinned versions when reproducible artifacts are required.

## Configuration and data

Pi Studio shares Pi's agent configuration under `~/.pi/agent`, including model, provider, authentication, and extension settings. The desktop application's own settings are stored in Electron's user data directory.

API keys are user data. Do not commit `auth.json`, `models.json`, session files, screenshots containing keys, or local configuration directories to this repository.

## Permissions and security

Pi can read and write project files and execute tools on the user's behalf. Pi Studio starts new threads in sandbox mode by default. Full access must be selected explicitly for a thread or automation task. These controls reduce accidental actions but do not replace operating-system isolation or user review.

Do not paste API keys or other secrets into public issues, pull requests, screenshots, or example files. For a security issue, contact the project maintainer privately through GitHub before public disclosure.

## Contributing

Bug reports and pull requests are welcome. Before submitting a change:

1. Keep changes focused and explain user-visible behavior.
2. Run `npm run typecheck`.
3. Run `npm run test:permission` when permission or tool execution code changes.
4. Do not include local data, generated bundles, installers, credentials, or QA browser profiles.

## Third-party software

Pi Studio uses Electron, React, Vite, Pi coding agent, Node.js, and other open-source packages. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the component inventory and license references.

## License

The Pi Studio source code is licensed under the [MIT License](LICENSE).

The Pi name, project name, logos, and other trademarks remain the property of their respective owners. The MIT license does not grant trademark rights.
