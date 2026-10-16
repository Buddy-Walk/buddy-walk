import { TokenService } from "../services/token";
import { Request, Response } from "express";

const tokenService = new TokenService();
export class TokenController {
  /** Delegate Azure speech-token issuance and its HTTP response to the token service. */
  async getToken(req: Request, res: Response): Promise<void> {
    await tokenService.getToken({req,res});
  }
}