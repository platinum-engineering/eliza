import { Plugin } from "@elizaos/core";
import { factEvaluator } from "./evaluators/fact.ts";
import { goalEvaluator } from "./evaluators/goal.ts";
import { boredomProvider } from "./providers/boredom.ts";
import { factsProvider } from "./providers/facts.ts";
import { timeProvider } from "./providers/time.ts";
import {currentNewsAction} from "./actions/latest_news.ts";

export * as actions from "./actions";
export * as evaluators from "./evaluators";
export * as providers from "./providers";

export const devSchoolPlugin: Plugin = {
    name: "devschool",
    description: "Devscool example",
    actions: [
        currentNewsAction
    ],
    evaluators: [factEvaluator, goalEvaluator],
    providers: [boredomProvider, timeProvider, factsProvider],
};
