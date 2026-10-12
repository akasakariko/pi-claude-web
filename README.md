# pi-claude-web

> A [Pi Coding Agent](https://pi.dev) provider extension that unlocks **Claude Web Free Tier** models directly from your local browser sessions, featuring a multi-browser account pool, automatic rate-limit failover, and full local tool execution.

---

## ✨ Features

- **No API Key Required**: Directly leverages active sessions from your daily browsers (**Firefox** and **Safari**).
- **Free Models Supported**:
  - `claude-web/claude-sonnet-5-5`: Deep reasoning, coding, and architecture analysis.
  - `claude-web/claude-haiku-5-5`: Lightning-fast, lightweight daily assistance.
- **Multi-Browser Account Pool**:
  - **Firefox**: Auto-detects profiles and **Multi-Account Containers** via safe, lock-free SQLite snapshots.
  - **Safari**: Natively parses macOS `Cookies.binarycookies` with zero external dependencies.
  - **Custom Accounts**: Supports optional manual accounts via JSON configuration.
- **Smart Pooling & Load Balancing**:
  - **Round-Robin (Default)**: Alternates turns across all healthy accounts to balance usage and maximize uptime.
  - **Failover Mode**: Automatically falls back to the next healthy account if one hits a 429 or 5-hour quota limit.
- **Full Native Tool Calling**:
  - Allows Claude to read, write, and edit local files on your computer and execute bash commands via Pi's built-in toolchain (`write`, `edit`, `read`, `bash`).
  - Transparent tool-aliasing automatically bridges Claude's internal tool conventions to Pi.
- **Native Extended Thinking / Reasoning**:
  - 100% unified with Pi's standard thinking controls (`:off`, `:low`, `:medium`, `:high`, or `--thinking`).
- **Clean Sidebar Guarantee**:
  - Ephemeral chat conversations are automatically deleted on `claude.ai` after execution, keeping your web UI tidy and organized.
- **Proxy Friendly**:
  - Automatically respects standard proxy environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`) and injects matching client headers to bypass Cloudflare challenges.

---

## 🚀 Installation

### Option 1: Direct Extension (Recommended)

Simply clone or copy `index.ts` into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/akasakariko/pi-claude-web/main/index.ts -o ~/.pi/agent/extensions/claude-web.ts
```

Pi automatically loads any TypeScript files located in `~/.pi/agent/extensions/` on startup.

### Option 2: Pi Package Manager

Install via the Pi CLI:

```bash
pi install git:github.com/akasakariko/pi-claude-web
```

---

## 🛠️ Usage

### Quick Start

Launch Pi directly with Claude Web models:

```bash
# Use Sonnet 5.5
pi --model claude-web/claude-sonnet-5-5

# Use Haiku 5.5 for instant answers
pi --model claude-web/claude-haiku-5-5

# Quick prompt execution
pi --model claude-web/claude-sonnet-5-5 -p "Analyze this repository and write a test suite"
```

### Thinking / Reasoning Levels

Uses standard Pi thinking level controls without needing custom subcommands:

```bash
# High reasoning effort
pi --model claude-web/claude-sonnet-5-5:high

# Medium reasoning effort
pi --model claude-web/claude-sonnet-5-5:medium

# Disable thinking (standard response)
pi --model claude-web/claude-sonnet-5-5:off

# Or use Pi's standard CLI flag
pi --model claude-web/claude-sonnet-5-5 --thinking medium
```

Inside an interactive Pi session, switch models and thinking levels anytime:
```text
/model claude-web/claude-sonnet-5-5:medium
/thinking high
```

---

## 🏊 Account Pool Management

Manage your browser accounts and pooling strategies with the built-in `/claude-web` command:

| Command | Description |
| :--- | :--- |
| `/claude-web` | Display pool status, account health, requests handled, and active mode |
| `/claude-web mode round-robin` | Switch strategy to **Round-Robin** (balances load across all accounts) |
| `/claude-web mode failover` | Switch strategy to **Failover** (sticks to active account; swaps on quota limit) |
| `/claude-web switch <index\|name>` | Manually designate the primary active account |
| `/claude-web reload` | Re-scan and refresh browser cookies from disk |

### Example Status Output

```text
🏊 Claude Web Account Pool (2 Accounts Available):
[1] ✅ Ready Firefox (user@example.com) [Active] (Handled 12 requests)
[2] ✅ Ready Safari (user2@example.com) (Handled 8 requests)

Current Strategy: 🔄 Round-Robin
Available Commands: /claude-web mode <round-robin|failover>, /claude-web switch <index>, /claude-web reload
```

---

## 🌐 Multiple Accounts in a Single Browser

You can configure multiple accounts inside the **same browser**:

1. **Firefox Multi-Account Containers** *(Recommended)*:
   - Install the official [Firefox Multi-Account Containers](https://addons.mozilla.org/en-US/firefox/addon/multi-account-containers/) extension.
   - Open new container tabs (e.g. *Personal*, *Work*, or custom named *Claude-2*).
   - Log into different Claude accounts in each container.
   - `pi-claude-web` automatically recognizes each container's isolated cookie store!
2. **Firefox Profiles**:
   - Create additional profiles via `about:profiles`.
   - Each profile is automatically scanned and pooled.
3. **Custom Account File**:
   - Place any additional accounts in `~/.pi/agent/claude-web-accounts.json`:
     ```json
     [
       {
         "name": "Custom Account 1",
         "sessionKey": "sk-ant-sid02-..."
       }
     ]
     ```

---

## 🔒 Privacy & Architecture

1. **Local Cookie Ingestion**:
   - All session credentials stay strictly on your local machine.
   - SQLite cookies are read via temporary snapshots to ensure zero file locks on your active browser.
2. **Lifecycle Cleanup**:
   - Temporary conversations created for reasoning and tool generation are automatically purged via `DELETE` requests once the turn completes.
3. **No External Network Dependencies**:
   - Communicates directly with official `claude.ai` APIs using your local proxy configuration.

---

## 📄 License

[MIT License](LICENSE) © 2026 KayanoLiam
