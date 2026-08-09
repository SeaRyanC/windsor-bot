import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dealPokerHand } from '../commands/poker.ts';

test('deals five board cards and four two-card hands without duplicates', () => {
    const deal = dealPokerHand(() => 0.5);
    const cards = [...deal.board, ...deal.hands.flat()];
    const keys = cards.map(card => `${card.rank}${card.suit}`);

    assert.equal(deal.board.length, 5);
    assert.equal(deal.hands.length, 4);
    assert.equal(cards.length, 13);
    assert.equal(new Set(keys).size, cards.length);
});
