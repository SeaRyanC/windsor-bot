import { Jimp, loadFont, measureText, JimpMime, ResizeStrategy } from 'jimp';
import QRCode from 'qrcode';
import type { PrintJob } from '../types.ts';


const FONT_DIR = new URL('../../node_modules/@jimp/plugin-print/dist/fonts/open-sans/', import.meta.url).pathname;

const FONT_16 = `${FONT_DIR}open-sans-16-black/open-sans-16-black.fnt`;
const FONT_32 = `${FONT_DIR}open-sans-32-black/open-sans-32-black.fnt`;


interface FeedEntry {
    timestamp: Date;
    label: string;
    png: Buffer;
}

const MAX_FEED_ENTRIES = 50;
const feed: FeedEntry[] = [];

export function getImageFeed(): FeedEntry[] {
    return feed;
}

export function clearImageFeed(): void {
    feed.length = 0;
}


const PAGE_WIDTH = 560; // ~80mm at 180dpi
const MARGIN = 20;
const LINE_HEIGHT_NORMAL = 20;
const LINE_HEIGHT_LARGE = 36;
const TEXT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function chooseLineHeight(totalLines: number): { lineHeight: number; fontPath: string } {
    if (totalLines <= 4) return { lineHeight: LINE_HEIGHT_LARGE, fontPath: FONT_32 };
    return { lineHeight: LINE_HEIGHT_NORMAL, fontPath: FONT_16 };
}

function countLayoutLines(lines: string[]): number {
    const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
    return longestLine > 24
        ? 9
        : lines.length <= 2
            ? 2
            : lines.length;
}

function wrapText(text: string, font: Awaited<ReturnType<typeof loadFont>>, maxWidth: number): string[] {
    if (!text) return [''];
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (measureText(font, candidate) <= maxWidth) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
}


const QR_SIZE = 120; // pixels per QR code

async function renderQrCode(url: string) {
    const pngBuf = await QRCode.toBuffer(url, { type: 'png', width: QR_SIZE, margin: 1 });
    return Jimp.fromBuffer(pngBuf);
}


export async function renderJobToPng(job: PrintJob): Promise<Buffer> {
    const totalLines = countLayoutLines(job.lines);
    const { lineHeight, fontPath } = chooseLineHeight(totalLines);

    const fontNormal = await loadFont(FONT_16);
    const fontLarge = await loadFont(FONT_32);
    const bodyFont = lineHeight === LINE_HEIGHT_LARGE ? fontLarge : fontNormal;

    // Pre-load and scale the icon so we know its exact dimensions before sizing the canvas
    let scaledSprite: Awaited<ReturnType<typeof Jimp.read>> | null = null;
    if (job.iconPath) {
        try {
            const sprite = await Jimp.read(job.iconPath);
            // For small pixel-art sprites: scale up by integer factor for crisp pixels.
            // For large icons: scale down to fit within TEXT_WIDTH.
            const scale = sprite.width <= TEXT_WIDTH
                ? Math.floor(TEXT_WIDTH / sprite.width)
                : TEXT_WIDTH / sprite.width;
            sprite.resize({ w: Math.round(sprite.width * scale), h: Math.round(sprite.height * scale), mode: ResizeStrategy.NEAREST_NEIGHBOR });
            scaledSprite = sprite;
        } catch (error) {
            throw new Error(`Failed to load image ${job.iconPath}`, { cause: error });
        }
    }

    // Measure total height now that icon dimensions are known
    let estimatedHeight = MARGIN * 2;
    if (job.header) estimatedHeight += LINE_HEIGHT_LARGE * 2 + 12;
    if (scaledSprite) estimatedHeight += scaledSprite.height + 8;
    for (const line of job.lines) {
        const wrapped = wrapText(line || ' ', bodyFont, TEXT_WIDTH);
        estimatedHeight += wrapped.length * lineHeight;
    }
    if (job.urls.length > 0) estimatedHeight += job.urls.length * (QR_SIZE + LINE_HEIGHT_NORMAL + 8) + 8;
    if (job.footer) estimatedHeight += LINE_HEIGHT_NORMAL * 2 + 8;
    if (job.metadataLines) estimatedHeight += job.metadataLines.length * LINE_HEIGHT_NORMAL + 8;
    estimatedHeight += 20; // bottom padding

    const img = new Jimp({ width: PAGE_WIDTH, height: Math.max(estimatedHeight, 100), color: 0xffffffff });

    let y = MARGIN;

    const printLine = (text: string, font: Awaited<ReturnType<typeof loadFont>>, lh: number): void => {
        img.print({ font, x: MARGIN, y, text, maxWidth: TEXT_WIDTH });
        y += lh;
    };

    // Header
    if (job.header) {
        const headerLines = wrapText(job.header, fontLarge, TEXT_WIDTH);
        for (const line of headerLines) {
            img.print({ font: fontLarge, x: MARGIN, y, text: line, maxWidth: TEXT_WIDTH });
            y += LINE_HEIGHT_LARGE;
        }
        y += 12;
    }

    // Icon / sprite image
    if (scaledSprite) {
        img.composite(scaledSprite, MARGIN, y);
        y += scaledSprite.height + 8;
    }

    // Primary text
    for (const line of job.lines) {
        const wrapped = wrapText(line || ' ', bodyFont, TEXT_WIDTH);
        for (const l of wrapped) {
            printLine(l, bodyFont, lineHeight);
        }
    }
    y += 8;

    // URLs — render each as a QR code with a label beneath it
    if (job.urls.length > 0) {
        y += 8;
        for (let i = 0; i < job.urls.length; i++) {
            const url = job.urls[i];
            if (!url) continue;
            const label = job.urls.length === 1 ? '🔗 Scan to open link' : `🔗 Link ${i + 1}`;
            printLine(label, fontNormal, LINE_HEIGHT_NORMAL);

            const qrImg = await renderQrCode(url);
            img.composite(qrImg, MARGIN, y);
            y += QR_SIZE + 4;

            // Print the URL text in small font next to/below the QR
            const urlLines = wrapText(url, fontNormal, TEXT_WIDTH);
            for (const l of urlLines) {
                printLine(l, fontNormal, LINE_HEIGHT_NORMAL);
            }
            y += 4;
        }
    }

    // Footer
    if (job.footer) {
        y += 8;
        const footerLines = wrapText(job.footer, fontNormal, TEXT_WIDTH);
        for (const line of footerLines) {
            printLine(line, fontNormal, LINE_HEIGHT_NORMAL);
        }
    }

    // Metadata
    if (job.metadataLines && job.metadataLines.length > 0) {
        y += 8;
        for (const line of job.metadataLines) {
            printLine(line, fontNormal, LINE_HEIGHT_NORMAL);
        }
    }

    // Draw a dashed separator line at the bottom to simulate a receipt cut
    const cutY = y + 10;
    if (cutY < img.height) {
        for (let x = MARGIN; x < PAGE_WIDTH - MARGIN; x += 8) {
            img.setPixelColor(0x888888ff, x, cutY);
            img.setPixelColor(0x888888ff, x + 1, cutY);
        }
    }

    return img.getBuffer(JimpMime.png);
}


export async function printJobImageFeed(job: PrintJob): Promise<void> {
    const png = await renderJobToPng(job);
    const label = job.header ?? job.lines[0] ?? 'print';
    feed.unshift({ timestamp: new Date(), label, png });
    if (feed.length > MAX_FEED_ENTRIES) feed.length = MAX_FEED_ENTRIES;
}

export async function printTestJobImageFeed(job: PrintJob): Promise<void> {
    return printJobImageFeed(job);
}


export function renderFeedHtml(): string {
    const items = feed.map((entry, i) => {
        const b64 = entry.png.toString('base64');
        const ts = entry.timestamp.toLocaleString();
        return `
        <div style="margin-bottom:32px; border-bottom: 1px solid #333; padding-bottom:24px;">
            <p style="color:#888; margin:0 0 8px;">#${i + 1} — ${ts} — <em>${escHtml(entry.label)}</em></p>
            <img src="data:image/png;base64,${b64}" style="max-width:100%; border:1px solid #444;" alt="print job ${i + 1}"/>
        </div>`;
    }).join('\n');

    const emptyMsg = feed.length === 0
        ? '<p style="color:#888">No print jobs yet. Switch to "Image Feed" mode and trigger a print.</p>'
        : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Windsor Image Feed</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0f1115; color: #f5f7fa; max-width: 700px; }
    h1 { margin-top: 0; }
    button { background: #2e7dff; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>🖨️ Image Feed</h1>
  <form method="POST" action="/feed/clear" style="display:inline">
    <button type="submit">Clear Feed</button>
  </form>
  <p style="color:#888; margin-top:0;">Newest first. Refresh the page to see new jobs. ${feed.length} job(s).</p>
  ${emptyMsg}
  ${items}
</body>
</html>`;
}

function escHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
