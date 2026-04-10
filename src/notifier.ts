import { logger } from './logger.js';
import type { Automation, ExecutionResult, NotifyChannels, NotifyCondition } from './types.js';

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_ERROR_CHARS = 2_000;
const TELEGRAM_MAX_CHARS = 4096;

export interface NotifierConfig {
  webhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  mattermostWebhookUrl?: string;
}

type ChannelName = 'webhook' | 'telegram' | 'mattermost';

export class Notifier {
  private config: NotifierConfig;

  constructor(config: NotifierConfig | string | undefined) {
    if (typeof config === 'string' || config === undefined) {
      this.config = { webhookUrl: config };
    } else {
      this.config = config;
    }
  }

  /**
   * Send notifications for an automation run.
   * Best-effort — never throws.
   */
  async notify(result: ExecutionResult, automation?: Automation): Promise<void> {
    const channels = this.resolveChannels(automation?.notify, result.success);
    if (channels.length === 0) return;

    const text = this.formatMessage(result);
    await Promise.all(channels.map((ch) => this.sendToChannel(ch, text)));
  }

  /**
   * Send a custom message to a specific channel or all configured channels.
   * Best-effort — never throws.
   */
  async sendMessage(message: string, channel?: ChannelName): Promise<void> {
    if (channel) {
      await this.sendToChannel(channel, message);
    } else {
      const channels = this.availableChannels();
      await Promise.all(channels.map((ch) => this.sendToChannel(ch, message)));
    }
  }

  /**
   * Determine which channels should receive a notification based on:
   * 1. Per-automation `notify` config
   * 2. Global availability (credentials present)
   */
  private resolveChannels(notify: Automation['notify'], success: boolean): ChannelName[] {
    // Explicit opt-out
    if (notify === false) return [];

    const available = this.availableChannels();
    if (available.length === 0) return [];

    // notify: true or undefined — send to all available channels
    if (notify === true || notify === undefined) return available;

    // notify is a NotifyChannels object — filter by per-channel config
    const channels: ChannelName[] = [];
    for (const ch of available) {
      const condition = (notify as NotifyChannels)[ch];
      if (this.matchesCondition(condition, success)) {
        channels.push(ch);
      }
    }
    return channels;
  }

  private matchesCondition(condition: NotifyCondition | undefined, success: boolean): boolean {
    if (condition === undefined || condition === false) return false;
    if (condition === true) return true;
    if (condition === 'on_failure') return !success;
    if (condition === 'on_success') return success;
    return false;
  }

  private availableChannels(): ChannelName[] {
    const channels: ChannelName[] = [];
    if (this.config.webhookUrl) channels.push('webhook');
    if (this.config.telegramBotToken && this.config.telegramChatId) channels.push('telegram');
    if (this.config.mattermostWebhookUrl) channels.push('mattermost');
    return channels;
  }

  private async sendToChannel(channel: ChannelName, text: string): Promise<void> {
    try {
      switch (channel) {
        case 'webhook':
          await this.sendWebhook(text);
          break;
        case 'telegram':
          await this.sendTelegram(text);
          break;
        case 'mattermost':
          await this.sendMattermost(text);
          break;
      }
    } catch (err) {
      logger.warn(
        { channel, error: err instanceof Error ? err.message : String(err) },
        'Notification send failed',
      );
    }
  }

  private async sendWebhook(text: string): Promise<void> {
    if (!this.config.webhookUrl) return;
    await this.postJson(this.config.webhookUrl, { text });
  }

  private async sendTelegram(text: string): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;
    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    const chunks = splitMessage(text, TELEGRAM_MAX_CHARS);
    for (const chunk of chunks) {
      await this.postJson(url, {
        chat_id: this.config.telegramChatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
    }
  }

  private async sendMattermost(text: string): Promise<void> {
    if (!this.config.mattermostWebhookUrl) return;
    await this.postJson(this.config.mattermostWebhookUrl, { text });
  }

  private async postJson(url: string, body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, url: url.replace(/bot[^/]+/, 'bot***') },
          'Notification POST returned non-OK status',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private formatMessage(result: ExecutionResult): string {
    const emoji = result.success ? '\u2705' : '\u274c';
    const durationSec = (result.durationMs / 1000).toFixed(1);
    const cost = result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : '-';

    const parts = [
      `${emoji} **${result.automationName}** — ${result.success ? 'OK' : 'FAILED'}`,
      `Duration: ${durationSec}s | Cost: ${cost} | Mode: ${result.mode}`,
    ];

    if (result.error) {
      parts.push(`Error: ${truncate(result.error, MAX_ERROR_CHARS)}`);
    }

    if (result.output) {
      parts.push(`Output: ${truncate(result.output, MAX_OUTPUT_CHARS)}`);
    }

    return parts.join('\n');
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

/** Split text into chunks that fit within maxLen, breaking at newlines. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find last newline within limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}
