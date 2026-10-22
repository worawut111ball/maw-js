// Shared helpers handed to every feature pack. Feature files import from here, never edit api.ts.
export { readScreen, typeInto, pressKey, roomChannel, readLiveRooms, notifyPhones, claudeTranscript, codexFileFor, workspacePath, ss, supersetSnapshot, SUPERSET_BIN, QUICK_KEYS } from "../api";
export type { ReplyChannel, LiveRoom, ChatItem } from "../api";
export { scanRepos, inputDraft, agentSpinner } from "../api";   // prs pack
