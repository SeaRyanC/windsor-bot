import { readFile, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Jimp, JimpMime, loadFont, measureText, ResizeStrategy } from 'jimp';
import { Resvg } from '@resvg/resvg-js';
import type { PrintJob } from '../types.ts';
import type { Command, CommandResultPass, CommandRunContext } from './index.ts';
import { tryExecCommandFunction } from './util.ts';

const FONT_DIR = new URL('../../node_modules/@jimp/plugin-print/dist/fonts/open-sans/', import.meta.url).pathname;
const FONT_64 = `${FONT_DIR}open-sans-64-black/open-sans-64-black.fnt`;
const FONT_128 = `${FONT_DIR}open-sans-128-black/open-sans-128-black.fnt`;

const IMAGE_WIDTH = 560;
const MARGIN = 24;
const CARD_WIDTH = 88;
const CARD_HEIGHT = 118;
const CARD_GAP = 8;
const HAND_GAP = 12;
const TITLE_HEIGHT = 48;
const SUIT_MARGIN = 8;
const RENDER_SCALE = 3;

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
type Card = { rank: typeof RANKS[number]; suit: typeof SUITS[number] };
type Image = InstanceType<typeof Jimp>;
type SuitImages = Record<Card['suit'], Image>;

const SUIT_FILES: Record<Card['suit'], URL> = {
    clubs: new URL('../../assets/poker/club.svg', import.meta.url),
    diamonds: new URL('../../assets/poker/diamond.svg', import.meta.url),
    hearts: new URL('../../assets/poker/heart.svg', import.meta.url),
    spades: new URL('../../assets/poker/spade.svg', import.meta.url),
};

export interface PokerDeal {
    board: Card[];
    hands: [Card, Card][];
}

export function dealPokerHand(random: () => number = Math.random): PokerDeal {
    const deck: Card[] = SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })));
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }

    const board = deck.slice(0, 5);
    const hands = Array.from({ length: 4 }, (_, index) => {
        const offset = 5 + index * 2;
        return [deck[offset]!, deck[offset + 1]!] as [Card, Card];
    });
    return { board, hands };
}

function drawBox(image: Image, left: number, top: number): void {
    left *= RENDER_SCALE;
    top *= RENDER_SCALE;
    const right = left + CARD_WIDTH * RENDER_SCALE;
    const bottom = top + CARD_HEIGHT * RENDER_SCALE;
    for (let x = left; x <= right; x++) {
        image.setPixelColor(0x000000ff, x, top);
        image.setPixelColor(0x000000ff, x, bottom);
    }
    for (let y = top; y <= bottom; y++) {
        image.setPixelColor(0x000000ff, left, y);
        image.setPixelColor(0x000000ff, right, y);
    }
}

async function loadSuitImages(): Promise<SuitImages> {
    const entries = await Promise.all(
        Object.entries(SUIT_FILES).map(async ([suit, path]) => {
            const svg = await readFile(path, 'utf8');
            const png = new Resvg(svg, {
                fitTo: { mode: 'width', value: 48 * RENDER_SCALE },
            }).render().asPng();
            return [suit, await Jimp.fromBuffer(png)] as const;
        }),
    );
    return Object.fromEntries(entries) as SuitImages;
}

function drawCard(
    image: Image,
    card: Card,
    left: number,
    top: number,
    rankFont: Awaited<ReturnType<typeof loadFont>>,
    suitImages: SuitImages,
): void {
    drawBox(image, left, top);
    image.print({
        font: rankFont,
        x: (left + 8) * RENDER_SCALE,
        y: (top + 7) * RENDER_SCALE,
        text: card.rank,
    });
    const suit = suitImages[card.suit];
    image.composite(
        suit,
        (left + CARD_WIDTH - SUIT_MARGIN) * RENDER_SCALE - suit.width,
        (top + 58) * RENDER_SCALE,
    );
}

async function renderPokerImage(deal: PokerDeal): Promise<string> {
    const rankFont = await loadFont(FONT_128);
    const titleFont = await loadFont(FONT_64);
    const suitImages = await loadSuitImages();
    const boardWidth = CARD_WIDTH * 5 + CARD_GAP * 4;
    const handsTop = MARGIN + TITLE_HEIGHT + CARD_HEIGHT + 24;
    const imageHeight = handsTop + CARD_HEIGHT * 4 + HAND_GAP * 3 + MARGIN;
    const image = new Jimp({
        width: IMAGE_WIDTH * RENDER_SCALE,
        height: imageHeight * RENDER_SCALE,
        color: 0xffffffff,
    });

    const title = "Texas Hold 'Em";
    image.print({
        font: titleFont,
        x: (IMAGE_WIDTH * RENDER_SCALE - measureText(titleFont, title)) / 2,
        y: MARGIN * RENDER_SCALE,
        text: title,
    });

    const boardLeft = (IMAGE_WIDTH - boardWidth) / 2;
    for (const [index, card] of deal.board.entries()) {
        drawCard(image, card, boardLeft + index * (CARD_WIDTH + CARD_GAP), MARGIN + TITLE_HEIGHT, rankFont, suitImages);
    }

    const handCardsWidth = CARD_WIDTH * 2 + CARD_GAP;
    const lineLeft = MARGIN + handCardsWidth + 28;
    const lineRight = IMAGE_WIDTH - MARGIN;
    for (const [index, hand] of deal.hands.entries()) {
        const top = handsTop + index * (CARD_HEIGHT + HAND_GAP);
        drawCard(image, hand[0], MARGIN, top, rankFont, suitImages);
        drawCard(image, hand[1], MARGIN + CARD_WIDTH + CARD_GAP, top, rankFont, suitImages);
        const lineY = top + CARD_HEIGHT;
        for (let x = lineLeft * RENDER_SCALE; x <= lineRight * RENDER_SCALE; x++) {
            for (let offset = 0; offset < RENDER_SCALE; offset++) {
                image.setPixelColor(0x000000ff, x, lineY * RENDER_SCALE + offset);
            }
        }
    }

    image.resize({
        w: IMAGE_WIDTH,
        h: imageHeight,
        mode: ResizeStrategy.BICUBIC,
    });
    const imagePath = join(tmpdir(), `windsor-poker-${process.pid}-${Date.now()}.png`);
    await writeFile(imagePath, await image.getBuffer(JimpMime.png));
    return imagePath;
}

async function pokerWorker(_args: string, ctx: CommandRunContext): Promise<CommandResultPass> {
    const imagePath = await renderPokerImage(dealPokerHand());
    try {
        const job: PrintJob = {
            lines: [],
            urls: [],
            iconPath: imagePath,
        };
        await ctx.printJob(job);
    } finally {
        await unlink(imagePath);
    }
    return { kind: 'pass' };
}

export const printPoker: Command = {
    aliases: ['poker'],
    invoke: tryExecCommandFunction(pokerWorker),
};
