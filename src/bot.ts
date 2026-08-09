import {
    ChannelType,
    Client,
    GatewayIntentBits,
    type Guild,
    type Message,
    type MessageReaction,
    type TextChannel,
} from 'discord.js';
import { formatScheduleDate, generateIcon, getNextOccurrence, parseRecurringSchedule } from './ai.ts';
import { Commands } from './commands/index.ts';
import { getCurrentConfig, reconcileChannels } from './config.ts';
import { formatTimestamp } from './printer.ts';
import { printJob, PrinterUnavailableError } from './printing/index.ts';
import { logEvent, status } from './server.ts';
import type {
    AccumulatingListConfig,
    ChannelBehaviorConfig,
    ImmediatePrintConfig,
    PrintJob,
    RecurringPrintConfig,
} from './types.ts';
import { Reaction } from './reactions.ts';

const MAX_MESSAGE_CHARS = 800;
const MAX_URLS = 5;
const PRINTER_POLL_INTERVAL_MS = 3_000;


const URL_REGEX = /https:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;

export function extractUrls(text: string): string[] {
    const matches = text.match(URL_REGEX) ?? [];
    const result: string[] = [];
    for (const m of matches) {
        try {
            const stripped = m.replace(TRAILING_PUNCT, '');
            new URL(stripped); // validate
            result.push(stripped);
        } catch {
            // not a valid URL - skip
        }
        if (result.length >= MAX_URLS) break;
    }
    return result;
}

export function stripUrls(text: string): string {
    return text.replace(URL_REGEX, '').replace(/\s+/g, ' ').trim();
}

export function replaceUrlsInText(text: string, urls: string[]): string {
    if (urls.length === 0) return text;
    let result = text;
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (!url) continue;
        const label = urls.length === 1 ? '[link]' : `[link ${i + 1}]`;
        // Replace first occurrence only (in case of duplicates)
        result = result.replace(url, label);
    }
    return result;
}


async function hasReaction(message: Message, emoji: Reaction): Promise<boolean> {
    try {
        await message.fetch();
    } catch {
        // ignore
    }
    const reaction: MessageReaction | undefined = message.reactions.cache.get(emoji);
    return Boolean(reaction?.me);
}

async function hasAnyReaction(message: Message) {
    for (const v of Object.values(Reaction) as Reaction[]) {
        if (v === Reaction.thinking) continue;
        if (message.reactions.cache.get(v)) {
            return true;
        }
    }
    return false;
}

async function refreshMessage(message: Message): Promise<void> {
    try {
        await message.fetch();
    } catch {
        // continue with the cached message if refresh fails
    }
}

async function removeReactionSafe(message: Message, emoji: Reaction): Promise<void> {
    try {
        const reaction = message.reactions.cache.get(emoji);
        if (reaction?.me) await reaction.users.remove();
    } catch {
        // ignore
    }
}

async function reactSafe(message: Message, emoji: Reaction): Promise<void> {
    try {
        await message.react(emoji);
        if (emoji !== Reaction.thinking) {
            await removeReactionSafe(message, Reaction.thinking);
        }
        if (emoji === Reaction.ok) {
            await removeReactionSafe(message, Reaction.fail);
            await removeReactionSafe(message, Reaction.waiting);
        }
        if (emoji === Reaction.waiting) {
            await removeReactionSafe(message, Reaction.fail);
        }
    } catch {
        // ignore
    }
}

async function replySafe(message: Message, content: string): Promise<Message | null> {
    try {
        return await message.reply(content);
    } catch {
        return null;
    }
}


function isPrintTrigger(content: string): boolean {
    return content.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === 'print';
}

function isCommandMessage(content: string): boolean {
    const trimmed = content.trim();
    return trimmed.startsWith('!') || trimmed.startsWith('/');
}

export function parseCommand(content: string): { name: string; args: string } | null {
    const match = content.trim().match(/^[!/]\s*(\S+)(?:\s+(.*))?$/);
    if (!match?.[1]) return null;
    return {
        name: match[1].toLowerCase(),
        args: match[2]?.trim() ?? '',
    };
}


export interface WindsorBotHandle {
    start(token: string): Promise<void>;
    destroy(): void;
    getClient(): Client;
    handleImmediatePrint(message: Message, config: ImmediatePrintConfig, retryFailed?: boolean): Promise<void>;
    handleAccumulatingPrint(triggerMessage: Message, config: AccumulatingListConfig, allMessages: Message[]): Promise<void>;
    handleRecurringSetup(message: Message, config: RecurringPrintConfig): Promise<void>;
    executeRecurringTask(scheduleReply: Message, config: RecurringPrintConfig): Promise<void>;
    advanceRecurring(scheduleReply: Message, latestStatusReply: Message, config: RecurringPrintConfig): Promise<void>;
    handleOnDemand(message: Message): Promise<void>;
}


export function createWindsorBot(): WindsorBotHandle {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
        ],
    });
    const pendingPrints = new Map<string, { message: Message; retry: () => Promise<void> }>();
    const processingPending = new Set<string>();
    let pendingPoller: ReturnType<typeof setInterval> | null = null;

    client.on('clientReady', () => void onReady());
    client.on('messageCreate', (msg) => void onMessage(msg));

    const bot: WindsorBotHandle = {
        start,
        destroy,
        getClient,
        handleImmediatePrint,
        handleAccumulatingPrint,
        handleRecurringSetup,
        executeRecurringTask,
        advanceRecurring,
        handleOnDemand,
    };

    async function start(token: string): Promise<void> {
        await client.login(token);
    }

    function destroy(): void {
        if (pendingPoller) {
            clearInterval(pendingPoller);
            pendingPoller = null;
        }
        client.destroy();
    }

    function getClient(): Client {
        return client;
    }

    function isTextOnlyChannel(ch: { isTextBased(): boolean; type: ChannelType }): boolean {
        return ch.isTextBased()
            && ch.type !== ChannelType.GuildVoice
            && ch.type !== ChannelType.GuildStageVoice
            && ch.type !== ChannelType.GuildForum
            && ch.type !== ChannelType.GuildMedia;
    }

    function enqueuePendingPrint(message: Message, retry: () => Promise<void>): void {
        pendingPrints.set(message.id, { message, retry });
        if (pendingPoller) return;
        pendingPoller = setInterval(() => void pollPendingPrints(), PRINTER_POLL_INTERVAL_MS);
        logEvent('info', `Printer unavailable; polling for ${pendingPrints.size} pending print(s)`);
    }

    async function pollPendingPrints(): Promise<void> {
        for (const [messageId, pending] of pendingPrints) {
            if (processingPending.has(messageId)) continue;
            processingPending.add(messageId);
            try {
                await pending.retry();
                await refreshMessage(pending.message);
                if (!pending.message.reactions.cache.get(Reaction.waiting)?.me) {
                    pendingPrints.delete(messageId);
                }
            } catch (err) {
                logEvent('error', `Pending print retry failed: ${err}`);
            } finally {
                processingPending.delete(messageId);
            }
        }
        if (pendingPrints.size === 0 && pendingPoller) {
            clearInterval(pendingPoller);
            pendingPoller = null;
        }
    }

    async function onReady(): Promise<void> {
        const botUser = client.user!;
        status.connected = true;
        status.tag = botUser.tag;
        status.startedAt = new Date().toISOString();
        status.configuredServerId = getCurrentConfig().serverId ?? null;
        status.guilds = [...client.guilds.cache.values()].map(g => g.name);

        logEvent('startup', `Connected as ${botUser.tag}`);

        const guilds = getTargetGuilds();
        for (const guild of guilds) {
            const channels = await guild.channels.fetch();
            const textChannels = [...channels.values()]
                .filter((c): c is NonNullable<typeof c> => c !== null && isTextOnlyChannel(c))
                .map(c => ({ id: c.id, name: (c as TextChannel).name }));
            await reconcileChannels(textChannels);
        }

        await startupScan();
    }

    function getTargetGuilds(): Guild[] {
        const serverId = getCurrentConfig().serverId;
        if (!serverId) return [...client.guilds.cache.values()];
        const guild = client.guilds.cache.get(serverId);
        if (!guild) {
            logEvent('error', `Configured serverId ${serverId} not found`);
            return [];
        }
        return [guild];
    }

    async function startupScan(): Promise<void> {
        logEvent('info', 'Starting startup scan...');
        const config = getCurrentConfig();
        const guilds = getTargetGuilds();

        for (const guild of guilds) {
            const channels = await guild.channels.fetch();
            for (const ch of channels.values()) {
                if (!ch?.isTextBased()) continue;
                const textCh = ch as TextChannel;
                const mapping = config.channels.find(m => m.channelId === textCh.id);
                if (!mapping) continue;

                try {
                    let fetchedMessages;
                    if (mapping.config.type === 'recurring-print') {
                        const page1 = await textCh.messages.fetch({ limit: 100 });
                        const oldest = [...page1.values()].reduce((a, b) =>
                            BigInt(a.id) < BigInt(b.id) ? a : b
                        );
                        const page2 = await textCh.messages.fetch({ limit: 100, before: oldest.id });
                        fetchedMessages = new Map([...page1, ...page2]);
                    } else {
                        fetchedMessages = await textCh.messages.fetch({ limit: 100 });
                    }
                    const sorted = [...fetchedMessages.values()].sort((a, b) =>
                        Number(BigInt(a.id) - BigInt(b.id))
                    );
                    await processBehaviorStartup(textCh, mapping.config, sorted);
                } catch (err) {
                    logEvent('error', `Startup scan failed for #${textCh.name}: ${err}`);
                }
            }
        }
        logEvent('info', 'Startup scan complete');
    }

    async function processBehaviorStartup(
        channel: TextChannel,
        config: ChannelBehaviorConfig,
        messages: Message[],
    ): Promise<void> {
        const botId = client.user?.id;

        switch (config.type) {
            case 'immediate-print': {
                for (const msg of messages) {
                    if (msg.author.bot) continue;
                    if (msg.reference) continue;
                    if (msg.author.id === botId) continue;
                    if (isCommandMessage(msg.content)) {
                        await handleOnDemand(msg, await hasReaction(msg, Reaction.waiting));
                        continue;
                    }
                    if (await hasReaction(msg, Reaction.waiting)) {
                        await handleImmediatePrint(msg, config, false, true);
                        continue;
                    }
                    if (await hasAnyReaction(msg)) continue;
                    await handleImmediatePrint(msg, config);
                }
                break;
            }
            case 'accumulating-list': {
                for (const msg of messages) {
                    if (msg.author.bot) continue;
                    if (msg.reference) continue;
                    if (msg.author.id === botId) continue;
                    if (!isPrintTrigger(msg.content)) continue;
                    if (await hasReaction(msg, Reaction.waiting)) {
                        await handleAccumulatingPrint(msg, config, messages, true);
                        continue;
                    }
                    if (await hasAnyReaction(msg)) continue;
                    await handleAccumulatingPrint(msg, config, messages);
                }
                break;
            }
            case 'recurring-print': {
                await startupRecurring(channel, config, messages);
                break;
            }
            case 'on-demand': {
                for (const msg of messages) {
                    if (msg.author.bot) continue;
                    if (msg.reference) continue;
                    if (msg.author.id === botId) continue;
                    if (await hasReaction(msg, Reaction.waiting)) {
                        await handleOnDemand(msg, true);
                        continue;
                    }
                    if (await hasAnyReaction(msg)) continue;
                    await handleOnDemand(msg);
                }
                break;
            }
        }
    }

    async function startupRecurring(
        channel: TextChannel,
        config: RecurringPrintConfig,
        messages: Message[],
    ): Promise<void> {
        const botId = client.user?.id;
        const scheduleReplies = messages.filter(m =>
            m.author.id === botId && m.content.startsWith('Got it. I will print ⟪')
        );

        for (const scheduleReply of scheduleReplies) {
            const parentId = scheduleReply.reference?.messageId;
            if (!parentId) continue;

            const statusReplies = messages.filter(m =>
                m.author.id === botId &&
                m.reference?.messageId === scheduleReply.id &&
                (m.content.startsWith('Printed at') || m.content.includes('has expired'))
            );

            const latestStatus = statusReplies[statusReplies.length - 1];

            if (latestStatus?.content.includes('has expired')) {
                continue;
            }

            if (latestStatus && latestStatus.content.startsWith('Printed at') && !await hasReaction(latestStatus, Reaction.ok)) {
                await advanceRecurring(scheduleReply, latestStatus, config);
                continue;
            }

            if (!latestStatus) {
                const match = /at (.+)$/.exec(scheduleReply.content);
                if (!match?.[1]) continue;
                const nextTime = new Date(match[1]);
                if (isNaN(nextTime.getTime())) continue;
                scheduleRecurringTask(scheduleReply, nextTime, config, bot);
            }
        }
    }

    async function onMessage(message: Message): Promise<void> {
        if (message.author.bot) return;
        if (message.reference) return;
        if (message.author.id === client.user?.id) return;

        const config = getCurrentConfig();
        const mapping = config.channels.find(m => m.channelId === message.channelId);
        if (!mapping) return;

        const serverId = config.serverId;
        if (serverId && message.guildId !== serverId) return;

        switch (mapping.config.type) {
            case 'immediate-print':
                if (isCommandMessage(message.content)) {
                    await handleOnDemand(message);
                } else {
                    await handleImmediatePrint(message, mapping.config);
                }
                break;
            case 'accumulating-list': {
                if (isPrintTrigger(message.content)) {
                    const channel = message.channel as TextChannel;
                    const messages = await channel.messages.fetch({ limit: 100 });
                    const sorted = [...messages.values()].sort((a, b) =>
                        Number(BigInt(a.id) - BigInt(b.id))
                    );
                    await handleAccumulatingPrint(message, mapping.config, sorted);
                }
                break;
            }
            case 'recurring-print':
                await handleRecurringSetup(message, mapping.config);
                break;
            case 'on-demand':
                await handleOnDemand(message);
                break;
        }
    }

    async function handleImmediatePrint(
        message: Message,
        config: ImmediatePrintConfig,
        retryFailed = false,
        retryPending = false,
    ): Promise<void> {
        const rawContent = message.content;
        const urls = extractUrls(rawContent);
        const textWithLinkLabels = replaceUrlsInText(rawContent, urls);
        const strippedText = stripUrls(rawContent);

        if (strippedText.length > MAX_MESSAGE_CHARS) {
            await reactSafe(message, Reaction.fail);
            return;
        }

        const job: PrintJob = {
            lines: [textWithLinkLabels],
            urls,
        };

        if (config.header) job.header = config.header;
        if (config.footer) job.footer = config.footer;
        if (config.includeMetadata) {
            job.metadataLines = [
                `${message.author.username} · ${formatTimestamp(message.createdAt)}`,
            ];
        }

        if (config.includeIcon) {
            await reactSafe(message, Reaction.thinking);
            const iconCacheDir = getCurrentConfig().iconCacheDir ?? './icon-cache';
            const iconPath = await generateIcon(strippedText, iconCacheDir);
            if (iconPath) job.iconPath = iconPath;
        }

        await refreshMessage(message);
        if (await hasAnyReaction(message)) {
            const waiting = message.reactions.cache.get(Reaction.waiting)?.me;
            if (!retryPending && (!retryFailed || !message.reactions.cache.get(Reaction.fail)?.me)) {
                await removeReactionSafe(message, Reaction.thinking);
                return;
            }
            if (retryPending && !waiting) return;
        }

        try {
            await printJob(job);
            pendingPrints.delete(message.id);
            await reactSafe(message, Reaction.ok);
            logEvent('print', `Printed immediate message from ${message.author.username}`);
        } catch (err) {
            if (err instanceof PrinterUnavailableError) {
                await reactSafe(message, Reaction.waiting);
                enqueuePendingPrint(message, () => handleImmediatePrint(message, config, false, true));
                logEvent('info', `Printer unavailable for immediate message from ${message.author.username}`);
                return;
            }
            await reactSafe(message, Reaction.fail);
            await replySafe(message, `⏸️ Print failed: ${err instanceof Error ? err.message : String(err)}`);
            logEvent('error', `Print failed: ${err}`);
        }
        await removeReactionSafe(message, Reaction.thinking);
    }

    async function handleAccumulatingPrint(
        triggerMessage: Message,
        config: AccumulatingListConfig,
        allMessages: Message[],
        retryPending = false,
    ): Promise<void> {
        const botId = client.user?.id;

        const triggerIdx = allMessages.findIndex(m => m.id === triggerMessage.id);
        const prior = allMessages.slice(0, triggerIdx).reverse();
        const prevPrintIdx = prior.findIndex(m =>
            !m.author.bot &&
            !m.reference &&
            isPrintTrigger(m.content) &&
            m.reactions.cache.get(Reaction.ok)?.me
        );

        const startIdx = prevPrintIdx === -1 ? 0 : triggerIdx - prevPrintIdx;

        let items = allMessages.slice(startIdx, triggerIdx).filter(m =>
            !m.author.bot &&
            !m.reference &&
            m.author.id !== botId &&
            !isPrintTrigger(m.content)
        );

        if (items.length === 0) {
            if (prevPrintIdx === -1) {
                await reactSafe(triggerMessage, Reaction.ok);
                return;
            }
            const prevTriggerMsg = prior[prevPrintIdx];
            if (!prevTriggerMsg) {
                await reactSafe(triggerMessage, Reaction.ok);
                return;
            }
            const prevTriggerIdx = allMessages.findIndex(m => m.id === prevTriggerMsg.id);
            const beforePrev = allMessages.slice(0, prevTriggerIdx);
            const prevPrevIdx = beforePrev.reverse().findIndex(m =>
                !m.author.bot && !m.reference && isPrintTrigger(m.content) && m.reactions.cache.get(Reaction.ok)?.me
            );
            const prevStartIdx = prevPrevIdx === -1 ? 0 : prevTriggerIdx - prevPrevIdx;
            items = allMessages.slice(prevStartIdx, prevTriggerIdx).filter(m =>
                !m.author.bot && !m.reference && m.author.id !== botId && !isPrintTrigger(m.content)
            );
        }

        if (items.length === 0) {
            await reactSafe(triggerMessage, Reaction.ok);
            return;
        }

        const lines = items.map(m => {
            const urls = extractUrls(m.content);
            const text = replaceUrlsInText(m.content, urls);
            return config.includeChecklist ? `[_] ${text}` : text;
        });

        const job: PrintJob = { lines, urls: [] };
        if (config.header) job.header = config.header;
        if (config.footer) job.footer = config.footer;
        if (config.includeMetadata) {
            job.metadataLines = [`Printed at ${formatTimestamp(new Date())}`];
        }

        await refreshMessage(triggerMessage);
        if (await hasAnyReaction(triggerMessage)) {
            if (!retryPending || !triggerMessage.reactions.cache.get(Reaction.waiting)?.me) return;
        }

        try {
            await printJob(job);
            pendingPrints.delete(triggerMessage.id);
            await reactSafe(triggerMessage, Reaction.ok);
            logEvent('print', `Printed accumulating list (${lines.length} items)`);
        } catch (err) {
            if (err instanceof PrinterUnavailableError) {
                await reactSafe(triggerMessage, Reaction.waiting);
                enqueuePendingPrint(
                    triggerMessage,
                    () => handleAccumulatingPrint(triggerMessage, config, allMessages, true),
                );
                logEvent('info', `Printer unavailable for accumulating list in #${triggerMessage.channelId}`);
                return;
            }
            await reactSafe(triggerMessage, Reaction.fail);
            await replySafe(triggerMessage, `⏸️ Print failed: ${err instanceof Error ? err.message : String(err)}`);
            logEvent('error', `Accumulating print failed: ${err}`);
        }
    }

    async function handleRecurringSetup(message: Message, config: RecurringPrintConfig): Promise<void> {
        const rawContent = message.content;

        try {
            const parsed = await parseRecurringSchedule(rawContent, new Date());
            if (!parsed) {
                await reactSafe(message, Reaction.what);
                await replySafe(message, '⁉️ Could not parse a schedule from your message. Please try again with a clearer schedule.');
                return;
            }

            const nextStr = formatScheduleDate(parsed.nextOccurrence);
            await reactSafe(message, Reaction.ok);
            const reply = await replySafe(message, `Got it. I will print ⟪${parsed.message}⟫ at ${nextStr}`);

            if (reply) {
                scheduleRecurringTask(reply, parsed.nextOccurrence, config, bot);
            }
        } catch (err) {
            await reactSafe(message, Reaction.fail);
            await replySafe(message, `⁉️ Failed to parse schedule: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async function executeRecurringTask(
        scheduleReply: Message,
        config: RecurringPrintConfig,
    ): Promise<void> {
        const match = /⟪(.+?)⟫/.exec(scheduleReply.content);
        if (!match?.[1]) return;
        const text = match[1];

        const urls = extractUrls(text);
        const textWithLinks = replaceUrlsInText(text, urls);
        const strippedText = stripUrls(text);

        const job: PrintJob = {
            lines: [textWithLinks],
            urls,
        };
        if (config.header) job.header = config.header;
        if (config.footer) job.footer = config.footer;
        if (config.includeMetadata) {
            job.metadataLines = [`Recurring · ${formatTimestamp(new Date())}`];
        }
        if (config.includeIcon) {
            const iconCacheDir = getCurrentConfig().iconCacheDir ?? './icon-cache';
            const iconPath = await generateIcon(strippedText, iconCacheDir);
            if (iconPath) job.iconPath = iconPath;
        }

        await refreshMessage(scheduleReply);
        if (await hasAnyReaction(scheduleReply)) {
            await removeReactionSafe(scheduleReply, Reaction.thinking);
            return;
        }

        const printedAt = formatTimestamp(new Date());

        try {
            await printJob(job);
        } catch (err) {
            await removeReactionSafe(scheduleReply, Reaction.thinking);
            logEvent('error', `Recurring print failed: ${err}`);
            return;
        }

        logEvent('print', `Printed recurring task: ${text}`);

        const originalUserMessage = scheduleReply.content.replace(/^Got it\. I will print ⟪.+?⟫ at /, '');
        const nextOccurrence = await getNextOccurrence(originalUserMessage, new Date());

        let statusReply: Message | null;
        if (!nextOccurrence) {
            statusReply = await replySafe(scheduleReply, 'This occurrence has expired and no more prints are scheduled');
        } else {
            const nextStr = formatScheduleDate(nextOccurrence);
            statusReply = await replySafe(scheduleReply, `Printed at ${printedAt}. The next print will be at ${nextStr}.`);
        }

        if (statusReply) {
            await reactSafe(statusReply, Reaction.ok);
        }
        await removeReactionSafe(scheduleReply, Reaction.thinking);

        if (nextOccurrence && statusReply) {
            scheduleRecurringTask(scheduleReply, nextOccurrence, config, bot);
        }
    }

    async function advanceRecurring(
        scheduleReply: Message,
        latestStatusReply: Message,
        config: RecurringPrintConfig,
    ): Promise<void> {
        const match = /⟪(.+?)⟫/.exec(scheduleReply.content);
        if (!match?.[1]) return;

        const nextOccurrence = await getNextOccurrence(match[1], new Date());
        if (!nextOccurrence) {
            await replySafe(latestStatusReply, 'This occurrence has expired and no more prints are scheduled');
            await removeReactionSafe(latestStatusReply, Reaction.thinking);
            return;
        }

        const nextStr = formatScheduleDate(nextOccurrence);
        await replySafe(latestStatusReply, `The next print will be at ${nextStr}.`);
        await reactSafe(latestStatusReply, Reaction.ok);
        scheduleRecurringTask(scheduleReply, nextOccurrence, config, bot);
    }

    async function retryFailedMessages(message: Message): Promise<number> {
        const mapping = getCurrentConfig().channels.find(m => m.channelId === message.channelId);
        if (!mapping || mapping.config.type !== 'immediate-print') {
            throw new Error('!retry is only available in immediate-print channels');
        }

        const channel = message.channel as TextChannel;
        const messages = await channel.messages.fetch({ limit: 20, before: message.id });
        const failed = [...messages.values()].filter(msg =>
            !msg.author.bot &&
            !msg.reference &&
            !isCommandMessage(msg.content) &&
            msg.reactions.cache.get(Reaction.fail)?.me
        );

        for (const failedMessage of failed) {
            await handleImmediatePrint(failedMessage, mapping.config, true);
        }
        return failed.length;
    }

    async function handleOnDemand(message: Message, retryPending = false): Promise<void> {
        const parsed = parseCommand(message.content);
        if (!parsed) return;
        const { name: commandName, args } = parsed;

        let foundCommand = false;
        for (const cmd of Commands) {
            if (cmd.aliases.some(a => commandName.localeCompare(a, undefined, { sensitivity: "base" }) == 0)) {
                foundCommand = true;
                logEvent('command', `Command '${commandName}' invoked by ${message.author.username}`);
                await refreshMessage(message);
                if (await hasAnyReaction(message) && !retryPending) return;
                const ctx: import('./commands/index.ts').CommandRunContext = {
                    printJob,
                    retryFailedMessages: () => retryFailedMessages(message),
                };
                let result;
                try {
                    result = await cmd.invoke(args, ctx);
                } catch (err) {
                    if (err instanceof PrinterUnavailableError) {
                        await reactSafe(message, Reaction.waiting);
                        enqueuePendingPrint(message, () => handleOnDemand(message, true));
                        logEvent('info', `Printer unavailable for command '${commandName}'`);
                        return;
                    }
                    throw err;
                }
                if (result.kind === 'pass') {
                    pendingPrints.delete(message.id);
                    await reactSafe(message, "✅");
                    if (result.reply) {
                        await replySafe(message, result.reply);
                    }
                } else {
                    void (result.kind satisfies 'fail');
                    await reactSafe(message, Reaction.fail);
                    await replySafe(message, result.reason);
                }
                break;
            }
        }
        if (!foundCommand) {
            await reactSafe(message, "❓");
        }
    }

    return bot;
}


interface ScheduledTask {
    scheduleReply: Message;
    nextOccurrence: Date;
    config: RecurringPrintConfig;
    bot: WindsorBotHandle;
    timerId: ReturnType<typeof setTimeout>;
}

const scheduledTasks = new Map<string, ScheduledTask>();

export function scheduleRecurringTask(
    scheduleReply: Message,
    nextOccurrence: Date,
    config: RecurringPrintConfig,
    bot: WindsorBotHandle,
): void {
    const key = scheduleReply.id;
    const existing = scheduledTasks.get(key);
    if (existing) clearTimeout(existing.timerId);

    const delay = Math.max(0, nextOccurrence.getTime() - Date.now());
    const timerId = setTimeout(() => {
        scheduledTasks.delete(key);
        void bot.executeRecurringTask(scheduleReply, config);
    }, delay);

    scheduledTasks.set(key, { scheduleReply, nextOccurrence, config, bot, timerId });
}

export function checkScheduledTasks(): void {
    const now = new Date();
    for (const [key, task] of scheduledTasks) {
        if (task.nextOccurrence <= now) {
            clearTimeout(task.timerId);
            scheduledTasks.delete(key);
            void task.bot.executeRecurringTask(task.scheduleReply, task.config);
        }
    }
}
