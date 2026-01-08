/**
 * ===============================================
 * API Route สำหรับ Chat (RAG - Document Search Only)
 * ===============================================
 *
 * ฟีเจอร์หลัก:
 * - 📚 RAG (Retrieval-Augmented Generation) with pgvector
 * - 🔍 Document Search จากเอกสาร (PDF, CSV, TXT) ใน documents table
 * - 🗂️ เก็บประวัติการสนทนาใน PostgreSQL
 * - 🧠 ทำ Summary เพื่อประหยัด Token
 * - ✂️ Trim Messages เพื่อไม่ให้เกิน Token Limit
 * - 🌊 Streaming Response สำหรับ Real-time Chat
 * - 🔧 จัดการ Session ID อัตโนมัติ
 *
 * หมายเหตุสำคัญ:
 * - เวอร์ชันนี้เปลี่ยนจาก OpenAI -> Ollama (local) ทั้ง Chat + Embedding (ฟรี)
 * - Embedding model แนะนำ: nomic-embed-text
 */

import { NextRequest } from "next/server";
import { getDatabase } from "@/lib/database";

// LangChain & AI SDK Imports
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { toUIMessageStream } from "@ai-sdk/langchain";
import { createUIMessageStreamResponse, UIMessage } from "ai";
import { PostgresChatMessageHistory } from "@langchain/community/stores/message/postgres";
import {
  BaseMessage,
  AIMessage,
  HumanMessage,
  SystemMessage,
  MessageContent,
} from "@langchain/core/messages";
import { trimMessages } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { encodingForModel } from "@langchain/core/utils/tiktoken";
import { createClient } from "@supabase/supabase-js";

// Vector Search (RAG)
import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase";
import { CacheBackedEmbeddings } from "langchain/embeddings/cache_backed";
import { InMemoryStore } from "@langchain/core/stores";

// ✅ Ollama (Chat + Embeddings)
import { ChatOllama } from "@langchain/community/chat_models/ollama";
import { OllamaEmbeddings } from "@langchain/community/embeddings/ollama";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ===============================================
// ใช้ centralized database utility แทน pool ที่สร้างเอง
// ===============================================
const pool = getDatabase();

// สร้าง Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!
);

// ===============================================
// ✅ สร้าง Vector Store สำหรับ Document Search (Ollama Embeddings)
// ===============================================
async function createVectorStore() {
  const baseEmbeddings = new OllamaEmbeddings({
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  });

  // Cache-backed embeddings เพื่อลดงานซ้ำ
  const cacheStore = new InMemoryStore();
  const embeddings = CacheBackedEmbeddings.fromBytesStore(
    baseEmbeddings,
    cacheStore,
    { namespace: "rag_embeddings" }
  );

  return new SupabaseVectorStore(embeddings, {
    client: supabase,
    tableName: "documents",
    queryName: "match_documents",
  });
}

// ===============================================
// ฟังก์ชันสำหรับ RAG (Vector Search)
// ===============================================
async function searchDocuments(query: string, limit: number = 5) {
  try {
    console.log(`🔧 Searching documents with query="${query}", limit=${limit}`);

    const vectorStore = await createVectorStore();
    const results = await vectorStore.similaritySearchWithScore(query, limit);

    if (!results || results.length === 0) {
      return `ไม่พบเอกสารที่เกี่ยวข้องกับ "${query}" ในระบบ`;
    }

    console.log(`✅ พบเอกสารที่เกี่ยวข้อง: ${results.length} รายการ`);

    const documents = results
      .map(([doc, score]) => {
        const filename = doc.metadata?.filename || "ไม่ทราบชื่อไฟล์";
        const type = doc.metadata?.type || "ไม่ทราบประเภท";
        return `ไฟล์: ${filename} (${String(type).toUpperCase()})
เนื้อหา: ${doc.pageContent}
ความเกี่ยวข้อง: ${(score * 100).toFixed(1)}%`;
      })
      .join("\n\n---\n\n");

    return documents;
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.log("❌ Search error:", errorMessage);

    if (
      errorMessage.includes("connection") ||
      errorMessage.includes("network") ||
      errorMessage.includes("timeout")
    ) {
      throw new Error("ไม่สามารถเข้าถึงระบบค้นหาเอกสารได้ในขณะนี้");
    }

    throw new Error(`เกิดข้อผิดพลาดในการค้นหาเอกสาร: ${errorMessage}`);
  }
}

// ===============================================
// Token Counter (tiktoken) - ยังใช้ได้ แต่อาจนับไม่ตรงกับ Llama
// ===============================================
type Encoding = {
  encode: (text: string) => number[];
  free?: () => void;
};

let encPromise: Promise<Encoding> | undefined;

async function getEncoder(): Promise<Encoding> {
  if (!encPromise) {
    encPromise = encodingForModel("gpt-4o-mini").catch(() =>
      encodingForModel("gpt-4")
    );
  }
  return encPromise;
}

async function strTokenCounter(content: MessageContent): Promise<number> {
  const enc = await getEncoder();
  if (typeof content === "string") return enc.encode(content).length;
  if (Array.isArray(content)) {
    return enc.encode(
      content
        .map((p) => (p.type === "text" ? p.text : JSON.stringify(p)))
        .join(" ")
    ).length;
  }
  return enc.encode(String(content ?? "")).length;
}

async function tiktokenCounter(messages: BaseMessage[]): Promise<number> {
  let total = 0;
  for (const m of messages) {
    const role =
      m instanceof HumanMessage
        ? "user"
        : m instanceof AIMessage
        ? "assistant"
        : m instanceof SystemMessage
        ? "system"
        : "unknown";
    total += await strTokenCounter(role);
    total += await strTokenCounter(m.content);
  }
  return total;
}

// ===============================================
// POST API: ส่งข้อความและรับการตอบกลับแบบ Stream
// ===============================================
export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      sessionId,
      userId,
    }: {
      messages: UIMessage[];
      sessionId?: string;
      userId?: string;
    } = await req.json();

    // ===============================================
    // Step 1: สร้าง Session ใหม่ถ้ายังไม่มี
    // ===============================================
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const client = await pool.connect();
      try {
        const firstMessage = messages.find((m) => m.role === "user");
        let title = "New Chat";
        if (
          firstMessage &&
          Array.isArray(firstMessage.parts) &&
          firstMessage.parts.length > 0
        ) {
          const textPart = firstMessage.parts.find((p) => p.type === "text");
          if (textPart && typeof textPart.text === "string") {
            title =
              textPart.text.slice(0, 50) +
              (textPart.text.length > 50 ? "..." : "");
          }
        }

        if (!userId) throw new Error("User ID is required");

        const result = await client.query(
          "INSERT INTO chat_sessions (title, user_id) VALUES ($1, $2) RETURNING id",
          [title, userId]
        );
        currentSessionId = result.rows[0].id;
      } finally {
        client.release();
      }
    }

    // ===============================================
    // Step 2: โหลด Summary เดิมจากฐานข้อมูล
    // ===============================================
    const clientForSummary = await pool.connect();
    let persistedSummary = "";
    try {
      const r = await clientForSummary.query(
        "SELECT summary FROM chat_sessions WHERE id = $1 LIMIT 1",
        [currentSessionId]
      );
      persistedSummary = r.rows?.[0]?.summary ?? "";
    } finally {
      clientForSummary.release();
    }

    // ===============================================
    // ✅ Step 3: ตั้งค่า AI Model (Ollama Chat)
    // ===============================================
    const model = new ChatOllama({
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      model: process.env.OLLAMA_CHAT_MODEL || "llama3.1:8b",
      temperature: 0.1,
    });

    // ===============================================
    // Step 4: โหลดประวัติการสนทนา
    // ===============================================
    const messageHistory = new PostgresChatMessageHistory({
      sessionId: currentSessionId!,
      tableName: "chat_messages",
      pool: pool,
    });

    const fullHistory = await messageHistory.getMessages();

    // ===============================================
    // Step 5: ดึงข้อความล่าสุดจาก User
    // ===============================================
    const lastUserMessage = messages.filter((m) => m.role === "user").pop();
    let input = "";
    if (
      lastUserMessage &&
      Array.isArray(lastUserMessage.parts) &&
      lastUserMessage.parts.length > 0
    ) {
      const textPart = lastUserMessage.parts.find((p) => p.type === "text");
      if (textPart) input = String(textPart.text ?? "");
    }
    if (!input)
      return new Response("No valid user input found.", { status: 400 });

    // ===============================================
    // Step 6: Trim + Overflow summary
    // ===============================================
    let recentWindowWithoutCurrentInput: BaseMessage[] = [];
    let overflowSummary = "";

    if (sessionId && fullHistory.length > 0) {
      const trimmedWindow = await trimMessages(fullHistory, {
        maxTokens: 1500,
        strategy: "last",
        tokenCounter: tiktokenCounter,
      });

      recentWindowWithoutCurrentInput = trimmedWindow.filter((msg) => {
        if (msg instanceof HumanMessage && msg.content === input) return false;
        return true;
      });

      const windowSet = new Set(trimmedWindow);
      const overflow = fullHistory.filter((m) => !windowSet.has(m));
      if (overflow.length > 0) {
        const summarizerPrompt = ChatPromptTemplate.fromMessages([
          ["system", "สรุปบทสนทนาให้สั้นที่สุด เป็นภาษาไทย เก็บเฉพาะสาระสำคัญ"],
          ["human", "สรุปข้อความต่อไปนี้:\n\n{history}"],
        ]);

        const summarizer = summarizerPrompt
          .pipe(model)
          .pipe(new StringOutputParser());

        const historyText = overflow
          .map((m) => {
            if (m instanceof HumanMessage) return `ผู้ใช้: ${m.content}`;
            if (m instanceof AIMessage) return `ผู้ช่วย: ${m.content}`;
            return `ระบบ: ${String(m.content)}`;
          })
          .join("\n");

        try {
          overflowSummary = await summarizer.invoke({ history: historyText });
        } catch (e) {
          console.warn("overflow summary failed", e);
        }
      }
    }

    const summaryForThisTurn = [persistedSummary, overflowSummary]
      .filter(Boolean)
      .join("\n");

    // ===============================================
    // Step 7: RAG Prompt + Chain
    // ===============================================
    const ragPrompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `คุณคือผู้ช่วย AI อัจฉริยะที่ตอบเป็นภาษาไทย 
        
คุณมีข้อมูลจากเอกสารที่อัปโหลดไว้ในระบบ (PDF, CSV, TXT) เพื่อใช้ตอบคำถาม

**หลักการตอบคำถาม:**
- ใช้ข้อมูลจากเอกสารที่ให้มาในการตอบคำถาม
- หากไม่มีข้อมูลที่เกี่ยวข้อง ให้บอกว่าไม่พบข้อมูลที่เกี่ยวข้อง
- ห้ามเดาหรือสร้างข้อมูลขึ้นมาเอง ให้ใช้ข้อมูลจากเอกสารเท่านั้น
- ตอบด้วยข้อมูลที่ถูกต้องและครบถ้วน

บริบทการสนทนาก่อนหน้านี้โดยสรุปคือ: {summary}

ข้อมูลจากเอกสารที่เกี่ยวข้อง:
{context}`,
      ],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
    ]);

    const ragChain = ragPrompt.pipe(model).pipe(new StringOutputParser());

    // ===============================================
    // Step 8: ค้นหาเอกสารก่อนตอบ
    // ===============================================
    let documentContext = "";
    try {
      documentContext = await searchDocuments(input, 3);
    } catch (error) {
      console.warn(
        "⚠️ ไม่สามารถค้นหาเอกสารได้:",
        error instanceof Error ? error.message : String(error)
      );
      documentContext = "ไม่สามารถเข้าถึงระบบค้นหาเอกสารได้ในขณะนี้";
    }

    // summary เป็น system message ใน chat history
    const chatHistoryForChain = [...recentWindowWithoutCurrentInput];
    if (summaryForThisTurn) {
      chatHistoryForChain.unshift(new SystemMessage(summaryForThisTurn));
    }

    // stream จาก chain
    const stream = await ragChain.stream({
      input,
      chat_history: chatHistoryForChain,
      summary: summaryForThisTurn,
      context: documentContext,
    });

    // ===============================================
    // Step 9: บันทึกข้อความ user
    // ===============================================
    let canSaveToDatabase = true;
    try {
      await messageHistory.addUserMessage(input);
    } catch (e) {
      console.warn(
        "⚠️ ไม่สามารถบันทึกข้อความ user ลงฐานข้อมูลได้:",
        e instanceof Error ? e.message : String(e)
      );
      canSaveToDatabase = false;
    }

    // ===============================================
    // Step 10: สร้าง ReadableStream + บันทึก assistant
    // ===============================================
    let assistantText = "";
    let hasSearchError = false;

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            if (typeof chunk === "string") {
              assistantText += chunk;

              if (
                chunk.includes("ไม่สามารถเข้าถึงระบบค้นหาเอกสารได้") ||
                assistantText.includes("ไม่สามารถเข้าถึงระบบค้นหาเอกสารได้")
              ) {
                hasSearchError = true;
                const friendlyMessage =
                  "ขออภัยครับ ขณะนี้ไม่สามารถเข้าถึงระบบค้นหาเอกสารได้ กรุณาลองใหม่อีกครั้งในภายหลัง";
                controller.enqueue(friendlyMessage);
                assistantText = friendlyMessage;
              } else {
                controller.enqueue(chunk);
              }
            }
          }

          // บันทึก assistant + อัปเดต summary
          if (assistantText && !hasSearchError && canSaveToDatabase) {
            try {
              await messageHistory.addMessage(new AIMessage(assistantText));

              const summarizerPrompt2 = ChatPromptTemplate.fromMessages([
                ["system", "รวมสาระสำคัญให้สั้นที่สุด ภาษาไทย กระชับ"],
                [
                  "human",
                  "นี่คือสรุปเดิม:\n{old}\n\nนี่คือข้อความใหม่:\n{delta}\n\nช่วยอัปเดตให้สั้นและครบถ้วน",
                ],
              ]);

              const summarizer2 = summarizerPrompt2
                .pipe(model)
                .pipe(new StringOutputParser());

              const updatedSummary = await summarizer2.invoke({
                old: persistedSummary || "ไม่มีประวัติก่อนหน้า",
                delta: [overflowSummary, `ผู้ใช้: ${input}`, `ผู้ช่วย: ${assistantText}`]
                  .filter(Boolean)
                  .join("\n"),
              });

              const clientUpdate = await pool.connect();
              try {
                await clientUpdate.query(
                  "UPDATE chat_sessions SET summary = $1 WHERE id = $2",
                  [updatedSummary, currentSessionId]
                );
              } finally {
                clientUpdate.release();
              }
            } catch (e) {
              console.warn("update summary failed", e);
            }
          } else if (hasSearchError || !canSaveToDatabase) {
            console.warn("🚫 ข้ามการบันทึกประวัติเนื่องจากมีปัญหา");
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    // ===============================================
    // Step 11: ส่ง Response กลับ
    // ===============================================
    return createUIMessageStreamResponse({
      stream: toUIMessageStream(readable),
      headers: currentSessionId ? { "x-session-id": currentSessionId } : undefined,
    });
  } catch (error) {
    console.error("API Error:", error);
    return new Response(
      JSON.stringify({
        error: "An error occurred while processing your request",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ===============================================
// GET API: ดึงประวัติการสนทนาจาก Session ID
// ===============================================
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("sessionId");
    if (!sessionId) {
      return new Response(JSON.stringify({ error: "Session ID is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT message, message->>'type' as message_type, created_at
         FROM chat_messages 
         WHERE session_id = $1 
         ORDER BY created_at ASC`,
        [sessionId]
      );

      const messages = result.rows.map((row, i) => {
        const data = row.message;
        let role = "user";
        if (row.message_type === "ai") role = "assistant";
        else if (row.message_type === "human") role = "user";

        return {
          id: `history-${i}`,
          role,
          content: data.content || data.text || data.message || "",
          createdAt: row.created_at,
        };
      });

      return new Response(JSON.stringify({ messages }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error fetching messages:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch messages",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
