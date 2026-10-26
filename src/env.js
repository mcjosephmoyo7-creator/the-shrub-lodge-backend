/**
 * Loads environment variables from the backend's .env file.
 *
 * The path is resolved relative to this file rather than process.cwd(), so the
 * server works no matter which directory it is started from (npm scripts, an
 * IDE/debugger, nodemon, docker, etc.).
 */

import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const envPath = fileURLToPath(new URL("../.env", import.meta.url));

dotenv.config({ path: envPath, quiet: true });

/**
 * Returns a required environment variable or throws a helpful error.
 *
 * @param {string} name Environment variable name.
 * @returns {string} The trimmed value.
 */
export function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}\n` +
        `Local development: add it to ${envPath} (copy .env.example to .env).\n` +
        "Hosted deployments (Render, etc.): add it under the service's\n" +
        "Environment Variables in the dashboard, then redeploy."
    );
  }

  return value;
}
