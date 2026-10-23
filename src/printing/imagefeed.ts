import type { PrintJob } from '../types.ts';
import { renderJobToPng } from './render.ts';

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

export async function printJobImageFeed(job: PrintJob): Promise<void> {
    const png = await renderJobToPng(job);
    feed.unshift({ timestamp: new Date(), label: job.header ?? job.lines[0] ?? 'print', png });
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
    body { margin: 0; padding: 24px; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #f5f7fa; max-width: 700px; }
    h1 { margin-top: 0; }
    button { background: #2e7dff; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>Image Feed</h1>
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
