# pi-config

Personal configuration and extensions for [pi](https://github.com/mariozechner/pi-coding-agent), a terminal-based AI coding agent.

## Usage

**Auto-load all extensions via `settings.json`** by adding this directory to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/code/pi-config/extensions"]
}
```

Every `.ts` file in the directory is picked up automatically on startup — no symlinking or per-file flags needed.

**Load a single extension ad-hoc:**

```sh
pi -e ~/code/pi-config/extensions/notify.ts
```
