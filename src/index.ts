#!/usr/bin/env node
import { getCurrentConfig, loadConfig } from './config.ts';
import { logEvent, startDiagnosticsServer, setDiscordChannels, setRestartHandler, setRefreshChannelsHandler } from './server.ts';
import { createWindsorBot, checkScheduledTasks } from './bot.ts';
import { ChannelType } from 'discord.js';
import type { WindsorConfig } from './types.ts';

const { config } = await loadConfig();

startDiagnosticsServer(config.diagnosticsPort);

let bot: ReturnType<typeof createWindsorBot> | null = null;
let startInFlight = false;

async function startBot(cfg: WindsorConfig): Promise<void> {
    if (startInFlight) return;
    if (!cfg.discordToken) {
        logEvent('info', 'No Discord token configured. Visit the control panel to set up.');
        return;
    }

    startInFlight = true;
    const nextBot = createWindsorBot();
    try {
        await nextBot.start(cfg.discordToken);
        bot = nextBot;

        await refreshChannels();

        logEvent('startup', 'Bot started successfully');
    } catch (err) {
        logEvent('error', `Failed to start bot: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        startInFlight = false;
    }
}

export async function restartBot(): Promise<void> {
    logEvent('info', 'Restarting bot…');
    if (bot) {
        bot.destroy();
        bot = null;
    }
    setDiscordChannels([]);
    const { config } = await loadConfig();
    await startBot(config);
}

// Recurring task checker
setInterval(() => {
    checkScheduledTasks();
}, 30_000);

setRestartHandler(restartBot);

async function refreshChannels(): Promise<void> {
    if (!bot) {
        logEvent('info', 'Cannot refresh channels: bot not connected');
        return;
    }
    logEvent('info', 'Refreshing Discord channels…');
    const serverId = getCurrentConfig().serverId;
    const guilds = serverId
        ? [bot.getClient().guilds.cache.get(serverId)].filter((guild): guild is NonNullable<typeof guild> => guild !== undefined)
        : [...bot.getClient().guilds.cache.values()];
    if (serverId && guilds.length === 0) {
        throw new Error(`Configured serverId ${serverId} not found`);
    }

    const channels: Array<{ id: string; name: string }> = [];
    for (const guild of guilds) {
        const fetched = await guild.channels.fetch();
        for (const ch of fetched.values()) {
            if (
                ch?.isTextBased() &&
                'name' in ch &&
                ch.type !== ChannelType.GuildVoice &&
                ch.type !== ChannelType.GuildStageVoice
            ) {
                channels.push({ id: ch.id, name: (ch as { name: string }).name });
            }
        }
    }
    setDiscordChannels(channels);
    logEvent('info', `Refreshed ${channels.length} Discord channels`);
}

setRefreshChannelsHandler(refreshChannels);
await startBot(config);
