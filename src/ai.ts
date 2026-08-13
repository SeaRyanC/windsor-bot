import { createHash } from 'crypto';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';
import OpenAI from 'openai';
import { getCurrentConfig, updateConfig } from './config.ts';
import { logEvent } from './server.ts';

const MODEL = 'gpt-5.4-nano';
const IMAGE_MODEL = 'gpt-image-1-mini';
const TOKEN_LIMIT_24H = 200_000;


export function trackTokenUsage(tokens: number): void {
    const config = getCurrentConfig();
    const entry = { timestamp: new Date().toISOString(), tokens };
    const usage = [...config.tokenUsage, entry];
    // Keep only entries from the last 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const pruned = usage.filter(e => e.timestamp >= cutoff);
    void updateConfig({ tokenUsage: pruned });
}

export function getTokenUsage24h(): number {
    const config = getCurrentConfig();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return config.tokenUsage
        .filter(e => e.timestamp >= cutoff)
        .reduce((sum, e) => sum + e.tokens, 0);
}

export async function isOverTokenLimit(): Promise<boolean> {
    const used = getTokenUsage24h();
    if (used >= TOKEN_LIMIT_24H) {
        logEvent('error', `Token limit exceeded (${used} tokens in last 24h). Deleting OpenAI key.`);
        const config = getCurrentConfig();
        const updated = { ...config };
        delete updated.openaiKey;
        await updateConfig(updated);
        return true;
    }
    return false;
}


function getClient(): OpenAI | null {
    const key = getCurrentConfig().openaiKey;
    if (!key) return null;
    return new OpenAI({ apiKey: key });
}

function getIconCachePath(text: string, cacheDir: string): string {
    const prompt = `Black-on-transparent line drawing icon for the TODO item: "${text}". Do not produce any text. Use big, thick lines. No fine detailing.`;
    const hash = createHash('sha1').update(prompt).digest('hex').slice(0, 9);
    return join(cacheDir, `${hash}.png`);
}

export async function isIconCached(text: string, cacheDir: string): Promise<boolean> {
    try {
        await access(getIconCachePath(text, cacheDir));
        return true;
    } catch {
        return false;
    }
}

export async function generateIcon(text: string, cacheDir: string): Promise<string | null> {
    const prompt = `Black-on-transparent line drawing icon for the TODO item: "${text}". Do not produce any text. Use big, thick lines. No fine detailing.`;
    const cachePath = getIconCachePath(text, cacheDir);

    // Check cache first
    try {
        await access(cachePath);
        return cachePath;
    } catch {
        // not cached
    }

    const client = getClient();
    if (!client) return null;

    if (await isOverTokenLimit()) return null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await client.images.generate({
                model: IMAGE_MODEL,
                prompt,
                n: 1,
                size: '1024x1024',
                quality: 'low',
                background: 'transparent',
                output_format: 'png',
            } as Parameters<typeof client.images.generate>[0]) as import("openai/resources/images.js").ImagesResponse;

            const imageData = response.data?.[0];
            if (!imageData) throw new Error('No image data returned');

            let imageBuffer: Buffer;
            if ('b64_json' in imageData && imageData.b64_json) {
                imageBuffer = Buffer.from(imageData.b64_json, 'base64');
            } else if ('url' in imageData && imageData.url) {
                const res = await fetch(imageData.url);
                imageBuffer = Buffer.from(await res.arrayBuffer());
            } else {
                throw new Error('No image URL or base64 data');
            }

            await mkdir(cacheDir, { recursive: true });
            await writeFile(cachePath, imageBuffer);
            return cachePath;
        } catch (err) {
            logEvent('error', `Icon generation attempt ${attempt + 1} failed: ${err}`);
            if (attempt === 2) return null;
        }
    }

    return null;
}

// suppress unused import warning
void readFile;
