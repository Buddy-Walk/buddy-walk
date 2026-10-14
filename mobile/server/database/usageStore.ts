import mongoose from "mongoose";
import { telemetryEventInterface } from "./models/telemetryEvent";
import { feedbackInterface } from "./models/feedback";
import { aiRequestLogInterface } from "./models/aiRequestLog";
import { chatLogInterface, messageInterface } from "./models/chatLog";
import { lastMileTestLogInterface } from "./models/lastMileTestLog";
import { lastMileRetryRunInterface } from "./models/lastMileRetryRun";

export interface MemoryChatLog extends chatLogInterface {
  _id: string;
}

/**
 * Usage analytics and feedback should keep working during testing even when
 * MongoDB is unavailable. When not connected, we buffer in process memory so the
 * endpoints still accept data and the team can read it back from the same
 * process.
 */
export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

const MAX_MEMORY_EVENTS = 5000;
const MAX_MEMORY_FEEDBACK = 2000;
const MAX_MEMORY_AI_REQUESTS = 3000;
const MAX_MEMORY_CHAT_LOGS = 500;
const MAX_MEMORY_LAST_MILE_TESTS = 300;

export const memoryEvents: telemetryEventInterface[] = [];
export const memoryFeedback: feedbackInterface[] = [];
export const memoryAiRequests: aiRequestLogInterface[] = [];
export const memoryChatLogs: MemoryChatLog[] = [];
export const memoryLastMileTests: lastMileTestLogInterface[] = [];
/** Dashboard retry runs by idempotency key. Small, so not capped. */
export const memoryRetryRuns = new Map<string, lastMileRetryRunInterface>();

export function pushMemoryEvents(events: telemetryEventInterface[]): void {
  memoryEvents.push(...events);
  if (memoryEvents.length > MAX_MEMORY_EVENTS) {
    memoryEvents.splice(0, memoryEvents.length - MAX_MEMORY_EVENTS);
  }
}

export function pushMemoryFeedback(entry: feedbackInterface): void {
  memoryFeedback.push(entry);
  if (memoryFeedback.length > MAX_MEMORY_FEEDBACK) {
    memoryFeedback.splice(0, memoryFeedback.length - MAX_MEMORY_FEEDBACK);
  }
}

export function pushMemoryAiRequest(entry: aiRequestLogInterface): void {
  memoryAiRequests.push(entry);
  if (memoryAiRequests.length > MAX_MEMORY_AI_REQUESTS) {
    memoryAiRequests.splice(0, memoryAiRequests.length - MAX_MEMORY_AI_REQUESTS);
  }
}

export function pushMemoryLastMileTest(entry: lastMileTestLogInterface): void {
  memoryLastMileTests.push(entry);
  if (memoryLastMileTests.length > MAX_MEMORY_LAST_MILE_TESTS) {
    memoryLastMileTests.splice(0, memoryLastMileTests.length - MAX_MEMORY_LAST_MILE_TESTS);
  }
}

export function createMemoryChatLog(body: chatLogInterface): MemoryChatLog {
  const entry: MemoryChatLog = {
    _id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    user: body.user,
    date: body.date ?? new Date(),
    messages: Array.isArray(body.messages) ? [...body.messages] : [],
  };
  memoryChatLogs.push(entry);
  if (memoryChatLogs.length > MAX_MEMORY_CHAT_LOGS) {
    memoryChatLogs.splice(0, memoryChatLogs.length - MAX_MEMORY_CHAT_LOGS);
  }
  return entry;
}

export function findMemoryChatLog(id: string): MemoryChatLog | undefined {
  return memoryChatLogs.find((log) => log._id === id);
}

export function appendMemoryChatMessage(id: string, chat: messageInterface): MemoryChatLog | undefined {
  const log = findMemoryChatLog(id);
  if (!log) return undefined;
  log.messages.push(chat);
  return log;
}

export function flagMemoryChatMessage(
  chatlogId: string,
  messageId: string,
  flagReason?: string
): MemoryChatLog | undefined {
  const log = findMemoryChatLog(chatlogId);
  if (!log) return undefined;
  for (const msg of log.messages) {
    const msgId = (msg as messageInterface & { _id?: string })._id;
    if (msgId === messageId) {
      msg.flag = true;
      msg.flag_reason = flagReason;
      return log;
    }
  }
  return undefined;
}
