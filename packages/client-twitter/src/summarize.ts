import {SearchMode, Tweet} from "agent-twitter-client";
import {composeContext, elizaLogger, getEmbeddingZeroVector, UUID} from "@elizaos/core";
import { generateText } from "@elizaos/core";
import {
    IAgentRuntime,
    ModelClass,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { ClientBase } from "./base";
import { wait } from "./utils.ts";
import {DEFAULT_MAX_TWEET_LENGTH} from "./environment.ts";

const twitterSummarizeTemplate =
`{{timeline}}

{{providers}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{formattedHomeTimeline}}

{{postsToSummarize}}

# Task: Generate a summarizing post in multiple statements of given # Tweets to summarize # in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Use only unique topics, if there are similar topics you can combine them in one/ Do not add commentary or acknowledge this request, just write the post. Mention authors of the posts using "@"
You can use information from recent timeline if relevant to posts to summarize. If given post is unclear or impossible to summarize you skip it.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.
`;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(
    text: string,
    maxTweetLength: number
): string {
    if (text.length <= maxTweetLength) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const lastPeriodIndex = text.lastIndexOf(".", maxTweetLength - 1);
    if (lastPeriodIndex !== -1) {
        const truncatedAtPeriod = text.slice(0, lastPeriodIndex + 1).trim();
        if (truncatedAtPeriod.length > 0) {
            return truncatedAtPeriod;
        }
    }

    // If no period, truncate to the nearest whitespace within the limit
    const lastSpaceIndex = text.lastIndexOf(" ", maxTweetLength - 1);
    if (lastSpaceIndex !== -1) {
        const truncatedAtSpace = text.slice(0, lastSpaceIndex).trim();
        if (truncatedAtSpace.length > 0) {
            return truncatedAtSpace + "...";
        }
    }

    // Fallback: Hard truncate and add ellipsis
    const hardTruncated = text.slice(0, maxTweetLength - 3).trim();
    return hardTruncated + "...";
}

export class TwitterSummarizeClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isDryRun: boolean;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;

        elizaLogger.log(
            `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
        );

        if (this.isDryRun) {
            elizaLogger.log(
                "Twitter client initialized in dry run mode - no actual tweets should be posted"
            );
        }
    }

    async start() {
        this.engageWithSummarizeTermsLoop();
    }

    private engageWithSummarizeTermsLoop() {
        this.engageWithSummarizeTerms().then();
        const randomMinutes = (Math.floor(Math.random() * (120 - 60 + 1)) + 360); // about every 6 hours
        elizaLogger.log(`Next twitter summarize scheduled in ${randomMinutes} minutes`);
        setTimeout(
            () => this.engageWithSummarizeTermsLoop(),
            randomMinutes * 60 * 1000
        );
    }

    private async engageWithSummarizeTerms() {
        console.log("Engaging with search terms");
        try {
            const searchTerm = [...this.runtime.character.topics][
                Math.floor(Math.random() * this.runtime.character.topics.length)
            ];

            console.log("Fetching summarize tweets");
            // TODO: we wait 5 seconds here to avoid getting rate limited on startup, but we should queue
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const recentTweets = await this.client.fetchSearchTweets(
                searchTerm,
                20,
                SearchMode.Top
            );

            const homeTimeline = await this.client.fetchHomeTimeline(5);

            await this.client.cacheTimeline(homeTimeline);

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .slice(-5)
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            // randomly slice .tweets down to 5
            const slicedTweets = recentTweets.tweets
                .sort(() => Math.random() - 0.5)
                .slice(0, 5);

            if (slicedTweets.length === 0) {
                console.log(
                    "No valid tweets found for the search term",
                    searchTerm
                );
                return;
            }

            const formattedFoundTweets =
                `# Tweets to summarize #\n\n` +
                slicedTweets
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            elizaLogger.log("Generating new summarizing tweet");
            // console.log(formattedFoundTweets)

            try {
                const roomId = stringToUuid(
                    "twitter_generate_room-" + this.client.profile.username
                );
                await this.runtime.ensureUserExists(
                    this.runtime.agentId,
                    this.client.profile.username,
                    this.runtime.character.name,
                    "twitter"
                );

                const topics = this.runtime.character.topics.join(", ");

                const state = await this.runtime.composeState(
                    {
                        userId: this.runtime.agentId,
                        roomId: roomId,
                        agentId: this.runtime.agentId,
                        content: {
                            text: topics || "",
                            action: "TWEET",
                        },
                    },
                    {
                        twitterUserName: this.client.profile.username,
                        maxTweetLength: this.client.twitterConfig.MAX_TWEET_LENGTH,
                        postsToSummarize: formattedFoundTweets,
                        formattedHomeTimeline: formattedHomeTimeline
                    }
                );

                const context = composeContext({
                    state,
                    template:
                        this.runtime.character.templates?.twitterSummarizeTemplate ||
                        twitterSummarizeTemplate,
                });

                elizaLogger.debug("generate post prompt:\n" + context);
                // console.log(context)

                let newTweetContent = await generateText({
                    runtime: this.runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });

                // console.log(newTweetContent)

                // First attempt to clean content
                let cleanedContent = "";

                // Try parsing as JSON first
                try {
                    const parsedResponse = JSON.parse(newTweetContent);
                    if (parsedResponse.text) {
                        cleanedContent = parsedResponse.text;
                    } else if (typeof parsedResponse === "string") {
                        cleanedContent = parsedResponse;
                    }
                } catch (error) {
                    error.linted = true; // make linter happy since catch needs a variable
                    // If not JSON, clean the raw content
                    cleanedContent = newTweetContent
                        .replaceAll('```', '')
                        .replace('json', '')
                        .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                        .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                        .replace(/\\"/g, '"') // Unescape quotes
                        .replace(/\\n/g, "\n") // Unescape newlines, ensures double spaces
                        .trim();
                }

                if (!cleanedContent) {
                    elizaLogger.error(
                        "Failed to extract valid content from response:",
                        {
                            rawResponse: newTweetContent,
                            attempted: "JSON parsing",
                        }
                    );
                    return;
                }

                // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
                const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH
                if (maxTweetLength) {
                    cleanedContent = truncateToCompleteSentence(
                        cleanedContent,
                        maxTweetLength
                    );
                    newTweetContent = cleanedContent
                }

                const removeQuotes = (str: string) =>
                    str.replace(/^['"](.*)['"]$/, "$1");

                const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n"); //ensures double spaces

                // Final cleaning
                cleanedContent = removeQuotes(fixNewLines(cleanedContent));

                // console.log('4====')
                // console.log(cleanedContent)

                if (this.isDryRun) {
                    elizaLogger.info(
                        `Dry run: would have posted summarizing tweet: ${cleanedContent}`
                    );
                    return;
                }

                try {
                    elizaLogger.log(`Posting new summarizing tweet:\n ${cleanedContent}`);
                    await this.postTweet(
                        this.runtime,
                        this.client,
                        cleanedContent,
                        roomId,
                        newTweetContent,
                        this.twitterUsername
                    );
                } catch (error) {
                    elizaLogger.error("Error sending summarizing tweet:", error);
                }
            } catch (error) {
                elizaLogger.error("Error generating new summarizing tweet:", error);
            }


            await wait();
        } catch (error) {
            console.error("Error summarizing:", error);
        }
    }

    async postTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        cleanedContent: string,
        roomId: UUID,
        newTweetContent: string,
        twitterUsername: string
    ) {
        try {
            elizaLogger.log(`Posting new summarizing tweet:\n`);

            let result;

            if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(
                    client,
                    runtime,
                    cleanedContent
                );
            } else {
                result = await this.sendStandardTweet(client, cleanedContent);
            }

            const tweet = this.createTweetObject(
                result,
                client,
                twitterUsername
            );

            await this.processAndCacheTweet(
                runtime,
                client,
                tweet,
                roomId,
                newTweetContent
            );
        } catch (error) {
            elizaLogger.error("Error sending summarizing tweet:", error);
        }
    }

    async handleNoteTweet(
        client: ClientBase,
        runtime: IAgentRuntime,
        content: string,
        tweetId?: string
    ) {
        try {
            const noteTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendNoteTweet(content, tweetId)
            );

            if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
                // Note Tweet failed due to authorization. Falling back to standard Tweet.
                const truncateContent = truncateToCompleteSentence(
                    content,
                    this.client.twitterConfig.MAX_TWEET_LENGTH
                );
                return await this.sendStandardTweet(
                    client,
                    truncateContent,
                    tweetId
                );
            } else {
                return noteTweetResult.data.notetweet_create.tweet_results
                    .result;
            }
        } catch (error) {
            throw new Error(`Note summarizing tweet failed: ${error}`);
        }
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(content, tweetId)
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                console.error("Error sending summarizing tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            elizaLogger.error("Error sending standard summarizing Tweet:", error);
            throw error;
        }
    }

    createTweetObject(
        tweetResult: any,
        client: any,
        twitterUsername: string
    ): Tweet {
        return {
            id: tweetResult.rest_id,
            name: client.profile.screenName,
            username: client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;
    }

    async processAndCacheTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweet: Tweet,
        roomId: UUID,
        newTweetContent: string
    ) {
        // Cache the last post details
        await runtime.cacheManager.set(
            `twitter/${client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        // Cache the tweet
        await client.cacheTweet(tweet);

        // Log the posted tweet
        elizaLogger.log(`Summarizing tweet posted:\n ${tweet.permanentUrl}`);

        // Ensure the room and participant exist
        await runtime.ensureRoomExists(roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        // Create a memory for the tweet
        await runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
                text: newTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp,
        });
    }
}
