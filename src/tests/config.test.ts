import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelMapping } from '../types.ts';

const configDir = await mkdtemp(`${tmpdir()}/windsor-config-test-`);
process.env['WINDSOR_CONFIG_PATH'] = `${configDir}/windsor.config.json`;
const { reconcileChannels, getCurrentConfig, updateConfig, hashPassword } = await import('../config.ts');

test.after(async () => {
    await rm(configDir, { recursive: true, force: true });
});

// Setup: initialize config with some channel mappings
async function withChannels(mappings: ChannelMapping[], fn: () => Promise<void>): Promise<void> {
    const original = getCurrentConfig().channels;
    await updateConfig({ channels: mappings });
    try {
        await fn();
    } finally {
        await updateConfig({ channels: original });
    }
}

test('reconcileChannels: matches by ID and updates name', async () => {
    await withChannels([
        { channelId: '111', channelName: 'old-name', config: { type: 'on-demand' } },
    ], async () => {
        await reconcileChannels([{ id: '111', name: 'new-name' }]);
        const channels = getCurrentConfig().channels;
        assert.equal(channels.length, 1);
        assert.equal(channels[0]?.channelName, 'new-name');
        assert.equal(channels[0]?.channelId, '111');
    });
});

test('reconcileChannels: matches by name and updates ID', async () => {
    await withChannels([
        { channelId: '111', channelName: 'my-channel', config: { type: 'on-demand' } },
    ], async () => {
        await reconcileChannels([{ id: '222', name: 'my-channel' }]);
        const channels = getCurrentConfig().channels;
        assert.equal(channels.length, 1);
        assert.equal(channels[0]?.channelId, '222');
        assert.equal(channels[0]?.channelName, 'my-channel');
    });
});

test('reconcileChannels: deletes unmatched channels', async () => {
    await withChannels([
        { channelId: '111', channelName: 'gone-channel', config: { type: 'on-demand' } },
    ], async () => {
        await reconcileChannels([{ id: '999', name: 'different-channel' }]);
        const channels = getCurrentConfig().channels;
        assert.equal(channels.length, 0);
    });
});

test('reconcileChannels: does NOT delete if all discord channels missing (server blip)', async () => {
    await withChannels([
        { channelId: '111', channelName: 'my-channel', config: { type: 'on-demand' } },
    ], async () => {
        await reconcileChannels([]);
        const channels = getCurrentConfig().channels;
        assert.equal(channels.length, 1);
    });
});

test('hashPassword produces consistent hash', () => {
    const hash1 = hashPassword('secret');
    const hash2 = hashPassword('secret');
    assert.equal(hash1, hash2);
});

test('hashPassword produces different hashes for different passwords', () => {
    assert.notEqual(hashPassword('abc'), hashPassword('xyz'));
});

test('token usage 24h tracking', async () => {
    // Setup with stale and recent entries
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    await updateConfig({
        tokenUsage: [
            { timestamp: twoDaysAgo, tokens: 10000 },
            { timestamp: twoHoursAgo, tokens: 5000 },
        ],
    });

    const { getTokenUsage24h } = await import('../ai.ts');
    const used = getTokenUsage24h();
    // Should only count the 2-hours-ago entry (5000), not the 2-days-ago one
    assert.equal(used, 5000);
});
