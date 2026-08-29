export function isChatFirstEnabled(): boolean {
  return process.env.APP_SHELL_CHAT_FIRST_ENABLED === "true";
}
