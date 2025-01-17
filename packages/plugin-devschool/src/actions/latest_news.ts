import {
    ActionExample,
    IAgentRuntime,
    Memory,
    State,
    type Action, HandlerCallback, Content, generateText, ModelClass
} from "@elizaos/core";
import * as process from "node:process";

export const currentNewsAction: Action = {
    name: "LATEST_NEWS",
    similes: ["NEWS", "GET_NEWS", "GET_CURRENT_NEWS"],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description: "Returns latest news from news api by search term by user",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        _callback: HandlerCallback
    ) => {
        async function getCurrentNews(searchTerm: string): Promise<void> {
            const response = await fetch(
                'https://newsapi.org/v2/everything?' +
                'q=' + searchTerm + '&' +
                'sortBy=popularity&' +
                'apiKey=' + process.env.NEWS_API_KEY
            )
            const data = await response.json();
            return data.articles
                .slice(0, 5)
                .map(
                    (article) =>
                        `${article.title}\n${article.description}\n${article.url}\n${article.content.slice(0,1000)}`
                )
                .join('\n\n');

        }

        const context = `
        Extract the search term from user's message. The message is:
        ${_message.content.text}
        Only respond with the search term do not include any other text
        `;

        const searchTerm = await generateText({
            runtime: _runtime,
            context,
            modelClass: ModelClass.SMALL,
            stop: ["\n"]
        })

        const currentNews = await getCurrentNews(searchTerm)

        const responseText = `The current news for search term ${searchTerm} is ${currentNews}`

        const newMemory: Memory = {
            userId: _message.agentId,
            agentId: _message.agentId,
            roomId: _message.roomId,
            content: {
                text: responseText,
                action: "CURRENT_NEWS_RESPONSE",
                source: _message.content?.source
            } as Content
        }

        await _runtime.messageManager.createMemory(newMemory);

        await _callback(newMemory.content)

        return true
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "please send me latest news" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "LATEST_NEWS" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "what is in the news today?", action: "LATEST_NEWS" },
            }
        ],
    ] as ActionExample[][]
} as Action;
