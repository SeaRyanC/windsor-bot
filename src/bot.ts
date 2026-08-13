import {
    ChannelType,
    Client,
    GatewayIntentBits,
    Partials,
    type Guild,
    type Message,
    type MessageReaction,
    type PartialMessageReaction,
    type PartialUser,
    type TextChannel,
    type User,
} from 'discord.js';
import { generateIcon, isIconCached } from './ai.ts';
import { Commands } from './commands/index.ts';
import { getCurrentConfig, reconcileChannels } from './config.ts';
import { formatTimestamp } from './printer.ts';
import { isPrinterUnavailableError, printJob } from './printing/index.ts';
import { logEvent, status } from './server.ts';
import type {
    AccumulatingListConfig,
    ChannelBehaviorConfig,
    ImmediatePrintConfig,
    PrintJob,
    ReusableListConfig,
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

async function removeOwnReactionSafe(reaction: MessageReaction): Promise<void> {
    try {
        if (reaction.me) await reaction.users.remove();
    } catch {
        // ignore
    }
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

async function reactSafe(message: Message, emoji: Reaction, clearThinking = true): Promise<void> {
    try {
        await message.react(emoji);
        if (emoji !== Reaction.thinking && clearThinking) {
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
    handleOnDemand(message: Message): Promise<void>;
}


export function createWindsorBot(): WindsorBotHandle {
    const client = new Client({
        partials: [Partials.Message, Partials.Reaction, Partials.User],
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
        ],
    });
    const pendingPrints = new Map<string, { message: Message; retry: () => Promise<void> }>();
    const processingPending = new Set<string>();
    const reusableStates = new Map<string, {
        reaction: MessageReaction;
        cancelled: boolean;
        status: 'printing' | 'pending' | 'printed';
    }>();
    let pendingPoller: ReturnType<typeof setInterval> | null = null;

    client.on('clientReady', () => void onReady());
    client.on('messageCreate', (msg) => void onMessage(msg));
    client.on('messageReactionAdd', (reaction, user) => void onReactionAdd(reaction, user));
    client.on('messageReactionRemove', (reaction, user) => void onReactionRemove(reaction, user));

    const bot: WindsorBotHandle = {
        start,
        destroy,
        getClient,
        handleImmediatePrint,
        handleAccumulatingPrint,
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

    function getReusableConfig(message: Message): ReusableListConfig | null {
        const config = getCurrentConfig();
        const mapping = config.channels.find(m => m.channelId === message.channelId);
        if (!mapping || mapping.config.type !== 'reusable-list') return null;
        if (config.serverId && message.guildId !== config.serverId) return null;
        if (message.author.bot || message.reference) return null;
        return mapping.config;
    }

    async function hydrateReaction(
        reaction: MessageReaction | PartialMessageReaction,
    ): Promise<{ reaction: MessageReaction; message: Message }> {
        const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
        if (fullReaction.message.partial) await fullReaction.message.fetch();
        return { reaction: fullReaction, message: fullReaction.message as Message };
    }

    async function findStartupReusableReaction(message: Message): Promise<MessageReaction | null> {
        if ([...message.reactions.cache.values()].some(reaction => reaction.me)) return null;
        for (const reaction of message.reactions.cache.values()) {
            const users = await reaction.users.fetch();
            if ([...users.values()].some(user => !user.bot)) return reaction;
        }
        return null;
    }

    async function onReactionAdd(
        reactionEvent: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
    ): Promise<void> {
        if (user.bot) return;

        try {
            const { reaction, message } = await hydrateReaction(reactionEvent);
            const config = getReusableConfig(message);
            if (!config) return;
            if ([...message.reactions.cache.values()].some(candidate => candidate.me)) return;
            if (reusableStates.has(message.id)) return;

            const state = { reaction, cancelled: false, status: 'printing' as const };
            reusableStates.set(message.id, state);
            await handleReusablePrint(message, config, state);
        } catch (err) {
            logEvent('error', `Reusable List reaction handling failed: ${err}`);
        }
    }

    async function onReactionRemove(
        reactionEvent: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
    ): Promise<void> {
        if (user.bot) return;

        try {
            const { reaction, message } = await hydrateReaction(reactionEvent);
            if (!getReusableConfig(message)) return;

            const state = reusableStates.get(message.id);
            if (state) {
                state.cancelled = true;
                pendingPrints.delete(message.id);
                await removeReactionSafe(message, Reaction.waiting);
                if (state.status !== 'printing') reusableStates.delete(message.id);
            }
            await removeOwnReactionSafe(reaction);
        } catch (err) {
            logEvent('error', `Reusable List reaction removal failed: ${err}`);
        }
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
                    const fetchedMessages = await textCh.messages.fetch({ limit: 100 });
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
            case 'reusable-list': {
                for (const msg of messages) {
                    if (msg.author.bot || msg.reference || msg.author.id === botId) continue;
                    const reaction = await findStartupReusableReaction(msg);
                    if (!reaction || reusableStates.has(msg.id)) continue;
                    const state = { reaction, cancelled: false, status: 'printing' as const };
                    reusableStates.set(msg.id, state);
                    await handleReusablePrint(msg, config, state);
                }
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
            case 'reusable-list':
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

        let thinkingReacted = false;
        if (config.includeIcon) {
            const iconCacheDir = getCurrentConfig().iconCacheDir ?? './icon-cache';
            thinkingReacted = !await isIconCached(strippedText, iconCacheDir);
            if (thinkingReacted) await reactSafe(message, Reaction.thinking);
            const iconPath = await generateIcon(strippedText, iconCacheDir);
            if (iconPath) job.iconPath = iconPath;
        }

        await refreshMessage(message);
        if (await hasAnyReaction(message)) {
            const waiting = message.reactions.cache.get(Reaction.waiting)?.me;
            if (!retryPending && (!retryFailed || !message.reactions.cache.get(Reaction.fail)?.me)) {
                if (thinkingReacted) await removeReactionSafe(message, Reaction.thinking);
                return;
            }
            if (retryPending && !waiting) return;
        }

        try {
            await printJob(job);
            pendingPrints.delete(message.id);
            await reactSafe(message, Reaction.ok, thinkingReacted);
            logEvent('print', `Printed immediate message from ${message.author.username}`);
        } catch (err) {
            if (isPrinterUnavailableError(err)) {
                await reactSafe(message, Reaction.waiting, thinkingReacted);
                enqueuePendingPrint(message, () => handleImmediatePrint(message, config, false, true));
                logEvent('info', `Printer unavailable for immediate message from ${message.author.username}`);
                return;
            }
            await reactSafe(message, Reaction.fail, thinkingReacted);
            await replySafe(message, `⏸️ Print failed: ${err instanceof Error ? err.message : String(err)}`);
            logEvent('error', `Print failed: ${err}`);
        }
        if (thinkingReacted) await removeReactionSafe(message, Reaction.thinking);
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
            if (isPrinterUnavailableError(err)) {
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

    async function handleReusablePrint(
        message: Message,
        config: ReusableListConfig,
        state: { reaction: MessageReaction; cancelled: boolean; status: 'printing' | 'pending' | 'printed' },
    ): Promise<void> {
        if (state.cancelled) {
            reusableStates.delete(message.id);
            return;
        }

        try {
            await message.fetch();
        } catch (err) {
            reusableStates.delete(message.id);
            pendingPrints.delete(message.id);
            logEvent('info', `Cancelled reusable print for unavailable message ${message.id}: ${err}`);
            return;
        }

        const rawContent = message.content;
        const urls = extractUrls(rawContent);
        const text = replaceUrlsInText(rawContent, urls);
        const strippedText = stripUrls(rawContent);

        if (strippedText.length > MAX_MESSAGE_CHARS) {
            reusableStates.delete(message.id);
            await removeReactionSafe(message, Reaction.waiting);
            await replySafe(message, '⁉️ This message is too long to print.');
            return;
        }

        const job: PrintJob = { lines: [text], urls };
        if (config.header) job.header = config.header;
        if (config.footer) job.footer = config.footer;
        if (config.includeMetadata) {
            job.metadataLines = [
                `${message.author.username} · ${formatTimestamp(message.createdAt)}`,
            ];
        }

        if (state.cancelled) {
            reusableStates.delete(message.id);
            return;
        }

        try {
            await printJob(job);
        } catch (err) {
            if (isPrinterUnavailableError(err)) {
                state.status = 'pending';
                await reactSafe(message, Reaction.waiting);
                enqueuePendingPrint(message, () => handleReusablePrint(message, config, state));
                logEvent('info', `Printer unavailable for reusable message in #${message.channelId}`);
                return;
            }
            reusableStates.delete(message.id);
            await removeReactionSafe(message, Reaction.waiting);
            await replySafe(message, `⏸️ Print failed: ${err instanceof Error ? err.message : String(err)}`);
            logEvent('error', `Reusable List print failed: ${err}`);
            return;
        }

        pendingPrints.delete(message.id);
        await removeReactionSafe(message, Reaction.waiting);
        if (state.cancelled) {
            reusableStates.delete(message.id);
            return;
        }

        await message.react(state.reaction.emoji);
        state.status = 'printed';
        logEvent('print', `Printed reusable message from ${message.author.username}`);
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
                    if (isPrinterUnavailableError(err)) {
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
