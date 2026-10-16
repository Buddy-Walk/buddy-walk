import { AppContext } from "../types";
import dotenv from 'dotenv';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());

dotenv.config();

const subscriptionKey = process.env.AZURE_SUBSCRIPTION_KEY;
const region = process.env.AZURE_REGION;
export class TokenService {
  /**
   * Exchange the configured Azure subscription key for a short-lived speech token and return its
   * region to the mobile client.
   */
  async getToken(ctx:AppContext) {
    const {res} = ctx;

    try {
      const response = await axios.post(
        `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
        null,
        {
          headers: {
            'Ocp-Apim-Subscription-Key': subscriptionKey,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      res.status(200).json({
        message: "Token fetched successfully",
        token: response.data,
        region: region
      });
      
    } catch (error) {
      console.error('Error fetching token:', error);
      res.status(500).json({
        code: 500,      
        message: 'Failed to fetch token'
      });
    }
  }
}