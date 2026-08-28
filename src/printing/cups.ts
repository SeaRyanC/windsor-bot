import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import PDFDocument from 'pdfkit';
import type { PrintJob } from '../types.ts';
import type { CupsPrintConfig } from '../types.ts';


const MARGIN = 36; // 0.5 inch
const FONT_HEADER = 18;
const FONT_BODY_LARGE = 14;
const FONT_BODY_NORMAL = 10;
const FONT_FOOTER = 9;
const LINE_GAP = 4;

function chooseFontSize(totalLines: number): number {
    if (totalLines <= 4) return FONT_BODY_LARGE;
    return FONT_BODY_NORMAL;
}

function countLayoutLines(lines: string[]): number {
    const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return longestLine > 24
        ? 9
        : lines.length <= 2
            ? 2
            : lines.length;
}


export async function buildPdfBuffer(job: PrintJob, paperSize: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];

        const doc = new PDFDocument({
            size: paperSize,
            margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
            autoFirstPage: true,
            bufferPages: false,
        });

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const bodyFontSize = chooseFontSize(countLayoutLines(job.lines));

        // Header
        if (job.header) {
            doc.fontSize(FONT_HEADER).font('Helvetica-Bold').text(job.header, { align: 'center', lineGap: LINE_GAP });
            doc.moveDown(0.5);
        }

        if (job.iconPath) {
            try {
                doc.image(job.iconPath, {
                    fit: [doc.page.width - MARGIN * 2, 300],
                    align: 'center',
                    valign: 'center',
                });
                doc.moveDown(0.5);
            } catch (error) {
                throw new Error(`Failed to load image ${job.iconPath}`, { cause: error });
            }
        }

        // Primary text
        if (job.lines.length > 0) {
            doc.fontSize(bodyFontSize).font('Helvetica');
            for (const line of job.lines) {
                doc.text(line || ' ', { lineGap: LINE_GAP });
            }
            doc.moveDown(0.5);
        }

        // URLs
        if (job.urls.length > 0) {
            doc.moveDown(0.25);
            for (let i = 0; i < job.urls.length; i++) {
                const url = job.urls[i];
                if (!url) continue;
                const label = job.urls.length === 1 ? 'Link:' : `Link ${i + 1}:`;
                doc.fontSize(FONT_FOOTER).font('Helvetica-Bold').text(label, { continued: true });
                doc.font('Helvetica').text(` ${url}`, { link: url, underline: true, lineGap: LINE_GAP });
            }
            doc.moveDown(0.25);
        }

        // Footer
        if (job.footer) {
            doc.moveDown(0.25);
            doc.fontSize(FONT_FOOTER).font('Helvetica-Bold').text(job.footer, { lineGap: LINE_GAP });
        }

        // Metadata footer
        if (job.metadataLines && job.metadataLines.length > 0) {
            doc.moveDown(0.25);
            doc.fontSize(FONT_FOOTER).font('Helvetica');
            for (const line of job.metadataLines) {
                doc.text(line, { lineGap: 2 });
            }
        }

        doc.end();
    });
}


export async function printJobCups(job: PrintJob, config: CupsPrintConfig): Promise<void> {
    const pdfBuf = await buildPdfBuffer(job, config.paperSize);

    const tmpPath = join(tmpdir(), `windsor-${Date.now()}.pdf`);
    await writeFile(tmpPath, pdfBuf);

    try {
        await new Promise<void>((resolve, reject) => {
            execFile('lp', ['-d', config.printerName, '-o', `media=${config.paperSize}`, tmpPath], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } finally {
        await unlink(tmpPath).catch(() => { /* ignore cleanup errors */ });
    }
}
