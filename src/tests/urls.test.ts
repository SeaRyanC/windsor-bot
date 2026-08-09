import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls, parseCommand, stripUrls, replaceUrlsInText } from '../bot.ts';

test('parses commands with or without a space after the prefix', () => {
    assert.deepEqual(parseCommand('!command'), { name: 'command', args: '' });
    assert.deepEqual(parseCommand('! command'), { name: 'command', args: '' });
});

test('parses command arguments after optional prefix whitespace', () => {
    assert.deepEqual(parseCommand('! command first second'), {
        name: 'command',
        args: 'first second',
    });
});

test('extracts a single URL', () => {
    const urls = extractUrls('Check this out https://example.com for more info');
    assert.deepEqual(urls, ['https://example.com']);
});

test('strips trailing punctuation from URLs', () => {
    const urls = extractUrls('See https://example.com. For details.');
    assert.deepEqual(urls, ['https://example.com']);
});

test('extracts multiple URLs', () => {
    const urls = extractUrls('https://foo.com and https://bar.com are cool');
    assert.deepEqual(urls, ['https://foo.com', 'https://bar.com']);
});

test('caps at 5 URLs', () => {
    const text = 'https://a.com https://b.com https://c.com https://d.com https://e.com https://f.com';
    const urls = extractUrls(text);
    assert.equal(urls.length, 5);
});

test('ignores non-https URLs', () => {
    const urls = extractUrls('Visit http://example.com or ftp://files.com');
    assert.deepEqual(urls, []);
});

test('replaces single URL with [link]', () => {
    const text = 'See https://example.com for info';
    const urls = extractUrls(text);
    const result = replaceUrlsInText(text, urls);
    assert.equal(result, 'See [link] for info');
});

test('replaces multiple URLs with [link N]', () => {
    const text = 'See https://foo.com and https://bar.com';
    const urls = extractUrls(text);
    const result = replaceUrlsInText(text, urls);
    assert.ok(result.includes('[link 1]'));
    assert.ok(result.includes('[link 2]'));
});

test('strips all URLs from text', () => {
    const text = 'Buy this https://shop.com today!';
    const result = stripUrls(text);
    assert.ok(!result.includes('https://'));
    assert.ok(result.includes('Buy this'));
});

test('message over 800 chars after URL strip is too long', () => {
    const longText = 'A'.repeat(801);
    const stripped = stripUrls(longText);
    assert.ok(stripped.length > 800);
});

test('message exactly 800 chars is not too long', () => {
    const text = 'A'.repeat(800);
    const stripped = stripUrls(text);
    assert.equal(stripped.length, 800);
    assert.ok(stripped.length <= 800);
});
