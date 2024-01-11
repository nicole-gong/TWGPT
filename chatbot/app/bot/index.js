const { App } = require("@slack/bolt");
const {
    getConversation,
    updateConversationHistory,
} = require("../../app/common/dynamo");

const { SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN } = process.env;

const { OpenAI } = require('langchain/llms/openai');
const { ConversationalRetrievalQAChain } = require('langchain/chains');
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require('langchain/vectorstores/pinecone');
const { OpenAIEmbeddings } = require('langchain/embeddings/openai');

const app = new App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
});

// https://github.com/martinseanhunt/slack-gpt/blob/main/config/prompts.js
const QA_PROMPT = `You are a helpful AI assistant. Use the following pieces of context to answer the question at the end.
If you don't know the answer, just say you don't know. DO NOT try to make up an answer.
If the question is not related to the context, politely respond that you are tuned to only answer questions that are related to the context.
Answer in formatted mrkdwn, use only Slack-compatible mrkdwn, such as bold (*text*), italic (_text_), strikethrough (~text~), and lists (1., 2., 3.).

=========
{question}
=========
{context}
=========
Answer in Slack-compatible mrkdwn:
`;
const CONDENSE_PROMPT = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question. If the follow up question is not closesly related to the chat history, the chat history must be ignored when generating the standalone question and your job is to repeat the follow up question exactly. 

Chat History:
{chat_history}
Follow Up Input: {question}
Standalone question:`;

// https://github.com/martinseanhunt/slack-gpt/blob/main/lib/getLLMResponse.js
const getLLMResponse = async (question, history) => {
    // Sanitise the question - OpenAI reccomends replacing newlines with spaces
    question = question.trim().replace('\n', ' ');

    // Inntialise pinecone client
    const pinecone = new Pinecone({
        environment: process.env.PINECONE_ENVIRONMENT,
        apiKey: process.env.PINECONE_API_KEY,        
    });

    console.log(pinecone.listIndexes());
    console.log(pinecone.describeIndex('ifl'));

    // Set Pinecone index name
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);

    // Set up index
    const vectorStore = await PineconeStore.fromExistingIndex(
        new OpenAIEmbeddings(),
        {
            pineconeIndex: pineconeIndex,
            textKey: 'text',
            namespace: process.env.PINECONE_NAME_SPACE,
        }
    );

    // Initialise the model
    const model = new OpenAI({
        temperature: 0,
        maxTokens: 2000,
        modelName: 'gpt-3.5-turbo',
        cache: true,
    });

    // Set up the chain
    const chain = ConversationalRetrievalQAChain.fromLLM(
        model,
        vectorStore.asRetriever(5),
        {
            returnSourceDocuments: true,
            questionGeneratorTemplate: CONDENSE_PROMPT,
            qaTemplate: QA_PROMPT,
        }
    );

    // Call the chain, pass the question and chat history
    const response = await chain.call({
        question,
        chat_history: history || [],
    });

    return response;
};
async function chatGPTReply({ channel, message, conversation }) {
    const history = conversation ? conversation.history : [];
    const prompt = { role: "user", content: message };

    return getLLMResponse(message, history)
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