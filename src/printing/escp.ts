import { Printer, InMemory, Style, Align, Cut, Image } from 'escpos-buffer';
import { SerialPort } from 'serialport';
import { Jimp, ResizeStrategy } from 'jimp';
import type { PrintJob } from '../types.ts';

const COLS_NORMAL = 48;
const COLS_DOUBLE = 24;

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


type FontSize = 'double' | 'tall' | 'normal';

function chooseFontForLines(totalLines: number): { fontSize: FontSize; cols: number } {
    // Keep short messages large without relying on the printer's
    // double-width glyph capacity, which varies by model and font.
    if (totalLines <= 8) {
        return { fontSize: 'tall', cols: COLS_NORMAL };
    } else {
        return { fontSize: 'normal', cols: COLS_NORMAL };
    }
}

function countLayoutLines(lines: string[]): number {
    return lines.length <= 2 ? 2 : lines.length;
}


export async function buildEscpBuffer(job: PrintJob): Promise<Buffer> {
    const conn = new InMemory();
    const printer = await Printer.CONNECT('TM-T20', conn);

    const { fontSize, cols } = chooseFontForLines(countLayoutLines(job.lines));

    // Header
    if (job.header) {
        const headerLines = wrapText(job.header, COLS_DOUBLE);
        for (const line of headerLines) {
            await printer.writeln(line, Style.Bold | Style.DoubleWidth | Style.DoubleHeight, Align.Center);
        }
        await printer.feed(1);
    }

    // Icon / sprite image
    if (job.iconPath) {
        try {
            const img = await Jimp.read(job.iconPath);
            const PRINT_WIDTH = 576; // ~80mm at 180dpi
            const scale = img.width <= PRINT_WIDTH
                ? Math.floor(PRINT_WIDTH / img.width)
                : PRINT_WIDTH / img.width;
            img.resize({ w: Math.round(img.width * scale), h: Math.round(img.height * scale), mode: ResizeStrategy.NEAREST_NEIGHBOR });
            const escImage = new Image(img.bitmap as { width: number; height: number; data: Buffer });
            await printer.draw(escImage);
            await printer.feed(1);
        } catch (error) {
            throw new Error(`Failed to load or print image ${job.iconPath}`, { cause: error });
        }
    }

    // Primary text
    if (job.lines.length > 0) {
        const widthStyle = fontSize === 'double'
            ? Style.DoubleWidth | Style.DoubleHeight
            : fontSize === 'tall'
                ? Style.DoubleHeight
                : 0;

        for (const line of job.lines) {
            const wrapped = wrapText(line, cols);
            for (const l of wrapped) {
                await printer.writeln(l, widthStyle);
            }
        }
        await printer.feed(1);
    }

    // URLs (printed as labelled text; QR code can be added later)
    if (job.urls.length > 0) {
        await printer.feed(1);
        for (let i = 0; i < job.urls.length; i++) {
            const url = job.urls[i];
            if (!url) continue;
            const label = job.urls.length === 1 ? '[link]' : `[link ${i + 1}]`;
            await printer.writeln(label, Style.Bold);
            const urlLines = wrapText(url, COLS_NORMAL);
            for (const l of urlLines) {
                await printer.writeln(l);
            }
        }
    }

    // Footer
    if (job.footer) {
        await printer.feed(1);
        const footerLines = wrapText(job.footer, COLS_NORMAL);
        for (const line of footerLines) {
            await printer.writeln(line, Style.Bold);
        }
    }

    // Metadata footer
    if (job.metadataLines && job.metadataLines.length > 0) {
        await printer.feed(1);
        for (const line of job.metadataLines) {
            await printer.writeln(line);
        }
    }

    await printer.feed(3);
    await printer.cutter(Cut.Partial);
    await printer.close();

    return conn.buffer();
}


export async function printJobEscp(job: PrintJob, portPath: string): Promise<void> {
    const data = await buildEscpBuffer(job);

    // USB printer devices (e.g. /dev/usb/lp0) don't support serial ioctl;
    // write directly to the device file instead.
    if (/\/lp\d+$/.test(portPath)) {
        const { writeFile } = await import('fs/promises');
        await writeFile(portPath, data);
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const port = new SerialPort({ path: portPath, baudRate: 115200 });

        port.on('error', reject);
        port.on('open', () => {
            port.write(data, (err) => {
                if (err) { reject(err); return; }
                port.drain((drainErr) => {
                    port.close((closeErr) => {
                        if (drainErr) reject(drainErr);
                        else if (closeErr) reject(closeErr);
                        else resolve();
                    });
                });
            });
        });
    });
}
