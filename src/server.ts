import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { execFile } from 'child_process';
import { build } from 'esbuild';
import { access, constants, readFile, stat } from 'fs/promises';
import { promisify } from 'util';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    getCurrentConfig,
    updateConfig,
    checkPassword,
    hashPassword,
    getConfigFilePath,
} from './config.ts';
import { printTestPage, getImageFeed, clearImageFeed, renderFeedHtml } from './printing/index.ts';
import type { DiagnosticEvent, BotStatus, PrintConfig } from './types.ts';

const MAX_EVENTS = 200;
const events: DiagnosticEvent[] = [];
const execFileAsync = promisify(execFile);

export const status: BotStatus = {
    connected: false,
    tag: null,
    startedAt: null,
    guilds: [],
    configuredServerId: null,
};

export function logEvent(type: DiagnosticEvent['type'], message: string): void {
    const event: DiagnosticEvent = { timestamp: new Date().toISOString(), type, message };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    console.log(`[${event.timestamp}] [${type.toUpperCase()}] ${message}`);
}


function checkAuth(req: IncomingMessage): boolean {
    const config = getCurrentConfig();
    if (!config.passwordHash) return true;

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;

    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    const password = colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);

    return checkPassword(password);
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!checkAuth(req)) {
        res.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="Windsor"',
            'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
    }
    return true;
}


function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

async function readPackageVersion(): Promise<string> {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(await readFile(join(runtimeDir, '..', 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof packageJson.version !== 'string') throw new Error('package.json does not contain a valid version');
    return packageJson.version;
}

async function updateGlobalBot(): Promise<string> {
    const configuredCandidates = [
        process.env['npm_execpath'],
        join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(dirname(process.execPath), 'npm'),
        '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
        '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
        '/usr/lib/node_modules/npm/bin/npm-cli.js',
        '/usr/share/nodejs/npm/bin/npm-cli.js',
        '/usr/local/bin/npm',
        '/opt/homebrew/bin/npm',
        '/usr/bin/npm',
    ]
        .filter((candidate): candidate is string => Boolean(candidate))
        .map(candidate => candidate.trim())
        .filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
    const pathCandidates = (process.env['PATH'] ?? '')
        .split(':')
        .filter(Boolean)
        .map(directory => join(directory, 'npm'));
    const npmCandidates = [...configuredCandidates, ...pathCandidates]
        .filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);

    logEvent('info', `Update requested; checking ${npmCandidates.length} npm candidate(s) (node=${process.execPath}, cwd=${process.cwd()})`);

    let npmCommand: { path: string; args: string[] } | undefined;
    for (const candidate of npmCandidates) {
        const command = candidate.endsWith('.js')
            ? { path: process.execPath, args: [candidate] }
            : { path: candidate, args: [] };
        try {
            // Validate the script itself, not just the Node executable used to run it.
            await access(candidate, constants.R_OK | (candidate.endsWith('.js') ? 0 : constants.X_OK));
            npmCommand = command;
            logEvent('info', `Using npm candidate ${candidate}${command.args.length > 0 ? ` via ${command.path}` : ''}`);
            break;
        } catch (error) {
            const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
            logEvent('info', `npm candidate unavailable: ${candidate} (${code})`);
        }
    }
    if (!npmCommand) {
        const path = process.env['PATH'] ?? '(unset)';
        logEvent('error', `Unable to locate an executable npm; PATH=${path}`);
        throw new Error('Unable to locate an executable npm; see diagnostics');
    }

    const npm = npmCommand;
    const runNpm = async (args: string[]) => {
        const commandArgs = [...npm.args, ...args];
        logEvent('info', `Running npm: ${npm.path} ${commandArgs.join(' ')}`);
        try {
            const result = await execFileAsync(npm.path, commandArgs, { env: process.env });
            logEvent('info', `npm completed successfully: ${args.join(' ')}`);
            return result;
        } catch (error) {
            const details = error instanceof Error ? error : new Error(String(error));
            const code = 'code' in details ? String(details.code) : 'unknown';
            const stderr = 'stderr' in details && typeof details.stderr === 'string'
                ? details.stderr.trim().slice(-1000)
                : '';
            logEvent('error', `npm failed (code=${code}, path=${npm.path}, args=${commandArgs.join(' ')})${stderr ? ` stderr=${stderr}` : ''}`);
            throw details;
        }
    };
    await runNpm(['install', '-g', 'windsor-bot@latest']);
    const { stdout } = await runNpm(['root', '-g']);
    const packageJsonPath = join(stdout.trim(), 'windsor-bot', 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof packageJson.version !== 'string') throw new Error('Updated package does not contain a valid version');
    return packageJson.version;
}

function hardRestart(): void {
    const child = spawn('/bin/sh', [
        '-c',
        'sleep 1; exec "$@"',
        'windsor-hard-restart',
        process.execPath,
        ...process.argv.slice(1),
    ], {
        detached: true,
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
    });
    child.unref();
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Buffer);
        total += buf.byteLength;
        if (total > 1_000_000) throw new Error('Request body too large');
        chunks.push(buf);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
}


let appBundleCache: { script: string; mtimeMs: number } | null = null;

async function loadAppScript(): Promise<string> {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const bundledApp = join(runtimeDir, 'web', 'app.bundle.js');
    const sourceEntryPoint = join(runtimeDir, '..', 'src', 'web', 'app.tsx');
    const appPath = await stat(bundledApp).then(() => bundledApp).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return sourceEntryPoint;
        }
        throw error;
    });
    const appStat = await stat(appPath);
    if (appPath === bundledApp) {
        if (appBundleCache && appBundleCache.mtimeMs === appStat.mtimeMs) {
            return appBundleCache.script;
        }
        const script = await readFile(appPath, 'utf8');
        appBundleCache = { script, mtimeMs: appStat.mtimeMs };
        return script;
    }
    if (appBundleCache && appBundleCache.mtimeMs === appStat.mtimeMs) {
        return appBundleCache.script;
    }

    const result = await build({
        entryPoints: [sourceEntryPoint],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        target: ['es2022'],
        jsx: 'automatic',
        jsxImportSource: 'preact',
        sourcemap: 'inline',
    });

    const firstFile = result.outputFiles[0];
    if (!firstFile) throw new Error('Failed to generate app bundle');
    appBundleCache = { script: firstFile.text, mtimeMs: appStat.mtimeMs };
    return firstFile.text;
}

function renderHtmlShell(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Windsor Control Panel</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0f1115; color: #f5f7fa; }
    a { color: #8ab4ff; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}


/** Registered Discord channels (set by bot on startup) */
let discordChannels: Array<{ id: string; name: string }> = [];

export function setDiscordChannels(channels: Array<{ id: string; name: string }>): void {
    discordChannels = channels;
}

let _restartHandler: (() => Promise<void>) | null = null;

export function setRestartHandler(fn: () => Promise<void>): void {
    _restartHandler = fn;
}

let _refreshChannelsHandler: (() => Promise<void>) | null = null;

export function setRefreshChannelsHandler(fn: () => Promise<void>): void {
    _refreshChannelsHandler = fn;
}

export function startDiagnosticsServer(port: number): void {
    const server = createServer(async (req, res) => {
        try {
            const method = req.method ?? 'GET';
            const rawUrl = req.url ?? '/';
            const urlPath = rawUrl.split('?')[0] ?? '/';

            // Static assets (no auth required)
            if (method === 'GET' && urlPath === '/app.js') {
                const script = await loadAppScript();
                res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
                res.end(script);
                return;
            }

            if (method === 'GET' && urlPath === '/') {
                const html = renderHtmlShell();
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }
            if (method === 'GET' && urlPath === '/feed') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderFeedHtml());
                return;
            }

            if (method === 'POST' && urlPath === '/feed/clear') {
                clearImageFeed();
                res.writeHead(303, { 'Location': '/feed' });
                res.end();
                return;
            }

            // All API routes require auth
            if (!requireAuth(req, res)) return;
            if (method === 'GET' && urlPath === '/api/events') {
                sendJson(res, 200, { status, events: [...events].reverse() });
                return;
            }

            if (method === 'GET' && urlPath === '/api/status') {
                sendJson(res, 200, status);
                return;
            }
            if (method === 'GET' && urlPath === '/api/version') {
                sendJson(res, 200, { version: await readPackageVersion() });
                return;
            }
            if (method === 'GET' && urlPath === '/api/config') {
                const cfg = getCurrentConfig();
                sendJson(res, 200, {
                    discordToken: cfg.discordToken ?? '',
                    openaiKey: cfg.openaiKey ?? '',
                    serverId: cfg.serverId ?? null,
                    diagnosticsPort: cfg.diagnosticsPort,
                    channels: cfg.channels,
                    configPath: getConfigFilePath(),
                });
                return;
            }

            if ((method === 'POST' || method === 'PUT') && urlPath === '/api/config') {
                const body = await readJsonBody(req);
                const patch: Record<string, unknown> = {};

                if (Object.hasOwn(body, 'discordToken') && typeof body['discordToken'] === 'string') {
                    patch['discordToken'] = body['discordToken'].trim() || undefined;
                }
                if (Object.hasOwn(body, 'serverId')) {
                    const v = body['serverId'];
                    patch['serverId'] = typeof v === 'string' && v.trim() ? v.trim() : undefined;
                }
                if (Object.hasOwn(body, 'openaiKey') && typeof body['openaiKey'] === 'string') {
                    patch['openaiKey'] = body['openaiKey'].trim() || undefined;
                }
                if (Object.hasOwn(body, 'diagnosticsPort') && typeof body['diagnosticsPort'] === 'number') {
                    patch['diagnosticsPort'] = body['diagnosticsPort'];
                }
                if (Object.hasOwn(body, 'password') && typeof body['password'] === 'string') {
                    const pw = body['password'].trim();
                    if (pw) {
                        patch['passwordHash'] = hashPassword(pw);
                    } else {
                        patch['passwordHash'] = undefined;
                    }
                }

                await updateConfig(patch as Parameters<typeof updateConfig>[0]);
                const updated = getCurrentConfig();
                sendJson(res, 200, {
                    discordToken: updated.discordToken ?? '',
                    openaiKey: updated.openaiKey ?? '',
                    serverId: updated.serverId ?? null,
                    diagnosticsPort: updated.diagnosticsPort,
                    channels: updated.channels,
                    configPath: getConfigFilePath(),
                });
                return;
            }
            if (method === 'GET' && urlPath === '/api/channels') {
                const config = getCurrentConfig();
                sendJson(res, 200, {
                    channels: config.channels,
                    discordChannels,
                    unmapped: discordChannels.filter(dc =>
                        !config.channels.find(m => m.channelId === dc.id)
                    ),
                });
                return;
            }

            if (method === 'POST' && urlPath === '/api/channels') {
                const body = await readJsonBody(req);
                const config = getCurrentConfig();
                const newMapping = body as unknown as import('./types.ts').ChannelMapping;
                const channels = [...config.channels, newMapping];
                await updateConfig({ channels });
                sendJson(res, 200, { channels: getCurrentConfig().channels });
                return;
            }

            const channelDeleteMatch = /^\/api\/channels\/([^/]+)$/.exec(urlPath);
            if (channelDeleteMatch) {
                const channelId = channelDeleteMatch[1]!;
                if (method === 'DELETE') {
                    const config = getCurrentConfig();
                    const channels = config.channels.filter(m => m.channelId !== channelId);
                    await updateConfig({ channels });
                    sendJson(res, 200, { channels: getCurrentConfig().channels });
                    return;
                }
                if (method === 'PUT') {
                    const body = await readJsonBody(req);
                    const config = getCurrentConfig();
                    const channels = config.channels.map(m =>
                        m.channelId === channelId ? { ...m, ...body } : m
                    ) as typeof config.channels;
                    await updateConfig({ channels });
                    sendJson(res, 200, { channels: getCurrentConfig().channels });
                    return;
                }
            }
            if (method === 'GET' && urlPath === '/api/print-config') {
                const cfg = getCurrentConfig();
                sendJson(res, 200, { printConfig: cfg.printConfig ?? null });
                return;
            }

            if ((method === 'POST' || method === 'PUT') && urlPath === '/api/print-config') {
                const body = await readJsonBody(req);
                const printConfig = body['printConfig'] as PrintConfig | null;
                const patch: Partial<import('./types.ts').WindsorConfig> = {};
                if (printConfig != null) patch.printConfig = printConfig;
                await updateConfig(patch);
                sendJson(res, 200, { printConfig: getCurrentConfig().printConfig ?? null });
                return;
            }

            if (method === 'POST' && urlPath === '/api/printer/test') {
                await printTestPage();
                logEvent('print', 'Test page printed');
                sendJson(res, 200, { ok: true });
                return;
            }
            if (method === 'POST' && urlPath === '/api/restart') {
                logEvent('info', 'Restart requested via API');
                sendJson(res, 200, { ok: true });
                if (_restartHandler) {
                    void _restartHandler();
                }
                return;
            }
            if (method === 'POST' && urlPath === '/api/update') {
                const version = await updateGlobalBot();
                logEvent('info', `Updated windsor-bot to version ${version}`);
                sendJson(res, 200, { version });
                return;
            }
            if (method === 'POST' && urlPath === '/api/hard-restart') {
                logEvent('info', 'Hard restart requested via API');
                sendJson(res, 200, { ok: true });
                hardRestart();
                return;
            }

            if (method === 'POST' && urlPath === '/api/channels/refresh') {
                if (_refreshChannelsHandler) {
                    await _refreshChannelsHandler();
                    const config = getCurrentConfig();
                    sendJson(res, 200, {
                        channels: config.channels,
                        discordChannels,
                        unmapped: discordChannels.filter(dc =>
                            !config.channels.find(m => m.channelId === dc.id)
                        ),
                    });
                } else {
                    sendJson(res, 503, { error: 'Bot not connected' });
                }
                return;
            }

            sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, 400, { error: message });
            logEvent('error', `API error: ${message}`);
        }
    });

    server.listen(port, '0.0.0.0', () => {
        logEvent('startup', `Diagnostics server listening on http://0.0.0.0:${port}`);
    });
}
