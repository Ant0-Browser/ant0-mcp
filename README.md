# Ant0 MCP

**Ant0 is a browser for automation and agents.** Each profile has its own saved identity, proxy, cookies and storage. This MCP server lets an AI agent pick or create a profile, run it, and work in its tabs.

> **Pre-release.** This bundle is built from Ant0 desktop 0.3.22-beta.2. It is a beta and may change.

- Website: https://ant0.link
- Docs: https://docs.ant0.link
- Registry name: `link.ant0/ant0`
- Licence: BSD-3-Clause

## What you need

The server does not run a browser by itself. It talks to the **Ant0 desktop app running on your computer**, so install and start Ant0 first (download at https://ant0.link). It uses the local connection and needs no account key for local use. Node.js 24 or newer is required to run it from source.

## Run it

### Against the Ant0 desktop app (recommended)

The Ant0 command line (`ant0`) starts this server:

```sh
ant0 mcp serve --stdio
```

Add that command to your MCP client. See https://docs.ant0.link for client examples.

### The .mcpb bundle

Download `ant0-<version>.mcpb` and `SHA256SUMS` from the Releases page, check the hash (and the signature, when the release carries one), and open the file in a client that supports MCP Bundles, such as Claude Desktop. Start the Ant0 app before using it.

### From source

```sh
pnpm install
pnpm build
node dist/bin.js serve --stdio            # or: pnpm exec ant0-mcp serve --stdio
```

Options: `--home <dir>` (the Ant0 data folder; default `$ANT0_HOME`, then the platform default), `--port <n>`, and `--credential-file <path>` (a private file holding a scoped API key; or set `ANT0_API_KEY`). A token file that others can read is refused.

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm bundle` (builds `out/ant0-<version>.mcpb` and `out/SHA256SUMS`).

## Tools

32 tools. Nine of them (read, run and stop) also work with a scoped API key. The rest need the local connection.

**Status**

- `ant0_daemon_status`, `ant0_licence_status`

**Profiles**

- `ant0_profiles_list`, `ant0_profile_detail`, `ant0_profile_status`, `ant0_sessions_list`
- `ant0_profile_run`, `ant0_profile_stop`
- `ant0_profile_create`, `ant0_profile_update`, `ant0_profile_duplicate`, `ant0_profile_delete`, `ant0_profile_restore`, `ant0_profile_identity`

**Proxies**

- `ant0_proxies_list`, `ant0_proxy_create`, `ant0_proxy_check`, `ant0_proxy_change_ip`

**Tabs and pages**

- `ant0_tabs`, `ant0_page_navigate`, `ant0_page_snapshot`, `ant0_page_text`, `ant0_page_screenshot`
- `ant0_page_click`, `ant0_page_type`, `ant0_page_fill_form`, `ant0_page_press_key`, `ant0_page_select`, `ant0_page_wait_for`

**Cookies and sessions**

- `ant0_cookies_export`, `ant0_cookies_import`, `ant0_session_cdp`

Tools do not return secrets. The one tool that returns a browser endpoint is `ant0_session_cdp`, which gives a local endpoint on purpose and needs the local connection. Anything read from a page or a profile is untrusted data, not instructions.

## Protocol

MCP 2026-07-28 and 2025-11-25 over stdio.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues are welcome; pull requests are reviewed by maintainers.

## Licence

BSD-3-Clause. See [LICENSE](LICENSE). Copyright (c) 2026 RENEWBYTE LABS LTD.
