const { App } = require("@slack/bolt");
const { Configuration, OpenAIApi } = require("openai");
const {
    getConversation,
    updateConversationHistory,
} = require("../../app/common/dynamo");

const { SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, OPENAI_API_KEY, PINECONE_API_KEY } = process.env;
const DEFAULT_MODEL = "gpt-3.5-turbo";

const pinecone = new Pinecone();      
pinecone.init({      
	environment: "gcp-starter",      
	apiKey: PINECONE_API_KEY,      
});      
const index = pinecone.Index("canopy--document-uploader");

const app = new App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
});

const content = index[0].content;
const configuration = new Configuration({
    apiKey: OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);
const embeddingResponse = openai.createEmbedding({
    model: "text-embedding-ada-002",
    input: content,
});

const [{ embedding }] = embeddingResponse.data.data;
const queryRequest = QueryRequest = {
    vector: embedding, // the query embedding
    topK: 5,
    includeValues: false,
    includeMetadata: true,
    namespace: "handbook-namespace",
};

const queryResponse = index.query({ queryRequest });
const uniqueFullContents = queryResponse.matches
    .map((m) => m.metadata)
    .map((m) => m.fullContent)
    .reduce(reduceToUniqueValues, []);

const BOT_SYSTEM_PROMPT = "You are a very enthusiastic Variant representative who \
loves to help people! Given the following sections from the Variant handbook, answer \
the question using only that information. If you are unsure and the answer is not \
written in the handbook, say 'Sorry, I don't know how to help with that.' Please do not \
write URLs that you cannot find in the context section. \
Context section:" + uniqueFullContents.join("\n---\n");

async function chatGPTReply({ channel, message, conversation }) {
    const history = conversation ? conversation.history : [];
    const model = conversation ? conversation.model : DEFAULT_MODEL;
    const prompt = { role: "user", content: message };

    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
        try {
            const completion = await openai.createChatCompletion({
                model,
                messages: [
                    { role: "system", content: BOT_SYSTEM_PROMPT },
                    ...history,
                    prompt,
                ],
            });
            const reply = completion.data.choices[0].message.content.trim();
            if (conversation) {
                const updatedHistory = [
                    ...history,
                    prompt,
                    { role: "assistant", content: reply },
                ];
                await updateConversationHistory(channel, updatedHistory);
            }
            return reply;
            // this bit isn't even necessary, um... it turns out that my free trial credits were just
            // expired and i had to buy more
        } catch (error) {
            if (error.response && error.response.status === 429) {
                const waitTime = Math.pow(2, retries) * 1000; // Exponential backoff in milliseconds
                console.log(`Rate limit exceeded. Retrying in ${waitTime / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                retries++;
            } else {
                // Handle other types of errors
                throw error;
            }
        }
    }
}

async function handleNewMessage({ channel, userMessage, botUserId, subtype }) {
    console.log("Handle new message");

    if (subtype === "message_deleted") {
        return;
    }

    if (!userMessage || !userMessage.length) {
        return;
    }

    const conversation = await getConversation(channel);
    const isConversationMode = !!conversation;
    const isMentioned = userMessage.includes(`<@${botUserId}>`);

    if (isMentioned && !isConversationMode) {
        await app.client.chat.postMessage({
            channel: channel,
            text: ":pleased_wensen: Let me take a look at this for you!",
        });
    }

    if (isMentioned || isConversationMode) {
        const mentionRegex = new RegExp(`<@${botUserId}>`, "g");
        const messageWithoutMention = userMessage.replace(mentionRegex, "").trim();

        // Only process the message and respond if there's remaining text
        if (messageWithoutMention.length > 0) {
            const reply = await chatGPTReply({
                channel: channel,
                message: messageWithoutMention,
                conversation,
            });
            await app.client.chat.postMessage({
                channel: channel,
                text: reply,
            });
        }
    }
}

module.exports.handler = async (event) => {
    await handleNewMessage(event);

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "Event processed successfully",
        }),
    };
};
