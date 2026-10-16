import {ChatLogService} from "../services/chatLog";
import {Request, Response} from "express";
import {messageInterface, chatLogInterface} from "../database/models/chatLog";
import { buildDateFilter, isAdminAuthorized, parseLimit } from "../utils/adminAuth";
import { toCsv } from "../utils/csv";

const chatLogService = new ChatLogService();

const CHATLOG_CSV_COLUMNS = [
  "date",
  "user",
  "input",
  "output",
  "hasImage",
  "lat",
  "lon",
  "flagged",
  "flag_reason",
];

export class ChatLogController {
  /**
   * Create a conversation log from the request body and return the service response through the
   * HTTP context.
   */
  async createChatLog(req: Request, res: Response): Promise<void> {
    const body: chatLogInterface = req.body;
    await chatLogService.newChatLog({req,res}, body);
  }

  /** Append a message to an existing conversation using the service-level validation and response. */
  async updateChatLog(req: Request, res: Response): Promise<void> {
    const body: {chat: messageInterface, id: string} = req.body;
    await chatLogService.addChat({req,res}, body);
  }
  /** Record the reported message and reason through the chat-log service. */
  async flagMessage(req: Request, res: Response): Promise<void> {
    const body: {messageId: string, flagReason:string, chatlogId:string} = req.body;
    await chatLogService.flagMessage({req,res}, body);
  }

  /**
   * Require admin access, bound the requested date-filtered export, and return chat rows as a CSV
   * download.
   */
  async exportCsv(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const limit = parseLimit(req, 5000, 20000);
    const { rows } = await chatLogService.exportRows(limit, buildDateFilter(req, "date"));
    const csv = toCsv(rows, CHATLOG_CSV_COLUMNS);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="chat_logs.csv"');
    res.status(200).send(csv);
  }
}
