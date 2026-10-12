function mapToolName(name: string, availableTools?: { name: string }[]): string {
  if (availableTools?.some(t => t.name === name)) return name;
  const lower = name.toLowerCase();
  if (lower === "bash_tool" || lower === "bash") return "bash";
  if (lower === "write_file" || lower === "write" || lower === "create_file") return "write";
  if (lower === "read_file" || lower === "view" || lower === "read") return "read";
  if (lower === "str_replace_editor" || lower === "edit_file" || lower === "edit") return "edit";
  const matched = availableTools?.find(t => t.name.toLowerCase() === lower);
  return matched?.name ?? name;
}

/**
 * Claude Web Extension for Pi (Multi-Account Pool Edition)
 *
 * 自动聚合 Firefox 和 Safari 等浏览器的 Claude Web 免费端会话，构建多账号高可用池。
 * 
 * 核心特性：
 * 1. 自动检测多浏览器多账号：
 *    - Firefox profiles (通过 node:sqlite 安全读取 cookies.sqlite)
 *    - Safari (通过纯 JS 解析 Cookies.binarycookies)
 *    - 可选自定义账号配置文件 (~/.pi/agent/claude-web-accounts.json)
 * 2. 智能容灾与无缝轮换 (Failover & Rotation)：
 *    - 当某个账号遇到 429 / 5小时使用限额时，自动切换到池中下一个健康账号重试，保障开发不中断！
 *    - 精准记录各账号冷却重置时间，冷却结束后自动恢复就绪。
 * 3. 免费双模型支持：
 *    - claude-web/claude-sonnet-5-5 (Sonnet 5.5 Free)
 *    - claude-web/claude-haiku-5-5 (Haiku 5.5 Free 极速)
 * 4. 自动清理：
 *    - 推理完成后自动在对应账号后台删除临时会话，不污染网页侧边栏。
 * 5. 管理指令：
 *    - /claude-web 查看多号池状态、配额与健康度
 *    - /claude-web switch <id> 手动切换活动账号
 *    - /claude-web reload 重新扫描浏览器凭据
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentTools,
  type ToolCall,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// 加载 Pi 内置的 undici 以支持代理分发
let undiciProxyAgent: any;
let undiciFetch: typeof fetch;

try {
  const undici = require("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js");
  undiciProxyAgent = undici.ProxyAgent;
  undiciFetch = undici.fetch;
} catch {
  undiciFetch = globalThis.fetch;
}

export interface ClaudeAccount {
  id: string;
  browser: "Firefox" | "Safari" | "Custom";
  profileName: string;
  displayName: string;
  cookieHeader: string;
  userAgent: string;
  orgUuid?: string;
  orgName?: string;
  rateLimitedUntil: number; // 0 表示健康
  cooldownReason?: string;
  requestsHandled: number;
}

/**
 * 纯 JS 解析 Apple Safari binarycookies 文件
 */
function parseBinaryCookies(buf: Buffer): { url: string; name: string; value: string }[] {
  if (buf.length < 8) return [];
  if (buf.toString("utf8", 0, 4) !== "cook") return [];

  const numPages = buf.readUInt32BE(4);
  const pageSizes: number[] = [];
  for (let i = 0; i < numPages; i++) {
    pageSizes.push(buf.readUInt32BE(8 + i * 4));
  }

  let pos = 8 + numPages * 4;
  const cookies: { url: string; name: string; value: string }[] = [];

  for (const size of pageSizes) {
    if (pos + size > buf.length) break;
    const page = buf.subarray(pos, pos + size);
    pos += size;

    if (page.length < 8) continue;
    const numCookies = page.readUInt32LE(4);

    const offsets: number[] = [];
    for (let i = 0; i < numCookies; i++) {
      if (8 + i * 4 + 4 > page.length) break;
      offsets.push(page.readUInt32LE(8 + i * 4));
    }

    for (const offset of offsets) {
      if (offset + 32 > page.length) continue;
      const c = page.subarray(offset);
      const urlOff = c.readUInt32LE(16);
      const nameOff = c.readUInt32LE(20);
      const valOff = c.readUInt32LE(28);

      function readCString(start: number) {
        if (start >= c.length) return "";
        let end = start;
        while (end < c.length && c[end] !== 0) end++;
        return c.toString("utf8", start, end);
      }

      cookies.push({
        url: readCString(urlOff),
        name: readCString(nameOff),
        value: readCString(valOff),
      });
    }
  }

  return cookies;
}

/**
 * 扫描 Firefox 目录提取 Claude Cookie
 */
function scanFirefoxAccounts(): ClaudeAccount[] {
  const home = os.homedir();
  const searchDirs = [
    path.join(home, "Library/Application Support/Firefox/Profiles"),
    path.join(home, ".mozilla/firefox"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "Mozilla/Firefox/Profiles") : null,
  ].filter(Boolean) as string[];

  const accounts: ClaudeAccount[] = [];

  for (const base of searchDirs) {
    if (!fs.existsSync(base)) continue;
    try {
      const entries = fs.readdirSync(base);
      for (const entry of entries) {
        const full = path.join(base, entry);
        const cookieFile = path.join(full, "cookies.sqlite");
        if (fs.existsSync(cookieFile)) {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ff-acc-"));
          try {
            const dest = path.join(tempDir, "cookies.sqlite");
            fs.copyFileSync(cookieFile, dest);
            for (const ext of ["-wal", "-shm"]) {
              if (fs.existsSync(cookieFile + ext)) {
                try { fs.copyFileSync(cookieFile + ext, dest + ext); } catch {}
              }
            }
            const db = new DatabaseSync(dest, { readOnly: true });
            const rows = db.prepare("SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%'").all() as { name: string; value: string }[];
            db.close();

            const cookieMap: Record<string, string> = {};
            for (const r of rows) cookieMap[r.name] = r.value;

            if (cookieMap["sessionKey"]) {
              const header = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; ");
              const email = cookieMap["__Host-claude-ai-pending-login-email"];
              const org = cookieMap["lastActiveOrg"];
              accounts.push({
                id: `firefox:${entry}`,
                browser: "Firefox",
                profileName: entry,
                displayName: `Firefox (${email ? decodeURIComponent(email) : entry})`,
                cookieHeader: header,
                userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0",
                orgUuid: org,
                rateLimitedUntil: 0,
                requestsHandled: 0,
              });
            }
          } finally {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          }
        }
      }
    } catch {}
  }

  return accounts;
}

/**
 * 扫描 Safari 提取 Claude Cookie
 */
function scanSafariAccounts(): ClaudeAccount[] {
  const home = os.homedir();
  const safariPaths = [
    path.join(home, "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"),
    path.join(home, "Library/Cookies/Cookies.binarycookies"),
  ];

  const accounts: ClaudeAccount[] = [];

  for (const sp of safariPaths) {
    if (!fs.existsSync(sp)) continue;
    try {
      const buf = fs.readFileSync(sp);
      const all = parseBinaryCookies(buf);
      const claude = all.filter(c => c.url.includes("claude.ai"));
      const map: Record<string, string> = {};
      for (const c of claude) map[c.name] = c.value;

      if (map["sessionKey"]) {
        const header = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
        const email = map["__Host-claude-ai-pending-login-email"];
        const org = map["lastActiveOrg"];
        accounts.push({
          id: "safari",
          browser: "Safari",
          profileName: "Default",
          displayName: `Safari (${email ? decodeURIComponent(email) : "Default"})`,
          cookieHeader: header,
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
          orgUuid: org,
          rateLimitedUntil: 0,
          requestsHandled: 0,
        });
        break; // 只要找到一个主 Safari 就够了
      }
    } catch {}
  }

  return accounts;
}

/**
 * 扫描自定义配置文件 (~/.pi/agent/claude-web-accounts.json)
 */
function scanCustomAccounts(): ClaudeAccount[] {
  const customFile = path.join(os.homedir(), ".pi/agent/claude-web-accounts.json");
  if (!fs.existsSync(customFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(customFile, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.map((item, idx) => ({
      id: item.id || `custom:${idx + 1}`,
      browser: "Custom" as const,
      profileName: item.name || `Custom ${idx + 1}`,
      displayName: item.name || `Custom ${idx + 1}`,
      cookieHeader: item.cookie || item.cookieHeader || `sessionKey=${item.sessionKey}`,
      userAgent: item.userAgent || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0",
      orgUuid: item.orgUuid,
      rateLimitedUntil: 0,
      requestsHandled: 0,
    }));
  } catch {
    return [];
  }
}

/**
 * 多号池管理类
 */
class ClaudeAccountPool {
  accounts: ClaudeAccount[] = [];
  activeIndex = -1; // -1 表示第一次轮询从 0 开始
  strategy: "round-robin" | "failover" = "round-robin"; // 默认采用轮询模式 (Round-Robin)，请求均摊

  constructor() {
    this.refresh();
  }

  refresh() {
    const existingStats = new Map(this.accounts.map(a => [a.id, {
      orgName: a.orgName,
      orgUuid: a.orgUuid,
      rateLimitedUntil: a.rateLimitedUntil,
      cooldownReason: a.cooldownReason,
      requestsHandled: a.requestsHandled,
    }]));

    const discovered = [
      ...scanFirefoxAccounts(),
      ...scanSafariAccounts(),
      ...scanCustomAccounts(),
    ];

    for (const acc of discovered) {
      const prev = existingStats.get(acc.id);
      if (prev) {
        if (prev.orgName) acc.orgName = prev.orgName;
        if (prev.orgUuid && !acc.orgUuid) acc.orgUuid = prev.orgUuid;
        acc.rateLimitedUntil = prev.rateLimitedUntil;
        acc.cooldownReason = prev.cooldownReason;
        acc.requestsHandled = prev.requestsHandled;
      }
    }

    this.accounts = discovered;
    if (this.activeIndex >= this.accounts.length) {
      this.activeIndex = 0;
    }
  }

  getDispatcher() {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    if (proxyUrl && undiciProxyAgent) {
      return new undiciProxyAgent({ uri: proxyUrl, allowH2: false });
    }
    return undefined;
  }

  getHeaders(acc: ClaudeAccount, accept = "application/json"): HeadersInit {
    return {
      "User-Agent": acc.userAgent,
      "Accept": accept,
      "Accept-Language": "en-US,en;q=0.5",
      "Referer": "https://claude.ai/new",
      "anthropic-client-version": "1.0.0",
      "Content-Type": "application/json",
      "Cookie": acc.cookieHeader,
    };
  }

  async ensureOrg(acc: ClaudeAccount): Promise<string> {
    if (acc.orgUuid && acc.orgName) return acc.orgUuid;
    const dispatcher = this.getDispatcher();
    try {
      const res = await undiciFetch("https://claude.ai/api/organizations", {
        headers: this.getHeaders(acc),
        dispatcher,
      });
      if (res.ok) {
        const orgs = await res.json() as { uuid: string; name: string }[];
        if (Array.isArray(orgs) && orgs.length > 0) {
          acc.orgUuid = orgs[0].uuid;
          acc.orgName = orgs[0].name;
          return acc.orgUuid;
        }
      }
    } catch {}
    if (acc.orgUuid) return acc.orgUuid;
    throw new Error(`无法获取账号 [${acc.displayName}] 的组织信息，请确认该账号未掉登且网络通畅。`);
  }

  /**
   * 挑选可用账号：
   * - round-robin: 每次请求轮流切换到下一个未冷却的健康账号（均摊压力与配额）
   * - failover: 锁定当前活动账号，只有遇到限额或失败才切换下一个
   */
  getAvailableAccount(excludeIds: Set<string> = new Set(), isRetry = false): ClaudeAccount | null {
    const now = Date.now();
    if (this.accounts.length === 0) return null;

    if (this.strategy === "round-robin" && !isRetry) {
      // 轮询模式：从当前位置的下一个开始找
      for (let i = 1; i <= this.accounts.length; i++) {
        const idx = (this.activeIndex + i + this.accounts.length) % this.accounts.length;
        const candidate = this.accounts[idx];
        if (!excludeIds.has(candidate.id) && now >= candidate.rateLimitedUntil) {
          this.activeIndex = idx;
          return candidate;
        }
      }
    } else {
      // failover 模式或重试时：优先检查当前账号
      if (this.activeIndex >= 0 && this.activeIndex < this.accounts.length) {
        const current = this.accounts[this.activeIndex];
        if (current && !excludeIds.has(current.id) && now >= current.rateLimitedUntil) {
          return current;
        }
      }
      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (Math.max(0, this.activeIndex) + i) % this.accounts.length;
        const candidate = this.accounts[idx];
        if (!excludeIds.has(candidate.id) && now >= candidate.rateLimitedUntil) {
          this.activeIndex = idx;
          return candidate;
        }
      }
    }

    // 自动兜底：若所有账号都在冷却中，则挑选冷却剩余时间最短的账号尝试，避免全池完全瘫痪
    let bestCandidate: ClaudeAccount | null = null;
    let minCooldown = Infinity;
    for (const a of this.accounts) {
      if (!excludeIds.has(a.id) && a.rateLimitedUntil < minCooldown) {
        minCooldown = a.rateLimitedUntil;
        bestCandidate = a;
      }
    }
    return bestCandidate;
  }

  markRateLimited(acc: ClaudeAccount, resetsAt?: number, reason = "使用频次达限") {
    // 默认短冷却 60 秒即可恢复重试；仅当有官方 resets_at 且不超过 5 小时时采用真实解冻时间
    let cooldownMs = 60000;
    if (resetsAt && typeof resetsAt === "number") {
      const targetMs = resetsAt > 1e11 ? resetsAt : resetsAt * 1000;
      const diff = targetMs - Date.now();
      if (diff > 0 && diff < 5 * 3600 * 1000) {
        cooldownMs = diff;
      }
    }
    acc.rateLimitedUntil = Date.now() + cooldownMs;
    acc.cooldownReason = reason;
  }
}

export const accountPool = new ClaudeAccountPool();

function formatMessagesToPrompt(messages: Message[]): string {
  const lines: string[] = [];
  const systemNotice = [
    "[System Environment Notice]",
    "You are an AI coding assistant operating inside Pi on the user's local macOS computer.",
    "You have real local execution capabilities via tools: write, edit, read, bash.",
    "- When asked to create, write, or modify files (including Desktop, project files, scripts), ALWAYS call the appropriate tool ('write' or 'bash') directly.",
    "- NEVER claim you are in an isolated cloud sandbox without filesystem access. You have full access to call local tools to perform real file and shell operations.",
    "- NEVER tell the user to manually download files when you can write them directly to their computer.",
  ].join("\n");

  lines.push(systemNotice);

  for (const msg of messages) {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map(b => {
          if (b.type === "text") return b.text;
          if (b.type === "thinking") return b.thinking;
          if (b.type === "toolCall") return `[Tool Call: ${b.name}(${JSON.stringify(b.arguments)})]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    if (!text.trim()) continue;

    if (msg.role === "system") {
      lines.push(`[System Instructions]\n${text.trim()}\n`);
    } else if (msg.role === "user") {
      lines.push(`User: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      lines.push(`Assistant: ${text.trim()}`);
    } else if (msg.role === "toolResult") {
      lines.push(`[Tool Result]:\n${text.trim()}\n(Tool execution finished. Based on this tool result, please provide your answer to the user.)`);
    }
  }

  return lines.join("\n\n");
}

function streamClaudeWeb(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const transcript = collapseSystemMessages(context);

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      const prompt = formatMessagesToPrompt(transcript.messages);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

      // 提取思考强度
      const effortMap: Record<string, string> = {
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      };

      // 提取 Pi 本地工具 (write, read, edit, bash 等)
      const rawTools = getCurrentTools(transcript.messages);
      const tools = rawTools && rawTools.length > 0
        ? rawTools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: {
              type: "object",
              properties: (t.parameters as any)?.properties || {},
              required: (t.parameters as any)?.required || [],
            }
          }))
        : undefined;

      const compBody: Record<string, any> = {
        prompt,
        timezone,
        model: model.id,
        rendering_mode: "messages",
      };

      if (tools && tools.length > 0) {
        compBody.tools = tools;
      }

      if (options?.reasoning && options.reasoning !== "off") {
        compBody.thinking_mode = "extended";
        compBody.effort = effortMap[options.reasoning] || "medium";
      }

      if (options?.onPayload) {
        options.onPayload(compBody);
      }

      const triedAccounts = new Set<string>();
      let startedStream = false;

      while (true) {
        const isRetry = triedAccounts.size > 0;
        const acc = accountPool.getAvailableAccount(triedAccounts, isRetry);

        if (!acc) {
          // 安全报错，绝不抛出未捕获异常退出进程！
          const now = Date.now();
          const earliest = accountPool.accounts.reduce((min, a) => Math.min(min, a.rateLimitedUntil), Infinity);
          const waitSeconds = earliest === Infinity ? 60 : Math.max(1, Math.ceil((earliest - now) / 1000));
          output.stopReason = "error";
          output.errorMessage = `[Claude Web] 多号池中所有账号（共 ${accountPool.accounts.length} 个）暂时在冷却中，约 ${waitSeconds} 秒后重试。您也可执行 /claude-web reset 立即解除冷却。`;
          stream.push({ type: "error", error: output });
          return;
        }

        triedAccounts.add(acc.id);
        let convUuid: string | null = null;
        let orgUuid: string | null = null;

        try {
          orgUuid = await accountPool.ensureOrg(acc);
          convUuid = crypto.randomUUID();
          const dispatcher = accountPool.getDispatcher();

          // 创建临时会话
          const createRes = await undiciFetch(`https://claude.ai/api/organizations/${orgUuid}/chat_conversations`, {
            method: "POST",
            headers: accountPool.getHeaders(acc),
            body: JSON.stringify({ uuid: convUuid, name: "" }),
            dispatcher,
            signal: options?.signal,
          });

          if (!createRes.ok) {
            const status = createRes.status;
            const errText = await createRes.text();
            if (status === 429 || errText.includes("rate_limit")) {
              accountPool.markRateLimited(acc, undefined, "创建会话触发 429 限额");
              continue; // 切换下一个账号重试
            }
            throw new Error(`[${acc.displayName}] 创建会话失败 (${status}): ${errText}`);
          }

          // 发起流式请求
          const compRes = await undiciFetch(`https://claude.ai/api/organizations/${orgUuid}/chat_conversations/${convUuid}/completion`, {
            method: "POST",
            headers: accountPool.getHeaders(acc, "text/event-stream"),
            body: JSON.stringify(compBody),
            dispatcher,
            signal: options?.signal,
          });

          if (!compRes.ok) {
            const status = compRes.status;
            const errText = await compRes.text();
            if (status === 429 || errText.includes("rate_limit") || errText.includes("resets_at")) {
              accountPool.markRateLimited(acc, undefined, "推理请求触发 429 限额");
              continue; // 切换下一个账号重试
            }
            throw new Error(`[${acc.displayName}] 推理请求失败 (${status}): ${errText}`);
          }

          if (options?.onResponse) {
            options.onResponse(compRes);
          }

          if (!startedStream) {
            stream.push({ type: "start", partial: output });
            startedStream = true;
          }

          const bodyReader = compRes.body?.getReader();
          if (!bodyReader) throw new Error("响应数据流为空");

          const decoder = new TextDecoder();
          let buffer = "";
          type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
          const blocks = output.content as Block[];
          let receivedTokens = false;

          while (true) {
            const { done, value } = await bodyReader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw) continue;

              let event: any;
              try { event = JSON.parse(raw); } catch { continue; }

              if (options?.onProviderStreamEvent) {
                await options.onProviderStreamEvent(event, model);
              }

              // 监听配额限制事件
              if (event.type === "message_limit") {
                const lim = event.message_limit;
                if (lim?.type === "exceeded" || lim?.windows?.["5h"]?.status === "exceeded") {
                  const resetsAt = lim?.windows?.["5h"]?.resets_at;
                  accountPool.markRateLimited(acc, resetsAt, "5小时使用配额耗尽");
                }
              } else if (event.type === "message_start") {
                if (event.message?.model) output.model = event.message.model;
              } else if (event.type === "content_block_start") {
                const blockType = event.content_block?.type;
                if (blockType === "text") {
                  output.content.push({ type: "text", text: "", index: event.index } as any);
                  stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
                } else if (blockType === "thinking") {
                  output.content.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index } as any);
                  stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                } else if (blockType === "tool_use") {
                  output.content.push({
                    type: "toolCall",
                    id: event.content_block.id,
                    name: mapToolName(event.content_block.name, rawTools),
                    arguments: {},
                    partialJson: "",
                    index: event.index,
                  } as any);
                  stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
                }
              } else if (event.type === "content_block_delta") {
                const index = blocks.findIndex(b => b.index === event.index);
                const block = blocks[index];
                if (!block) continue;
                receivedTokens = true;

                if (event.delta?.type === "text_delta" && block.type === "text") {
                  block.text += event.delta.text;
                  stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
                } else if (block.type === "thinking") {
                  let deltaText = "";
                  if (event.delta?.type === "thinking_delta") {
                    deltaText = event.delta.thinking || "";
                  } else if (event.delta?.type === "thinking_summary_delta") {
                    const s = event.delta.summary;
                    deltaText = typeof s === "string" ? s : s?.summary || "";
                    if (deltaText && block.thinking) deltaText = "\n" + deltaText;
                  }
                  if (deltaText) {
                    block.thinking += deltaText;
                    stream.push({ type: "thinking_delta", contentIndex: index, delta: deltaText, partial: output });
                  }
                } else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
                  (block as any).partialJson += event.delta.partial_json;
                  try {
                    block.arguments = JSON.parse((block as any).partialJson);
                  } catch {}
                  stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
                }
              } else if (event.type === "content_block_stop") {
                const index = blocks.findIndex(b => b.index === event.index);
                const block = blocks[index];
                if (!block) continue;
                delete (block as any).index;

                if (block.type === "text") {
                  stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
                } else if (block.type === "thinking") {
                  stream.push({ type: "thinking_end", contentIndex: index, thinking: block.thinking, partial: output });
                } else if (block.type === "toolCall") {
                  try {
                    block.arguments = JSON.parse((block as any).partialJson);
                  } catch {}
                  delete (block as any).partialJson;
                  stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
                  output.stopReason = "toolUse";
                  try { await bodyReader.cancel(); } catch {}
                  break;
                }
              } else if (event.type === "message_delta") {
                const reason = event.delta?.stop_reason;
                if (reason === "end_turn" || reason === "stop_sequence") {
                  output.stopReason = "stop";
                } else if (reason === "max_tokens") {
                  output.stopReason = "length";
                } else if (reason === "tool_use") {
                  output.stopReason = "toolUse";
                } else {
                  output.stopReason = "stop";
                }
              } else if (event.type === "message_stop") {
                if (output.stopReason === "pending") output.stopReason = "stop";
                let totalChars = 0;
                for (const b of output.content) {
                  if (b.type === "text") totalChars += b.text.length;
                  if (b.type === "thinking") totalChars += b.thinking.length;
                }
                output.usage.output = Math.ceil(totalChars / 4);
                output.usage.input = Math.ceil(prompt.length / 4);
                output.usage.totalTokens = output.usage.input + output.usage.output;
                calculateCost(model, output.usage);

                acc.requestsHandled++;
                stream.push({ type: "done", reason: output.stopReason, message: output });
              }
            }

            if (output.stopReason === "toolUse") {
              break; // 立即跳出 while 读取循环！
            }
          }

          if (output.stopReason === "toolUse") {
            acc.requestsHandled++;
            let totalChars = 0;
            for (const b of output.content) {
              if (b.type === "text") totalChars += b.text.length;
              if (b.type === "thinking") totalChars += b.thinking.length;
            }
            output.usage.output = Math.ceil(totalChars / 4) + 20;
            output.usage.input = Math.ceil(prompt.length / 4);
            output.usage.totalTokens = output.usage.input + output.usage.output;
            calculateCost(model, output.usage);

            stream.push({ type: "done", reason: "toolUse", message: output });
          } else if (output.stopReason === "pending") {
            output.stopReason = "stop";
            acc.requestsHandled++;
            stream.push({ type: "done", reason: output.stopReason, message: output });
          }

          // 成功完成本次请求，退出重试循环
          break;
        } catch (err: any) {
          if (options?.signal?.aborted) {
            output.stopReason = "aborted";
            stream.push({ type: "done", reason: "aborted", message: output });
            break;
          }

          const msg = err?.message || String(err);
          // 若在数据流开始前报错且属于限额或网络异常，记录短冷却并换下一个账号
          if (!startedStream && (msg.includes("429") || msg.includes("rate_limit") || msg.includes("overage"))) {
            accountPool.markRateLimited(acc, undefined, "调用异常触发限额");
            continue;
          }

          output.stopReason = "error";
          output.errorMessage = msg;
          stream.push({ type: "error", error: output });
          break;
        } finally {
          // 清理当前会话
          if (convUuid && orgUuid) {
            const dispatcher = accountPool.getDispatcher();
            undiciFetch(`https://claude.ai/api/organizations/${orgUuid}/chat_conversations/${convUuid}`, {
              method: "DELETE",
              headers: accountPool.getHeaders(acc),
              dispatcher,
            }).catch(() => {});
          }
        }
      }
    } catch (topErr: any) {
      // 顶级异常兜底，严禁触发 uncaughtException 导致 Pi 退出！
      output.stopReason = "error";
      output.errorMessage = topErr?.message || String(topErr);
      stream.push({ type: "error", error: output });
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  // 注册 Provider 与模型
  pi.registerProvider("claude-web", {
    baseUrl: "https://claude.ai",
    apiKey: "multi-account-pool",
    api: "claude-web-api",
    models: [
      {
        id: "claude-sonnet-5-5",
        name: "Claude Web Sonnet 5.5 (Free)",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "claude-haiku-5-5",
        name: "Claude Web Haiku 5.5 (Free - 极速)",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      }
    ],
    streamSimple: streamClaudeWeb,
  });

  // 注册多号池指令 /claude-web
  pi.registerCommand("claude-web", {
    description: "管理 Claude Web 多号池 (status | switch | reload)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const action = parts[0]?.toLowerCase() || "status";

      if (action === "reload") {
        accountPool.refresh();
        ctx.ui.notify(`已刷新多号池，当前检测到 ${accountPool.accounts.length} 个账号`, "info");
        return;
      }

      if (action === "switch") {
        const target = parts[1];
        if (!target) {
          ctx.ui.notify("用法: /claude-web switch <序号或关键词>", "warning");
          return;
        }
        const num = parseInt(target, 10);
        let foundIdx = -1;
        if (!isNaN(num) && num >= 1 && num <= accountPool.accounts.length) {
          foundIdx = num - 1;
        } else {
          foundIdx = accountPool.accounts.findIndex(a =>
            a.id.toLowerCase().includes(target.toLowerCase()) ||
            a.displayName.toLowerCase().includes(target.toLowerCase())
          );
        }

        if (foundIdx === -1) {
          ctx.ui.notify(`未找到匹配账号: ${target}`, "error");
          return;
        }

        accountPool.activeIndex = foundIdx;
        const switched = accountPool.accounts[foundIdx];
        ctx.ui.notify(`已切换活动账号为: [${foundIdx + 1}] ${switched.displayName}`, "info");
        return;
      }

      // 默认展示 status
      accountPool.refresh();
      if (accountPool.accounts.length === 0) {
        ctx.ui.notify("多号池未发现任何可用账号，请检查 Firefox 或 Safari 是否登录 claude.ai", "warning");
        return;
      }

      const now = Date.now();
      const lines = [
        `🏊 Claude Web 多号池状态 (共 ${accountPool.accounts.length} 个账号):`,
      ];

      for (let i = 0; i < accountPool.accounts.length; i++) {
        const a = accountPool.accounts[i];
        const isActive = i === accountPool.activeIndex;
        const isCooling = now < a.rateLimitedUntil;
        let statusBadge = "✅ 就绪";
        if (isCooling) {
          const remainMin = Math.ceil((a.rateLimitedUntil - now) / 60000);
          statusBadge = `⏳ 冷却中(${remainMin}m - ${a.cooldownReason || "限额"})`;
        }
        const activeBadge = isActive ? " [当前优先]" : "";
        const stats = `(已处理 ${a.requestsHandled} 次)`;
        lines.push(`[${i + 1}] ${statusBadge} ${a.displayName}${activeBadge} ${stats}`);
      }

      lines.push("");
      lines.push(`当前调度策略: ${accountPool.strategy === "round-robin" ? "🔄 轮询均摊 (Round-Robin)" : "🛡️ 主备容灾 (Failover)"}`);
            lines.push("可用指令: /claude-web mode <round-robin|failover>, /claude-web switch <序号>, /claude-web reset, /claude-web reload");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
