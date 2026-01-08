/**
 * ===============================================
 * Chat History Component - หน้าแสดงประวัติการสนทนา
 * ===============================================
 *
 * Purpose: แสดงประวัติการสนทนาจาก session ที่ระบุและรองรับการต่อการสนทนา
 *
 * Features:
 * - แสดงประวัติข้อความจาก session เฉพาะ
 * - รองรับการต่อการสนทนาในหน้าเดียวกัน
 * - จัดการ loading states และ error handling
 * - ตรวจสอบ authentication ก่อนแสดงเนื้อหา
 * - แสดง UI states: loading, error, empty, content
 * - รองรับ markdown rendering และ message actions
 *
 * Dependencies:
 * - useChatHistory hook สำหรับจัดการข้อมูลและ API calls
 * - UI components สำหรับแสดงผล
 *
 * Authentication: ต้องมี userId เพื่อเข้าถึงข้อมูล
 * Data Source: PostgreSQL database ผ่าน API endpoints
 */

"use client"

// ============================================================================
// IMPORTS - การนำเข้า Components และ Libraries ที่จำเป็น
// ============================================================================
import { useEffect, useRef, useState } from "react"
import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/chat-container"
import { Message, MessageAction, MessageActions, MessageContent } from "@/components/ui/message"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input"
import { ScrollButton } from "@/components/ui/scroll-button"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ModelSelector } from "@/components/model-selector"
import { useChatHistory } from "@/hooks/use-chat-history"
import { ArrowUp, Check, Copy, Globe, Mic, MoreHorizontal, Plus, Square } from "lucide-react"
import { DEFAULT_MODEL } from "@/constants/models"

// ============================================================================
// TypeScript Interface Definitions - กำหนด Type Definitions
// ============================================================================
interface ChatHistoryProps {
  sessionId: string
  title: string
  userId?: string
}

// ============================================================================
// MAIN COMPONENT - หน้าหลักสำหรับแสดงประวัติการสนทนา
// ============================================================================
export function ChatHistory({ sessionId, title, userId }: ChatHistoryProps) {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL)

  /**
   * State สำหรับติดตาม copy status ของแต่ละข้อความ
   * key: message id, value: boolean (true = เพิ่งกด copy)
   */
  const [copiedMessages, setCopiedMessages] = useState<Record<string, boolean>>({})

  /**
   * Reference สำหรับ chat container
   */
  const chatContainerRef = useRef<HTMLDivElement>(null)

  /**
   * ✅ สำคัญ: ทำให้ stopMessage เป็น optional เพื่อแก้ TS error
   * เพราะ useChatHistory() ตอนนี้ไม่ได้ return stopMessage
   */
  const chat = useChatHistory(sessionId, userId) as ReturnType<typeof useChatHistory> & {
    stopMessage?: () => void
  }

  const {
    messages,
    loading,
    input,
    setInput,
    sendMessage,
    stopMessage, // ✅ optional แล้ว
    loadChatHistory,
    loadingHistory,
    historyError,
  } = chat

  // ========================================================================
  // EFFECTS
  // ========================================================================
  useEffect(() => {
    if (sessionId && sessionId !== "new") {
      loadChatHistory(sessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ========================================================================
  // HANDLERS
  // ========================================================================
  const handleCopyMessage = async (content: string, messageId: string) => {
    try {
      await navigator.clipboard.writeText(content)

      setCopiedMessages((prev) => ({ ...prev, [messageId]: true }))
      setTimeout(() => {
        setCopiedMessages((prev) => ({ ...prev, [messageId]: false }))
      }, 2000)
    } catch (error) {
      console.error("Failed to copy message:", error)
    }
  }

  const onSubmit = () => {
    if (!input.trim() || loading || !userId) return
    sendMessage(input)
  }

  const handleStop = () => {
    // ✅ ถ้า hook ยังไม่มี stopMessage ก็ไม่ทำอะไร (ไม่พัง)
    stopMessage?.()
  }

  // ========================================================================
  // AUTH GUARD
  // ========================================================================
  if (!userId) {
    return (
      <main className="flex h-screen flex-col overflow-hidden">
        <header className="bg-background z-10 flex h-16 w-full shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="text-foreground flex-1">{title}</div>
        </header>

        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
              <span className="text-xl text-red-500">🔒</span>
            </div>
            <h2 className="mb-2 text-xl font-semibold text-gray-700 dark:text-gray-300">
              กรุณาเข้าสู่ระบบ
            </h2>
            <p className="text-gray-500">คุณต้องเข้าสู่ระบบก่อนเพื่อดูประวัติการสนทนา</p>
          </div>
        </div>
      </main>
    )
  }

  // ========================================================================
  // MAIN RENDER
  // ========================================================================
  return (
    <main className="flex h-screen flex-col overflow-hidden">
      {/* HEADER */}
      <header className="bg-background z-10 flex h-16 w-full shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <div className="text-foreground flex-1">{title}</div>
        <ModelSelector selectedModel={selectedModel} onModelChange={setSelectedModel} />
      </header>

      {/* CHAT CONTAINER */}
      <div ref={chatContainerRef} className="relative flex-1 overflow-hidden">
        <ChatContainerRoot className="h-full">
          <ChatContainerContent className="p-4">
            {/* LOADING HISTORY */}
            {loadingHistory && (
              <div className="flex items-center justify-center py-8">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                  </div>
                  <div className="font-medium text-blue-600 dark:text-blue-400">
                    กำลังโหลดประวัติการสนทนา...
                  </div>
                  <div className="mt-1 text-sm text-gray-500">กรุณารอสักครู่</div>
                </div>
              </div>
            )}

            {/* ERROR */}
            {historyError && (
              <div className="flex items-center justify-center py-8">
                <div className="mx-auto max-w-md text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
                    <span className="text-xl text-red-500">⚠️</span>
                  </div>

                  <h3 className="mb-2 text-lg font-semibold text-red-600 dark:text-red-400">
                    เกิดข้อผิดพลาด
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{historyError}</p>

                  <Button
                    onClick={() => loadChatHistory(sessionId)}
                    variant="outline"
                    size="sm"
                    className="mt-4"
                  >
                    ลองใหม่
                  </Button>
                </div>
              </div>
            )}

            {/* MESSAGES */}
            {!loadingHistory && !historyError && (
              <div className="mx-auto w-full max-w-3xl space-y-3">
                {messages.map((message) => {
                  const isAssistant = message.role === "assistant"
                  return (
                    <Message key={message.id} isAssistant={isAssistant} bubbleStyle={true}>
                      <MessageContent isAssistant={isAssistant} bubbleStyle={true} markdown={isAssistant}>
                        {message.content}
                      </MessageContent>

                      <MessageActions isAssistant={isAssistant} bubbleStyle={true}>
                        <MessageAction tooltip="Copy" bubbleStyle={true}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 rounded-full p-0 text-gray-500 hover:text-gray-700"
                            onClick={() => handleCopyMessage(message.content, message.id)}
                          >
                            {copiedMessages[message.id] ? (
                              <Check size={14} className="text-green-600" />
                            ) : (
                              <Copy size={14} />
                            )}
                          </Button>
                        </MessageAction>
                      </MessageActions>
                    </Message>
                  )
                })}
              </div>
            )}

            {/* EMPTY */}
            {!loadingHistory && !historyError && messages.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <div className="mx-auto max-w-md text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-blue-500 to-purple-600">
                    <span className="text-lg font-bold text-white">💬</span>
                  </div>

                  <h3 className="mb-2 text-lg font-semibold text-gray-800 dark:text-gray-200">
                    Continue Your Conversation
                  </h3>
                  <p className="mb-4 text-gray-500 dark:text-gray-400">
                    Type a message below to continue this chat session
                  </p>

                  <div className="text-sm text-gray-400">Session ID: {sessionId}</div>
                </div>
              </div>
            )}
          </ChatContainerContent>

          {/* SCROLL BUTTON */}
          {messages.length > 0 && (
            <div className="absolute bottom-4 left-1/2 flex w-full max-w-3xl -translate-x-1/2 justify-end px-5">
              <ScrollButton className="shadow-sm" />
            </div>
          )}
        </ChatContainerRoot>
      </div>

      {/* INPUT */}
      <div className="bg-background z-[5] shrink-0 px-3 pb-3 md:px-5 md:pb-5">
        <div className="mx-auto max-w-3xl">
          {/* SENDING STATUS */}
          {loading && (
            <div className="mb-2 flex items-center gap-2 text-sm italic text-gray-500">
              <div className="flex space-x-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
                <div
                  className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                  style={{ animationDelay: "0.1s" }}
                />
                <div
                  className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                  style={{ animationDelay: "0.2s" }}
                />
              </div>
              <span>AI กำลังคิด...</span>
            </div>
          )}

          {/* LOADING HISTORY STATUS */}
          {loadingHistory && (
            <div className="mb-2 flex items-center gap-2 text-sm italic text-blue-500">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              <span>กำลังโหลดประวัติการสนทนา...</span>
            </div>
          )}

          <PromptInput
            isLoading={loading}
            value={input}
            onValueChange={setInput}
            onSubmit={onSubmit}
            className="border-input bg-popover relative z-10 w-full rounded-3xl border p-0 pt-1 shadow-xs"
          >
            <div className="flex flex-col">
              <PromptInputTextarea
                placeholder="Continue the conversation..."
                className="min-h-[44px] pt-3 pl-4 text-base leading-[1.3] sm:text-base md:text-base"
              />

              <PromptInputActions className="mt-5 flex w-full items-center justify-between gap-2 px-3 pb-3">
                {/* LEFT */}
                <div className="flex items-center gap-2">
                  <PromptInputAction tooltip="Add a new action">
                    <Button variant="outline" size="icon" className="size-9 rounded-full">
                      <Plus size={18} />
                    </Button>
                  </PromptInputAction>

                  <PromptInputAction tooltip="Search">
                    <Button variant="outline" className="rounded-full">
                      <Globe size={18} />
                      Search
                    </Button>
                  </PromptInputAction>

                  <PromptInputAction tooltip="More actions">
                    <Button variant="outline" size="icon" className="size-9 rounded-full">
                      <MoreHorizontal size={18} />
                    </Button>
                  </PromptInputAction>
                </div>

                {/* RIGHT */}
                <div className="flex items-center gap-2">
                  <PromptInputAction tooltip="Voice input">
                    <Button variant="outline" size="icon" className="size-9 rounded-full">
                      <Mic size={18} />
                    </Button>
                  </PromptInputAction>

                  <Button
                    size="icon"
                    disabled={(!loading && (!input.trim() || !userId)) || (loading && !stopMessage)}
                    onClick={loading ? handleStop : onSubmit}
                    className="size-9 rounded-full"
                    variant={loading ? "destructive" : "default"}
                    title={loading && !stopMessage ? "Stop ยังไม่ถูก implement ใน useChatHistory" : undefined}
                  >
                    {!loading ? <ArrowUp size={18} /> : <Square size={18} fill="currentColor" />}
                  </Button>
                </div>
              </PromptInputActions>
            </div>
          </PromptInput>
        </div>
      </div>
    </main>
  )
}
