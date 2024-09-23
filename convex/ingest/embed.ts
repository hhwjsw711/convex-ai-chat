import { v } from "convex/values";
import { map } from "modern-async";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { paginate } from "../helpers";
import fetch from 'node-fetch';

const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

interface MiniMaxResponse {
  vectors: number[][];
  total_tokens: number;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

export const embedAll = internalAction({
  args: {},
  handler: async (ctx) => {
    await paginate(ctx, "documents", 20, async (documents) => {
      await ctx.runAction(internal.ingest.embed.embedList, {
        documentIds: documents.map((doc) => doc._id),
      });
    });
  },
});

export const embedList = internalAction({
  args: {
    documentIds: v.array(v.id("documents")),
  },
  handler: async (ctx, { documentIds }) => {
    const chunks = (
      await map(documentIds, (documentId) =>
        ctx.runQuery(internal.ingest.embed.chunksNeedingEmbedding, {
          documentId,
        })
      )
    ).flat();

    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
    await map(embeddings, async (embedding, i) => {
      const { _id: chunkId } = chunks[i];
      await ctx.runMutation(internal.ingest.embed.addEmbedding, {
        chunkId,
        embedding,
      });
    });
  },
});

export const chunksNeedingEmbedding = internalQuery(
  async (ctx, { documentId }: { documentId: Id<"documents"> }) => {
    const chunks = await ctx.db
      .query("chunks")
      .withIndex("byDocumentId", (q) => q.eq("documentId", documentId))
      .collect();
    return chunks.filter((chunk) => chunk.embeddingId === null);
  }
);

export const addEmbedding = internalMutation(
  async (
    ctx,
    { chunkId, embedding }: { chunkId: Id<"chunks">; embedding: number[] }
  ) => {
    const embeddingId = await ctx.db.insert("embeddings", {
      embedding,
      chunkId,
    });
    await ctx.db.patch(chunkId, { embeddingId });
  }
);

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const url = `https://api.minimax.chat/v1/embeddings?GroupId=${MINIMAX_GROUP_ID}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      texts: texts,
      model: "embo-01",
      type: "db"  // 默认使用 "db" 类型，如果需要可以改为 "query"
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data: MiniMaxResponse = await response.json();

  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(`API error: ${data.base_resp.status_code} - ${data.base_resp.status_msg}`);
  }

  return data.vectors;
}
