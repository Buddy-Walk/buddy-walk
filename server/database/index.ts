import dotenv from "dotenv";

dotenv.config();

const localLink = "mongodb://127.0.0.1/vlm_dev";
export const databaseLink =
  process.env.NODE_ENV === "production" ? process.env.WEB_LINK : localLink;
// process.env.NODE_ENV === "production" ? prod_link : localLink;

export const config = {
  link: databaseLink,
  options: {
    autoIndex: false,
  },
};

export const TEST_CONTEXT =
  process.env.NODE_ENV === "production" ? "Production Mode" : process.env.TEST;


export const ENV_CHECK =
  process.env.NODE_ENV === "production"
    ? "Production Mode"
    : "Development Mode";

console.log("ENV MODE -> ", ENV_CHECK);
