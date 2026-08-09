export const Reaction = {
    ok: "✅",
    what: "❓",
    fail: "❌",
    thinking: "🧠",
    waiting: "⏳"
} as const;
export type Reaction = (typeof Reaction)[keyof typeof Reaction];
