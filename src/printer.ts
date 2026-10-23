import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { PrintJob } from './types.ts';
import { buildEscpBuffer } from './printing/escp.ts';
import { renderJobToPng } from './printing/render.ts';

const execAsync = promisify(exec);

export async function getConnectedPrinter(): Promise<string | null> {
    try {
        const { stdout } = await execAsync('lpstat -p 2>/dev/null');
        for (const line of stdout.split('\n')) {
            const match = /^printer\s+(\S+)/.exec(line);
            if (match?.[1]) return match[1];
        }
    } catch {
        // CUPS may not be installed.
    }

    try {
        const { stdout } = await execAsync('ls /dev/usb/lp* 2>/dev/null || ls /dev/lp* 2>/dev/null || true');
        return stdout.trim().split('\n').filter(Boolean)[0] ?? null;
    } catch {
        return null;
    }
}

/** Render a print job as a PNG for callers that need the image payload. */
export async function formatPrintJob(job: PrintJob): Promise<Buffer> {
    return renderJobToPng(job);
}

export async function printJob(job: PrintJob, printerName?: string): Promise<void> {
    const printer = printerName ?? await getConnectedPrinter();
    if (!printer) throw new Error('No printer available');

    if (printer.startsWith('/dev/')) {
        const data = await buildEscpBuffer(job);
        const { writeFile } = await import('fs/promises');
        await writeFile(printer, data);
        return;
    }

    const png = await formatPrintJob(job);
    await new Promise<void>((resolve, reject) => {
        const child = execFile('lp', ['-d', printer, '-o', 'document-format=image/png', '-'], (err) => {
            if (err) reject(err);
            else resolve();
        });
        child.stdin?.end(png);
    });
}

export async function printTestPage(printerName: string): Promise<void> {
    await printJob({
        header: 'Windsor Test Page',
        lines: ['Normal size text - The quick brown fox jumps over the lazy dog.', '', '--- Font Demo ---'],
        urls: ['https://github.com/SeaRyanC/d2p'],
        footer: 'Footer text here',
        metadataLines: [`Printed at: ${formatTimestamp(new Date())}`, `Printer: ${printerName}`],
    }, printerName);
}

export function formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hours}:${String(minutes).padStart(2, '0')} ${ampm}`;
}
