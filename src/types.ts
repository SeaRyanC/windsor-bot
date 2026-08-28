
export type ChannelBehaviorType =
    | 'immediate-print'
    | 'accumulating-list'
    | 'on-demand';

export interface ImmediatePrintConfig {
    type: 'immediate-print';
    header?: string;
    footer?: string;
    includeIcon: boolean;
    includeMetadata: boolean;
}

export interface AccumulatingListConfig {
    type: 'accumulating-list';
    header?: string;
    footer?: string;
    includeChecklist: boolean;
    includeMetadata: boolean;
}

export interface ReusableListConfig {
    type: 'reusable-list';
    header?: string;
    footer?: string;
    includeMetadata: boolean;
}

export interface OnDemandConfig {
    type: 'on-demand';
}

export type ChannelBehaviorConfig =
    | ImmediatePrintConfig
    | AccumulatingListConfig
    | ReusableListConfig
    | OnDemandConfig;

export interface ChannelMapping {
    channelId: string;
    channelName: string;
    config: ChannelBehaviorConfig;
}


export interface TokenUsageEntry {
    timestamp: string; // ISO string
    tokens: number;
}


export type PrintMode = 'escp' | 'cups' | 'imagefeed';

export interface EscpPrintConfig {
    mode: 'escp';
    serialPort: string; // e.g. /dev/ttyUSB0 or COM3
}

export interface CupsPrintConfig {
    mode: 'cups';
    printerName: string;
    paperSize: string;  // e.g. "Letter", "A4"
    paperName: string;  // human label shown on printout
}

export interface ImageFeedConfig {
    mode: 'imagefeed';
}

export type PrintConfig = EscpPrintConfig | CupsPrintConfig | ImageFeedConfig;


export interface WindsorConfig {
    discordToken?: string;
    serverId?: string;
    openaiKey?: string;
    diagnosticsPort: number;
    passwordHash?: string;
    channels: ChannelMapping[];
    iconCacheDir?: string;
    tokenUsage: TokenUsageEntry[];
    printConfig?: PrintConfig;
}


export type DiagnosticEventType = 'startup' | 'command' | 'success' | 'error' | 'info' | 'print';

export interface DiagnosticEvent {
    timestamp: string; // ISO string
    type: DiagnosticEventType;
    message: string;
}

export interface BotStatus {
    connected: boolean;
    tag: string | null;
    startedAt: string | null;
    guilds: string[];
    configuredServerId: string | null;
}


export interface PrintJob {
    header?: string;
    lines: string[];
    fontSize?: 'normal' | 'tall' | 'double';
    iconPath?: string;
    urls: string[];
    footer?: string;
    metadataLines?: string[];
}


export interface CommandContext {
    channelName: string;
    args: string;
    rawMessage: string;
    messageId: string;
    channelId: string;
    guildId: string;
}
