// The isolated Pi install and folders the server tests use. helpers.ts imports this first, so it runs before any module
// from src/ reads Pi's config folder.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);
/** The home folder the app finds `~/.agents/skills` in, for the same isolation. */
export const home = join(root, "home");
mkdirSync(home);
