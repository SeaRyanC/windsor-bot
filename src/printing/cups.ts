import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import type { PrintJob, CupsPrintConfig } from '../types.ts';
import { renderJobToPng } from './render.ts';

export async function printJobCups(job: PrintJob, config: CupsPrintConfig): Promise<void> {
    const png = await renderJobToPng(job);
    const tmpPath = join(tmpdir(), `windsor-${Date.now()}.png`);
    await writeFile(tmpPath, png);

    try {
        await new Promise<void>((resolve, reject) => {
            execFile('lp', [
                '-d', config.printerName,
                '-o', `media=${config.paperSize}`,
                '-o', 'document-format=image/png',
                tmpPath,
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } finally {
        await unlink(tmpPath).catch(() => { /* ignore cleanup errors */ });
    }
}
