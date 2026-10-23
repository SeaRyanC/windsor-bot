import { Printer, InMemory, Cut, Image } from 'escpos-buffer';
import { SerialPort } from 'serialport';
import type { PrintJob } from '../types.ts';
import { renderJobToPng } from './render.ts';

const PRINTER_INIT = '\x1B@\x1Bt\x02\x1BM\x00\x1DL\x00\x00\x1DW\x00\x02';

export async function buildEscpBuffer(job: PrintJob): Promise<Buffer> {
    const conn = new InMemory();
    const printer = await Printer.CONNECT('TM-T20', conn);
    await conn.write(Buffer.from(PRINTER_INIT, 'ascii'));

    const png = await renderJobToPng(job);
    const { Jimp } = await import('jimp');
    const img = await Jimp.fromBuffer(png);
    await printer.draw(new Image(img.bitmap as { width: number; height: number; data: Buffer }));
    await printer.feed(3);
    await printer.cutter(Cut.Partial);
    await printer.close();
    return conn.buffer();
}

export async function printJobEscp(job: PrintJob, portPath: string): Promise<void> {
    const data = await buildEscpBuffer(job);
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
