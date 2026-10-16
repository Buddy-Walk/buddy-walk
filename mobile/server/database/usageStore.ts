import mongoose from "mongoose";
import { telemetryEventInterface } from "./models/telemetryEvent";
import { feedbackInterface } from "./models/feedback";
import { aiRequestLogInterface } from "./models/aiRequestLog";
import { chatLogInterface, messageInterface } from "./models/chatLog";
import { lastMileTestLogInterface } from "./models/lastMileTestLog";

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

/** Append usage events to the bounded in-memory fallback, evicting the oldest records first. */
export function pushMemoryEvents(events: telemetryEventInterface[]): void {
  memoryEvents.push(...events);
  if (memoryEvents.length > MAX_MEMORY_EVENTS) {
    memoryEvents.splice(0, memoryEvents.length - MAX_MEMORY_EVENTS);
  }
}

/** Append feedback to the bounded in-memory fallback when persistent storage is unavailable. */
export function pushMemoryFeedback(entry: feedbackInterface): void {
  memoryFeedback.push(entry);
  if (memoryFeedback.length > MAX_MEMORY_FEEDBACK) {
    memoryFeedback.splice(0, memoryFeedback.length - MAX_MEMORY_FEEDBACK);
  }
}

/** Retain an AI request in the bounded fallback buffer, preserving the most recent requests. */
export function pushMemoryAiRequest(entry: aiRequestLogInterface): void {
  memoryAiRequests.push(entry);
  if (memoryAiRequests.length > MAX_MEMORY_AI_REQUESTS) {
    memoryAiRequests.splice(0, memoryAiRequests.length - MAX_MEMORY_AI_REQUESTS);
  }
}

/** Retain a Last Meters trial in the bounded fallback buffer for dashboard review. */
export function pushMemoryLastMileTest(entry: lastMileTestLogInterface): void {
  memoryLastMileTests.push(entry);
  if (memoryLastMileTests.length > MAX_MEMORY_LAST_MILE_TESTS) {
    memoryLastMileTests.splice(0, memoryLastMileTests.length - MAX_MEMORY_LAST_MILE_TESTS);
  }
}

/** Create a bounded in-memory conversation with its own ID, timestamp, and copied message list. */
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

/** Look up a fallback conversation by its local identifier. */
export function findMemoryChatLog(id: string): MemoryChatLog | undefined {
  return memoryChatLogs.find(/* Match the requested conversation ID within the fallback buffer. */ (log) => log._id === id);
}

/** Append a message to a known fallback conversation, returning undefined when it no longer exists. */
export function appendMemoryChatMessage(id: string, chat: messageInterface): MemoryChatLog | undefined {
  const log = findMemoryChatLog(id);
  if (!log) return undefined;
  log.messages.push(chat);
  return log;
}

/**
 * Mark a matching fallback message as reported and save the reason without creating missing
 * records.
 */
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
