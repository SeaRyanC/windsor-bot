import type { PrintJob } from '../types.ts';
import { getCurrentConfig } from '../config.ts';
import { printJobEscp } from './escp.ts';
import { printJobCups } from './cups.ts';
import { printJobImageFeed, printTestJobImageFeed } from './imagefeed.ts';

export class PrinterUnavailableError extends Error {
    constructor(message = 'Printer is unavailable') {
        super(message);
        this.name = 'PrinterUnavailableError';
    }
}

function isUnavailableError(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current; depth++) {
        if (!(current instanceof Error)) return false;
        const code = 'code' in current ? String(current.code) : '';
        const message = `${current.name} ${current.message}`.toLowerCase();
        if (
            code === 'ENOENT' ||
            code === 'ENODEV' ||
            code === 'ENXIO' ||
            message.includes('enoent') ||
            message.includes('no such file or directory') ||
            message.includes('printer or class does not exist') ||
            message.includes('no printer') ||
            message.includes('device or resource busy')
        ) {
            return true;
        }
        current = 'cause' in current ? current.cause : undefined;
    }
    return false;
}

export async function printJob(job: PrintJob): Promise<void> {
    const cfg = getCurrentConfig();
    const printConfig = cfg.printConfig;

    if (!printConfig) {
        throw new Error('No print mode configured. Set a print mode in the Control Panel.');
    }

    try {
        switch (printConfig.mode) {
            case 'escp':
                await printJobEscp(job, printConfig.serialPort);
                break;
            case 'cups':
                await printJobCups(job, printConfig);
                break;
            case 'imagefeed':
                await printJobImageFeed(job);
                break;
            default: {
                const never: never = printConfig;
                throw new Error(`Unknown print mode: ${(never as { mode: string }).mode}`);
            }
        }
    } catch (error) {
        if (isUnavailableError(error)) {
            throw new PrinterUnavailableError(error instanceof Error ? error.message : String(error));
        }
        throw error;
    }
}

export async function printTestPage(): Promise<void> {
    const cfg = getCurrentConfig();
    const printConfig = cfg.printConfig;

    if (!printConfig) {
        throw new Error('No print mode configured.');
    }

    const testJob: PrintJob = {
        header: 'Windsor Test Page',
        lines: [
            'Normal text — The quick brown fox jumps over the lazy dog.',
        ],
        urls: ['https://github.com/SeaRyanC/d2p'],
        footer: 'Footer text here',
        metadataLines: [`Printed at: ${new Date().toLocaleString()}`, `Mode: ${printConfig.mode}`],
    };

    switch (printConfig.mode) {
        case 'escp':
            await printJobEscp(testJob, printConfig.serialPort);
            break;
        case 'cups':
            await printJobCups(testJob, printConfig);
            break;
        case 'imagefeed':
            await printTestJobImageFeed(testJob);
            break;
    }
}

export { getImageFeed, clearImageFeed, renderFeedHtml } from './imagefeed.ts';
