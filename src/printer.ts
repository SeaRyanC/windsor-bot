import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import type { PrintJob } from './types.ts';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);


const ESC = '\x1B';
const GS = '\x1D';

const INIT = `${ESC}@`;
const BOLD_ON = `${ESC}E\x01`;
const BOLD_OFF = `${ESC}E\x00`;
// Double width + double height
const FONT_2X = `${GS}!\x11`;
// Double height only
const FONT_H2 = `${GS}!\x10`;
// Normal
const FONT_NORMAL = `${GS}!\x00`;
// Partial cut with 3mm feed
const CUT = `${GS}V\x41\x03`;
// Center align
const ALIGN_CENTER = `${ESC}a\x01`;
// Left align
const ALIGN_LEFT = `${ESC}a\x00`;
// Line feed
const LF = '\n';

// Characters per line at normal font on 80mm paper
const CHARS_NORMAL = 48;
const CHARS_DOUBLE = 24;


function wrapText(text: string, width: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        if (current.length === 0) {
            current = word;
        } else if (current.length + 1 + word.length <= width) {
            current += ' ' + word;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
}


function chooseFontForLines(totalLines: number): { fontSize: string; charsPerLine: number } {
    if (totalLines <= 4) {
        return { fontSize: FONT_2X, charsPerLine: CHARS_DOUBLE };
    } else if (totalLines <= 8) {
        return { fontSize: FONT_H2, charsPerLine: CHARS_DOUBLE };
    } else {
        return { fontSize: FONT_NORMAL, charsPerLine: CHARS_NORMAL };
    }
}

function countLayoutLines(lines: string[]): number {
    return lines.length <= 2 ? 2 : lines.length;
}


export async function getConnectedPrinter(): Promise<string | null> {
    // Try CUPS first
    try {
        const { stdout } = await execAsync('lpstat -p 2>/dev/null');
        const lines = stdout.split('\n');
        for (const line of lines) {
            const match = /^printer\s+(\S+)/.exec(line);
            if (match?.[1]) return match[1];
        }
    } catch {
        // CUPS not available or no printers
    }

    // Try USB device files
    try {
        const { stdout } = await execAsync('ls /dev/usb/lp* 2>/dev/null || ls /dev/lp* 2>/dev/null || true');
        const devices = stdout.trim().split('\n').filter(Boolean);
        if (devices.length > 0) return devices[0] ?? null;
    } catch {
        // ignore
    }

    return null;
}


/** Decode a simple PNG into raw RGBA pixels using Node built-in. Returns null if can't decode. */
async function loadImageForPrinting(path: string): Promise<{ width: number; height: number; pixels: Buffer } | null> {
    // Node doesn't have a built-in PNG decoder; we'd need a library.
    // For now, skip image printing and return null.
    // This is structured so QR/image printing can be added later.
    void path;
    return null;
}


export async function formatPrintJob(job: PrintJob): Promise<Buffer> {
    const parts: string[] = [];

    parts.push(INIT);

    // Determine content lines count for font sizing
    const rawLines = job.lines;
    const previewFontLines = countLayoutLines(rawLines);
    const { fontSize, charsPerLine } = chooseFontForLines(previewFontLines);

    // Header
    if (job.header) {
        parts.push(ALIGN_CENTER);
        parts.push(FONT_2X);
        parts.push(BOLD_ON);
        const headerLines = wrapText(job.header, CHARS_DOUBLE);
        parts.push(headerLines.join(LF));
        parts.push(BOLD_OFF);
        parts.push(FONT_NORMAL);
        parts.push(ALIGN_LEFT);
        parts.push(LF);
    }

    // Primary text
    if (rawLines.length > 0) {
        parts.push(fontSize);
        const wrapped: string[] = [];
        for (const line of rawLines) {
            wrapped.push(...wrapText(line, charsPerLine));
        }
        parts.push(wrapped.join(LF));
        parts.push(FONT_NORMAL);
        parts.push(LF);
    }

    // Icon
    if (job.iconPath) {
        const img = await loadImageForPrinting(job.iconPath);
        if (img) {
            // Future: raster print via ESC/P
            parts.push(`[icon: ${job.iconPath}]${LF}`);
        }
        // else silently skip
    }

    // URLs / QR codes
    if (job.urls.length > 0) {
        parts.push(LF);
        for (let i = 0; i < job.urls.length; i++) {
            const url = job.urls[i];
            if (!url) continue;
            const label = job.urls.length === 1 ? '[link]' : `[link ${i + 1}]`;
            // Print URL in a box since we don't have a QR library
            const boxWidth = Math.min(CHARS_NORMAL, url.length + 4);
            const top = '┌' + '─'.repeat(boxWidth - 2) + '┐';
            const bottom = '└' + '─'.repeat(boxWidth - 2) + '┘';
            const urlLines = wrapText(url, boxWidth - 4);
            parts.push(`${label}${LF}`);
            parts.push(`${top}${LF}`);
            for (const l of urlLines) {
                parts.push(`│ ${l.padEnd(boxWidth - 4)} │${LF}`);
            }
            parts.push(`${bottom}${LF}`);
        }
    }

    // Footer
    if (job.footer) {
        parts.push(LF);
        parts.push(BOLD_ON);
        const footerLines = wrapText(job.footer, CHARS_NORMAL);
        parts.push(footerLines.join(LF));
        parts.push(BOLD_OFF);
        parts.push(LF);
    }

    // Metadata footer
    if (job.metadataLines && job.metadataLines.length > 0) {
        parts.push(LF);
        for (const line of job.metadataLines) {
            parts.push(`${line}${LF}`);
        }
    }

    // Feed and cut
    parts.push('\n\n\n');
    parts.push(CUT);

    return Buffer.from(parts.join(''), 'utf8');
}


export async function printJob(job: PrintJob, printerName?: string): Promise<void> {
    const printer = printerName ?? await getConnectedPrinter();
    if (!printer) {
        throw new Error('No printer available');
    }

    const data = await formatPrintJob(job);

    if (printer.startsWith('/dev/')) {
        // Direct USB - write via dd or direct file write
        const { writeFile } = await import('fs/promises');
        await writeFile(printer, data);
    } else {
        // CUPS printer — use `lp`
        await new Promise<void>((resolve, reject) => {
            const child = execFile('lp', ['-d', printer, '-o', 'raw', '-'], (err) => {
                if (err) reject(err);
                else resolve();
            });
            child.stdin?.write(data);
            child.stdin?.end();
        });
    }
}


export async function printTestPage(printerName: string): Promise<void> {
    const testJob: PrintJob = {
        header: 'Windsor Test Page',
        lines: [
            'Normal size text - The quick brown fox jumps over the lazy dog.',
            '',
            '--- Font Demo ---',
        ],
        urls: ['https://github.com/SeaRyanC/d2p'],
        footer: 'Footer text here',
        metadataLines: [
            `Printed at: ${formatTimestamp(new Date())}`,
            `Printer: ${printerName}`,
        ],
    };

    const data = await formatPrintJob(testJob);

    if (printerName.startsWith('/dev/')) {
        const { writeFile } = await import('fs/promises');
        await writeFile(printerName, data);
    } else {
        await new Promise<void>((resolve, reject) => {
            const child = execFile('lp', ['-d', printerName, '-o', 'raw', '-'], (err) => {
                if (err) reject(err);
                else resolve();
            });
            child.stdin?.write(data);
            child.stdin?.end();
        });
    }
}


export function formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const mm = String(minutes).padStart(2, '0');
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hours}:${mm} ${ampm}`;
}

// suppress unused import warning
void readFile;
void execFileAsync;
