import { v } from "convex/values";
import { map } from "modern-async";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { embedTexts } from "./ingest/embed";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MINIMAX_MODEL = "abab6.5s-chat";
const groupId = process.env.MINIMAX_GROUP_ID;
const apiKey = process.env.MINIMAX_API_KEY;

const url = `https://api.minimax.chat/v1/text/chatcompletion_pro?GroupId=${groupId}`;

export const answer = internalAction({
  args: {
    sessionId: v.string(),
  },
  handler: async (ctx, { sessionId }) => {
    const messages = await ctx.runQuery(internal.serve.getMessages, {
      sessionId,
    });
    const lastUserMessage = messages.at(-1)!.text;

    const [embedding] = await embedTexts([lastUserMessage]);

    const searchResults = await ctx.vectorSearch("embeddings", "byEmbedding", {
      vector: embedding,
      limit: 8,
    });

    const relevantDocuments = await ctx.runQuery(internal.serve.getChunks, {
      embeddingIds: searchResults.map(({ _id }) => _id),
    });

    const messageId = await ctx.runMutation(internal.serve.addBotMessage, {
      sessionId,
    });

    try {
      const requestBody = {
        model: MINIMAX_MODEL,
        tokens_to_generate: 2048,
        reply_constraints: { sender_type: "BOT", sender_name: "MM智能助理" },
        messages: [
          {
            sender_type: "USER",
            sender_name: "系统",
            text: "Answer the user question based on the provided documents " +
                  "or report that the question cannot be answered based on " +
                  "these documents. Keep the answer informative but brief, " +
                  "do not enumerate all possibilities.",
          },
          ...relevantDocuments.map(({ text }) => ({
            sender_type: "USER",
            sender_name: "系统",
            text: "Relevant document:\n\n" + text,
          })),
          ...messages.map(({ isViewer, text }) => ({
            sender_type: isViewer ? "USER" : "BOT",
            sender_name: isViewer ? "用户" : "MM智能助理",
            text: text,
          })),
        ],
        bot_setting: [
          {
            bot_name: "MM智能助理",
            content: "MM智能助理是一款由MiniMax自研的，没有调用其他产品的接口的大型语言模型。MiniMax是一家中国科技公司，一直致力于进行大模型相关的研究。",
          },
        ],
        stream: true,
        temperature: 0.01,
        top_p: 0.95,
      };

      console.log('Sending request to MiniMax API');
      console.log('Request body:', JSON.stringify(requestBody, null, 2));

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      console.log('Response received. Status:', response.status);

      const headersObj: { [key: string]: string } = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });
      console.log('Response headers:', JSON.stringify(headersObj, null, 2));

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let receivedAnyResponse = false;
      let isDone = false;
      let buffer = "";

      while (!isDone) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        console.log('Received chunk:', chunk);

        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() || ""; // 保留未完成的部分

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            receivedAnyResponse = true;
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') {
              console.log('Received [DONE] signal');
              isDone = true;
              break;
            }

            try {
              const jsonData = JSON.parse(jsonStr);
              console.log('Parsed JSON data:', JSON.stringify(jsonData, null, 2));
              const replyDelta = jsonData.choices[0]?.messages[0]?.text;
              if (replyDelta) {
                text += replyDelta;
                await ctx.runMutation(internal.serve.updateBotMessage, {
                  messageId,
                  text,
                });
              }
            } catch (e) {
              console.error('Error parsing JSON:', e);
              console.error('Problematic line:', line);
            }
          }
        }
      }

      if (!receivedAnyResponse) {
        console.error('No response received from the API');
        throw new Error('No response received from the API');
      }

      if (!text.trim()) {
        console.error('Received response but no content was extracted');
        text = "I apologize, but I couldn't generate a response. Please try asking your question again.";
      }

      await ctx.runMutation(internal.serve.updateBotMessage, {
        messageId,
        text,
      });

      return text;

    } catch (error: any) {
      console.error("Error details:", error);
      await ctx.runMutation(internal.serve.updateBotMessage, {
        messageId,
        text: "I cannot reply at this time. Reach out to the team on Discord",
      });
      throw error;
    }
  },
});

export const getMessages = internalQuery(
  async (ctx, { sessionId }: { sessionId: string }) => {
    return await ctx.db
      .query("messages")
      .withIndex("bySessionId", (q) => q.eq("sessionId", sessionId))
      .collect();
  }
);

export const getChunks = internalQuery(
  async (ctx, { embeddingIds }: { embeddingIds: Id<"embeddings">[] }) => {
    return await map(
      embeddingIds,
      async (embeddingId) =>
        (await ctx.db
          .query("chunks")
          .withIndex("byEmbeddingId", (q) => q.eq("embeddingId", embeddingId))
          .unique())!
    );
  }
);

export const addBotMessage = internalMutation(
  async (ctx, { sessionId }: { sessionId: string }) => {
    return await ctx.db.insert("messages", {
      isViewer: false,
      text: "",
      sessionId,
    });
  }
);

export const updateBotMessage = internalMutation(
  async (
    ctx,
    { messageId, text }: { messageId: Id<"messages">; text: string }
  ) => {
    await ctx.db.patch(messageId, { text });
  }
);
