import type { CommandResult, CommandRunContext } from "./index.ts";
import { isPrinterUnavailableError } from "../printing/index.ts";

export function tryExecCommandFunction(func: (cmd: string, ctx: CommandRunContext) => Promise<CommandResult>) {
    return async function(cmd: string, ctx: CommandRunContext): Promise<CommandResult> {
        try {
            return await func(cmd, ctx);
        } catch(err) {
            if (isPrinterUnavailableError(err)) throw err;
            return {
                kind: "fail",
                reason: `${err}`
            };
        }
    }
}
