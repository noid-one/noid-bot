/**
 * For computer.docker.test.ts: open the app on a data folder, start a long command on the shared computer in a new
 * session, say which session and request, and wait to be killed.
 *
 *   node test/computer-crash-child.ts <data folder> <session folder>
 */
import { newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import { route } from "./computer-route.ts";

const [dataDir = "", folder = ""] = process.argv.slice(2);
const app = await openApp(scriptedModel(route), dataDir);
const id = await newSession(app, folder);
const requestId = "crash-long-command";

await app.commands.submit(id, owner(app), {
    text: "run echo started > marker && sleep 30 && echo finished >> marker",
    requestId,
});
console.log(JSON.stringify({ id, requestId }));
await new Promise(() => {});
