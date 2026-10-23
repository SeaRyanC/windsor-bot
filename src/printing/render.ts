import { readFile } from 'fs/promises';
import { extname } from 'path';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import type { PrintJob } from '../types.ts';

const PAGE_WIDTH = 560;
const MARGIN = 20;
const TEXT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT_SCALE = 1.5;
const HEADER_SIZE = 28 * FONT_SCALE;
const BODY_NORMAL_SIZE = 18 * FONT_SCALE;
const BODY_TALL_SIZE = 22 * FONT_SCALE;
const BODY_DOUBLE_SIZE = 28 * FONT_SCALE;
const FOOTER_SIZE = 16 * FONT_SCALE;
const METADATA_SIZE = 14 * FONT_SCALE;
const QR_LABEL_SIZE = 16 * FONT_SCALE;
const QR_URL_SIZE = 14 * FONT_SCALE;
const FONT_REGULAR = new URL('../../assets/fonts/Inter-Regular.ttf', import.meta.url).pathname;
const FONT_BOLD = new URL('../../assets/fonts/Inter-Bold.ttf', import.meta.url).pathname;

interface RenderLine {
    text: string;
    size: number;
    bold?: boolean;
    gapAfter?: number;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function wrapText(text: string, size: number): string[] {
    const maxCharacters = Math.max(1, Math.floor(TEXT_WIDTH / (size * 0.54)));
    const lines: string[] = [];
    for (const paragraph of (text || ' ').split(/\r?\n/)) {
        let current = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (word.length > maxCharacters) {
                if (current) lines.push(current);
                for (let start = 0; start < word.length; start += maxCharacters) {
                    const part = word.slice(start, start + maxCharacters);
                    if (part.length === maxCharacters) lines.push(part);
                    else current = part;
                }
                continue;
            }
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length <= maxCharacters) current = candidate;
            else {
                if (current) lines.push(current);
                current = word;
            }
        }
        if (current) lines.push(current);
        if (paragraph === '') lines.push('');
    }
    return lines.length > 0 ? lines : [''];
}

function addText(lines: RenderLine[], text: string, size: number, bold = false, gapAfter = 0): void {
    for (const line of wrapText(text, size)) lines.push({ text: line, size, bold });
    if (gapAfter > 0) lines[lines.length - 1]!.gapAfter = gapAfter;
}

async function imageData(path: string): Promise<string> {
    const data = await readFile(path);
    const extension = extname(path).toLowerCase();
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.svg' ? 'image/svg+xml'
            : 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
}

export async function renderJobToPng(job: PrintJob): Promise<Buffer> {
    const lines: RenderLine[] = [];
    if (job.header) addText(lines, job.header, HEADER_SIZE, true, 12);

    let icon: { data: string; width: number; height: number } | undefined;
    if (job.iconPath) {
        try {
            icon = { data: await imageData(job.iconPath), width: TEXT_WIDTH, height: 220 };
        } catch (error) {
            throw new Error(`Failed to load image ${job.iconPath}`, { cause: error });
        }
    }

    const bodySize = job.fontSize === 'double'
        ? BODY_DOUBLE_SIZE
        : job.fontSize === 'tall'
            ? BODY_TALL_SIZE
            : BODY_NORMAL_SIZE;
    for (const line of job.lines) addText(lines, line || ' ', bodySize);
    if (job.lines.length > 0) lines[lines.length - 1]!.gapAfter = 12;

    const qrEntries: { label: string; url: string; data: string }[] = [];
    for (let i = 0; i < job.urls.length; i++) {
        const url = job.urls[i];
        if (!url) continue;
        qrEntries.push({
            label: job.urls.length === 1 ? 'Scan to open link' : `Link ${i + 1}`,
            url,
            data: `data:image/png;base64,${(await QRCode.toBuffer(url, { type: 'png', width: 120, margin: 1 })).toString('base64')}`,
        });
    }
    if (job.footer) addText(lines, job.footer, FOOTER_SIZE, true, 8);
    for (const line of job.metadataLines ?? []) addText(lines, line, METADATA_SIZE);

    const textHeight = lines.reduce((height, line) => height + line.size * 1.35 + (line.gapAfter ?? 0), 0);
    const iconHeight = icon ? icon.height + 8 : 0;
    const qrHeight = qrEntries.reduce((height, entry) =>
        height + 8 + QR_LABEL_SIZE + 4 + 128
        + QR_URL_SIZE * 1.35 * wrapText(entry.url, QR_URL_SIZE).length, 0);
    const height = Math.max(100, MARGIN * 2 + textHeight + iconHeight + qrHeight + 20);
    let y = MARGIN;
    const svgLines: string[] = [];
    const text = (line: RenderLine): void => {
        y += line.size;
        svgLines.push(`<text x="${MARGIN}" y="${y}" font-family="Inter" font-size="${line.size}" font-weight="${line.bold ? 700 : 400}">${escapeXml(line.text)}</text>`);
        y += line.size * 0.35 + (line.gapAfter ?? 0);
    };

    for (const line of lines.slice(0, job.header ? wrapText(job.header, HEADER_SIZE).length : 0)) text(line);
    if (icon) {
        y += 8;
        svgLines.push(`<image x="${MARGIN}" y="${y}" width="${icon.width}" height="${icon.height}" preserveAspectRatio="xMidYMid meet" href="${icon.data}"/>`);
        y += icon.height + 8;
    }
    const firstBody = job.header ? wrapText(job.header, HEADER_SIZE).length : 0;
    for (const line of lines.slice(firstBody)) text(line);
    for (const entry of qrEntries) {
        y += 8;
        svgLines.push(`<text x="${MARGIN}" y="${y + QR_LABEL_SIZE}" font-family="Inter" font-size="${QR_LABEL_SIZE}">${escapeXml(entry.label)}</text>`);
        y += QR_LABEL_SIZE + 4;
        svgLines.push(`<image x="${MARGIN}" y="${y}" width="120" height="120" href="${entry.data}"/>`);
        y += 128;
        for (const line of wrapText(entry.url, QR_URL_SIZE)) {
            svgLines.push(`<text x="${MARGIN}" y="${y + QR_URL_SIZE}" font-family="Inter" font-size="${QR_URL_SIZE}">${escapeXml(line)}</text>`);
            y += QR_URL_SIZE * 1.35;
        }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" viewBox="0 0 ${PAGE_WIDTH} ${height}">
<rect width="100%" height="100%" fill="white"/>
<g fill="black">${svgLines.join('')}</g>
</svg>`;
    return new Resvg(svg, { font: { fontFiles: [FONT_REGULAR, FONT_BOLD] } }).render().asPng();
}
