import { pino } from "pino";
import { env } from "./env.js";

const level = env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL;

export const logger = pino({
  level,
  base: undefined,
});

export default logger;
