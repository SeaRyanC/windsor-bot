import { debugFail } from "./debug-fail.ts";
import { helloWorld } from "./hello-world.ts";
import { printPokemon } from "./pokemon.ts";
import { printPoker } from "./poker.ts";
import { retry } from "./retry.ts";
import { printSudoku } from "./sudoku.ts";
import { printWordsearch } from "./wordsearch.ts";
import type { PrintJob } from "../types.ts";

export interface CommandRunContext {
    printJob: (job: PrintJob) => Promise<void>;
    retryFailedMessages?: () => Promise<number>;
}

export type Command = {
    aliases: string[];
    invoke: (msg: string, ctx: CommandRunContext) => Promise<CommandResult>;
};

export type CommandResultPass = {
    kind: "pass";
    reply?: string;
};

export type CommandResultFail = {
    kind: "fail";
    reason: string;
};

export type CommandResult = CommandResultPass | CommandResultFail;

export const Commands = [
    helloWorld,
    printSudoku,
    printWordsearch,
    printPokemon,
    printPoker,
    retry,
    debugFail
] as const satisfies ReadonlyArray<Command>;
