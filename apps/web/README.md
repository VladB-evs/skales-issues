# Skales v3.0.0

**Local AI that runs on your machine. No Docker. No YAML. No cloud.**

Skales is a self-hosted AI assistant with a full web dashboard. It runs as a Node.js server on your computer and connects to your choice of AI provider — OpenRouter, Ollama, or any OpenAI-compatible API.

---

## What's New in v3.0.0

| Feature | Description |
|---|---|
| 🦁 Lio AI | Autonomous code-generation agent — scaffolds, writes files, runs commands |
| 🌐 Browser Control | Playwright-powered web browsing, scraping, and form filling |
| 👁️ Vision Provider | Screenshot tool + vision model analysis, Telegram forwarding |
| 🔄 Auto-Update | Dashboard banner + `/update` page with live download progress |
| 👥 Group Chat | Multi-AI discussion with multiple models in one conversation |
| 🧠 Memory | Persistent memory layer across sessions |
| 🤖 Agents | Sub-agent orchestration for complex multi-step tasks |
| 🔒 Killswitch | Emergency stop for any running operation |

---

## Getting Started

### Requirements

- Node.js 18+
- npm or pnpm

### Run (Development)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Run (Production)

```bash
npm run build
npm run start
```

Or use the included `start-dashboard.bat` (Windows) / `start-dashboard.command` (macOS).

---

## Project Structure

```
apps/
  web/          # Next.js 14 dashboard (this package)
  installer/    # Electron installer app
packages/
  core/         # Shared utilities
```

---

## Configuration

All configuration is done through the dashboard UI at `/settings`. No `.env` files needed.

Key settings:

- **AI Provider** — OpenRouter API key, Ollama URL, or custom OpenAI-compatible endpoint
- **Vision Provider** — Separate provider for vision/screenshot analysis
- **Telegram** — Bot token + paired chat ID for notifications and forwarding
- **Email** — SMTP/IMAP credentials for email send/receive
- **Skills** — Enable/disable individual capabilities (Browser Control, Lio AI, Group Chat, etc.)

---

## Skills

Skills are optional capability modules that can be toggled on/off from the `/skills` page:

| Skill | Description |
|---|---|
| `browser_control` | Playwright browser automation |
| `lio_ai` | Code Builder agent |
| `group_chat` | Multi-model conversations |
| `email` | SMTP/IMAP email |
| `discord` | Discord bot |
| `google_calendar` | Google Calendar API |
| `webhooks` | Zapier/n8n webhooks |

---

## License

Business Source License 1.1 (BSL 1.1) — © Mario Simic

See `LICENSE` for full terms.
