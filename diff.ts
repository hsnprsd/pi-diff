import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReviewOverlay } from "./src/overlay.js";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("diff", {
        description: "Review all uncommitted Git changes",
        /** Open the interactive review and send submitted comments as one follow-up message. */
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/diff requires interactive Pi.", "error");
                return;
            }
            const review = await ctx.ui.custom<string | undefined>(
                (tui, theme, keys, done) => createReviewOverlay(pi, ctx.cwd, tui, theme, keys, done),
                {
                    overlay: true,
                    overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
                    blocked: { kind: "question", message: "Reviewing Git changes" },
                },
            );
            if (review) pi.sendUserMessage(review, { deliverAs: "followUp" });
        },
    });
}
