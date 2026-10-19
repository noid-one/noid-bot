/**
 * `/api`: the routes the web app calls. Each needs a signed-in person, and each but a GET needs the `X-Pocket` header,
 * which a form on another site cannot send. A conversation's routes are in `conversation-routes.ts`.
 */
import { autoReview } from "../noid/auto-review.ts";
import type { BotRequest } from "../noid/bots.ts";
import { readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { MAX_PEEKS } from "../app.ts";
import {
    type Auth,
    COOKIE,
    clearAuthCookie,
    INVITE_MINUTES,
    type InviteGrant,
    type InviteMinutes,
    origin,
    parseCookies,
    quickTunnelHost,
} from "../auth.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { desktopTheme, wallpaperFile } from "../omarchy.ts";
import { runningNow } from "../running.ts";
import { serveImage } from "./assets.ts";
import { browserRoutes } from "./browser-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { createEventStreams } from "./events.ts";
import { extensionRoute } from "./extension-routes.ts";
import { type ApiRequest, conversationId, type HttpOptions, json, readJson } from "./io.ts";
import { pushRoutes } from "./push-routes.ts";

/** This machine's non-internal IPv4 addresses, for invite links other devices on its networks can open. */
function lanAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
        .map((net) => net!.address);
}

/** The `/api` routes. Each HTTP handler makes its own, and its event streams live as long as it does. */
export function createApi(options: HttpOptions, auth: Auth) {
    const { app } = options;
    const { events, poll } = createEventStreams(app);

    const requireUser = (request: IncomingMessage): User => {
        const user = auth.user(request);

        if (user === undefined) {
            throw new HttpError(401, "Sign in first");
        }

        return user;
    };

    const requireOwner = (user: User): void => {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }
    };

    /**
     * What an invite may grant: viewers and people invited to one session cannot invite anyone, and only the owner can
     * sign a device in as the owner (never for one session).
     */
    const inviteGrant = (user: User, body: { role?: unknown; session?: unknown }): InviteGrant => {
        if (body.role === "owner") {
            requireOwner(user);

            return { role: "owner" };
        }

        if (user.role === "viewer" || user.sessions !== undefined) {
            throw new HttpError(403, "Only people with access to every session can invite others.");
        }

        const role = body.role === "viewer" ? "viewer" : "guest";

        if (body.session === undefined || body.session === null) {
            return { role };
        }

        const session = conversationId(String(body.session));

        if (!app.sessions(user).some((each) => each.id === Number(session))) {
            throw new HttpError(400, "No such session");
        }

        return { role, session: String(session) };
    };

    /** How long an invite lasts, in minutes: one of `INVITE_MINUTES`, 15 when not said. */
    const inviteMinutes = (body: { minutes?: unknown }): InviteMinutes => {
        if (body.minutes === undefined) {
            return 15;
        }

        const minutes = INVITE_MINUTES.find((each) => each === body.minutes);

        if (minutes === undefined) {
            throw new HttpError(400, "An invite lasts 15 minutes, an hour, a day, or a week.");
        }

        return minutes;
    };

    /** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
    const noteTunnel = (request: IncomingMessage, user: User): void => {
        if (
            user.role === "owner" ||
            user.tunnel !== undefined ||
            !parseCookies(request.headers.cookie)[COOKIE]
        ) {
            return;
        }

        const tunnel = quickTunnelHost(request);

        if (tunnel !== undefined) {
            app.config.updateUser(user.id, { tunnel });
        }
    };

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        parts: string[],
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const user = requireUser(request);

        noteTunnel(request, user);

        if (method !== "GET" && request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const [first, second, third, fourth] = parts;
        const route: ApiRequest = { app, request, response, url, user };

        if (first === "events" && method === "GET") {
            return events(request, response, url, user);
        }

        if (first === "poll" && method === "GET") {
            return poll(request, response, url, user);
        }

        if (first === "me" && method === "GET") {
            return json(response, 200, await app.hello(user));
        }

        if (first === "me" && method === "POST") {
            const body = await readJson<{ name?: string }>(request);
            const name = String(body.name ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);

            if (name === "") {
                throw new HttpError(400, "Name is empty");
            }

            app.rename(user, name);

            return json(response, 200, { ok: true });
        }

        if (first === "folder-favorites" && second === undefined && method === "GET") {
            return json(response, 200, await app.folderFavorites.list(user));
        }

        if (first === "folder-favorites" && second === undefined && method === "POST") {
            await app.folderFavorites.set(user, await readJson(request));

            return json(response, 200, { ok: true });
        }

        if (first === "logout" && method === "POST") {
            clearAuthCookie(response);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second === undefined && method === "GET") {
            return json(response, 200, app.people(user));
        }

        if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
            app.removeUser(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second !== undefined && third === undefined && method === "POST") {
            app.setAccess(user, second, await readJson(request));

            return json(response, 200, app.people(user));
        }

        if (first === "visibility" && method === "POST") {
            const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);

            app.setVisible(user, String(body.tab ?? ""), body.visible !== false);

            return json(response, 200, { ok: true });
        }

        // The sessions a connection shows as peek tiles on screen now: they get `peek` events until it sends another list.
        if (first === "peeks" && method === "POST") {
            const body = await readJson<{ connection?: unknown; ids?: unknown; seq?: unknown }>(
                request,
            );

            if (!Array.isArray(body.ids)) {
                throw new HttpError(400, "ids must be a list of session ids");
            }

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setPeeks(
                user,
                String(body.connection ?? ""),
                body.ids.slice(0, MAX_PEEKS).map((id) => conversationId(String(id))),
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        // Every subagent in the sessions this person can see, as the subagents board shows them.
        if (first === "subagents" && method === "GET") {
            return json(response, 200, app.subagents(user));
        }

        // Webhooks: the ones this person may manage, with the address to give other services; making and removing one.
        if (first === "hooks" && second === undefined && method === "GET") {
            return json(response, 200, await app.commands.hooks(user));
        }

        if (first === "hooks" && second === undefined && method === "POST") {
            return json(response, 200, await app.commands.addHook(user, await readJson(request)));
        }

        // A repository watch removed, by its person or the owner.
        if (
            first === "repo-watches" &&
            second !== undefined &&
            third === "remove" &&
            method === "POST"
        ) {
            await app.repoWatches.remove(user, second);

            return json(response, 200, { ok: true });
        }

        // A repository watch let hear from anyone, or only from the repository's people: by its person or the owner,
        // never by a bot.
        if (
            first === "repo-watches" &&
            second !== undefined &&
            third === "anyone" &&
            method === "POST"
        ) {
            const body = await readJson<{ anyone?: unknown }>(request);

            if (typeof body.anyone !== "boolean") {
                throw new HttpError(400, "anyone must be true or false");
            }

            await app.repoWatches.setAnyone(user, second, body.anyone);

            return json(response, 200, { ok: true });
        }

        // A new secret, for a hook whose address or secret got out.
        if (first === "hooks" && second !== undefined && third === "rotate" && method === "POST") {
            return json(response, 200, await app.hooks.rotate(user, second));
        }

        if (
            first === "hooks" &&
            second !== undefined &&
            parts[2] === "remove" &&
            method === "POST"
        ) {
            await app.commands.removeHook(user, second);

            return json(response, 200, { ok: true });
        }

        // The subagents board opened or closed in a tab: while open, it gets every subagent (`subagents` events).
        if (first === "subagents" && method === "POST") {
            const body = await readJson<{ connection?: unknown; on?: unknown; seq?: unknown }>(
                request,
            );

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setBoard(
                user,
                String(body.connection ?? ""),
                body.on === true,
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "push") {
            return pushRoutes(route, second);
        }

        // The Omarchy desktop's theme, for the app's "Follow desktop" look: colors say nothing about the sessions here, so
        // everyone signed in gets them. The wallpaper may be a personal photo: only the owner gets that.
        if (first === "theme" && second === undefined && method === "GET") {
            const theme = await desktopTheme();

            return json(response, 200, {
                theme:
                    theme === null
                        ? null
                        : { ...theme, wallpaper: theme.wallpaper && user.role === "owner" },
            });
        }

        // Theme folders (`themes.ts`): everyone signed in lists them, as everyone chooses one for their own browsers;
        // only the owner adds, edits, and removes them.
        if (first === "themes" && second === undefined && method === "GET") {
            return json(response, 200, { themes: app.themes.list(user.role === "owner") });
        }

        if (first === "themes" && second === "default" && method === "PUT") {
            await app.setThemeDefault(
                user,
                (await readJson<{ default?: unknown }>(request)).default,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "themes" && second === "duplicate" && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ from?: unknown; name?: unknown; colors?: unknown }>(
                request,
            );

            if (typeof body.from !== "string") {
                throw new HttpError(400, "Say which theme or colors to copy");
            }

            return json(response, 200, {
                id: await app.themes.duplicate(body.from, body.name, body.colors === true),
            });
        }

        if (first === "themes" && second !== undefined && third === "edit" && method === "GET") {
            requireOwner(user);

            return json(response, 200, app.themes.edit(second));
        }

        if (
            first === "themes" &&
            second !== undefined &&
            third === undefined &&
            method === "DELETE"
        ) {
            requireOwner(user);
            app.themes.remove(second);

            return json(response, 200, { ok: true });
        }

        if (first === "theme" && second === "wallpaper" && method === "GET") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner sees the desktop's wallpaper");
            }

            const file = await wallpaperFile();

            if (file === undefined) {
                throw new HttpError(404, "No wallpaper");
            }

            return serveImage(request, response, file);
        }

        if (first === "running" && method === "GET") {
            return json(response, 200, await runningNow(app, user));
        }

        if (first === "spend" && method === "GET") {
            return json(response, 200, app.spend.summary(user));
        }

        if (first === "spend" && method === "POST") {
            const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(
                request,
            );

            if (body.session !== undefined) {
                await app.spend.setSessionBudget(
                    user,
                    conversationId(String(body.session)),
                    body.budget,
                );
            } else if (typeof body.person === "string") {
                app.spend.setPersonBudget(user, body.person, body.budget);
            } else {
                throw new HttpError(400, "Say which session or person");
            }

            return json(response, 200, app.spend.summary(user));
        }

        if (first === "sessions" && second === undefined && method === "GET") {
            return json(response, 200, app.sessions(user));
        }

        // Pi's sessions from the terminal, which the owner can continue here.
        if (first === "pi-sessions" && second === undefined && method === "GET") {
            return json(
                response,
                200,
                await app.piSessions.list(user, url.searchParams.get("q") ?? ""),
            );
        }

        if (first === "pi-sessions" && second === "preview" && method === "GET") {
            return json(
                response,
                200,
                await app.piSessions.preview(user, url.searchParams.get("path") ?? ""),
            );
        }

        if (first === "pi-sessions" && second === "continue" && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "path is required");
            }

            return json(response, 200, await app.commands.continuePiSession(user, body.path));
        }

        if (first === "sessions" && second === undefined && method === "POST") {
            const body = await readJson<{ cwd?: string; title?: string; worktree?: unknown }>(
                request,
            );

            return json(response, 200, await app.commands.createSession(user, body));
        }

        if (first === "sessions" && second !== undefined && method === "POST") {
            const body = await readJson<{ title?: string; archived?: boolean }>(request);

            await app.commands.updateSession(conversationId(second), user, body);

            return json(response, 200, { ok: true });
        }

        // noid: auto review of bots' calls, which the owner turns on and off.
        if (first === "auto-review" && second === undefined) {
            const body = method === "POST" ? await readJson<{ on?: unknown }>(request) : undefined;

            return json(response, 200, {
                on: await autoReview(app, user, body === undefined ? undefined : body.on === true),
            });
        }

        // noid: group threads, the owner and several bots in one room.
        if (first === "groups" && second === undefined) {
            return method === "POST"
                ? json(response, 200, await app.groups.create(user, await readJson(request)))
                : json(response, 200, { groups: await app.groups.list(user) });
        }

        if (first === "groups" && second !== undefined && third === undefined && method === "GET") {
            return json(response, 200, await app.groups.get(user, second));
        }

        if (
            first === "groups" &&
            second !== undefined &&
            third === "messages" &&
            method === "POST"
        ) {
            return json(
                response,
                200,
                await app.groups.send(user, second, await readJson(request)),
            );
        }

        if (first === "groups" && second !== undefined && third === "stop" && method === "POST") {
            await app.groups.stop(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "groups" && second !== undefined && third === "delete" && method === "POST") {
            await app.groups.remove(user, second);

            return json(response, 200, { ok: true });
        }

        // noid: the computer's desktop, which the owner watches and can take over.
        if (first === "desktop" && second === undefined && method === "GET") {
            return json(response, 200, await app.desktop.view(user));
        }

        // The owner restarts the computer: what it runs stops, and an older image is replaced.
        if (first === "computer" && second === "restart" && method === "POST") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner can restart the computer.");
            }

            await app.computer.restart();

            return json(response, 200, { ok: true });
        }

        // The owner shows a task on the desktop, and it becomes a skill.
        if (first === "desktop" && second === "teach" && method === "POST") {
            await app.desktop.teach(user, await readJson(request));

            return json(response, 200, { ok: true });
        }

        if (first === "desktop" && second === "learned" && method === "POST") {
            const { save } = await readJson<{ save?: unknown }>(request);

            return json(response, 200, await app.desktop.learned(user, save === true));
        }

        if (first === "desktop" && second === "input" && method === "POST") {
            await app.desktop.act(user, await readJson<Record<string, unknown>>(request));

            return json(response, 200, { ok: true });
        }

        // noid: the owner's terminals on the shared computer. Output is read by long polling from an offset.
        if (first === "terminals" && second === undefined) {
            return method === "POST"
                ? json(response, 200, await app.terminals.open(user, await readJson(request)))
                : json(response, 200, { terminals: app.terminals.list(user) });
        }

        if (first === "terminals" && second !== undefined && third === "read" && method === "GET") {
            const gone = new AbortController();

            response.on("close", () => gone.abort());

            return json(
                response,
                200,
                await app.terminals.read(
                    user,
                    second,
                    Number(url.searchParams.get("from")) || 0,
                    gone.signal,
                ),
            );
        }

        if (first === "terminals" && second !== undefined && method === "POST") {
            const body = await readJson<{ data?: unknown; cols?: unknown; rows?: unknown }>(
                request,
            );

            if (third === "input") {
                app.terminals.write(user, second, body.data);
            } else if (third === "resize") {
                app.terminals.resize(user, second, body.cols, body.rows);
            } else if (third === "close") {
                app.terminals.close(user, second);
            } else {
                throw new HttpError(404, "Unknown API route");
            }

            return json(response, 200, { ok: true });
        }

        // noid: bots. A bot is a session (its list item carries `bot`), so listing and archiving are the sessions' own.
        if (first === "bots" && second === undefined && method === "POST") {
            return json(
                response,
                200,
                await app.bots.create(user, await readJson<BotRequest>(request)),
            );
        }

        // noid: a model's name for a bot, from what it does.
        if (first === "bots" && second !== undefined && third === "name" && method === "POST") {
            return json(response, 200, await app.bots.suggestName(user, conversationId(second)));
        }

        if (first === "bots" && second !== undefined && method === "POST") {
            return json(
                response,
                200,
                await app.bots.update(
                    user,
                    conversationId(second),
                    await readJson<BotRequest>(request),
                ),
            );
        }

        if (first === "c" && second !== undefined) {
            const id = conversationId(second);

            app.requireSee(user, id);

            if (third === "browser") {
                return browserRoutes(route, id, fourth, options.listen.port);
            }

            return conversationRoutes(route, id, parts);
        }

        if (first === "approvals" && second !== undefined && method === "POST") {
            const body = await readJson<{ allow?: boolean; always?: boolean }>(request);

            // An id may hold a slash, which the path decoded into a part of its own: a codemode script's calls are
            // named `<call>/<n>`.
            if (
                !(await app.answerApproval(
                    parts.slice(1).join("/"),
                    body.allow === true,
                    user,
                    body.always === true,
                ))
            ) {
                throw new HttpError(404, "That approval is no longer pending");
            }

            return json(response, 200, { ok: true });
        }

        if (first === "fs" && method === "GET") {
            app.requireSteer(user);

            if (user.sessions !== undefined) {
                throw new HttpError(403, "You were invited to one session.");
            }

            const requested = url.searchParams.get("path") || "~";
            const path = app.workspace.checkDirectory(requested);
            const showHidden = url.searchParams.get("hidden") === "1";
            const dirs: { name: string; path: string }[] = [];

            for (const entry of readdirSync(path, { withFileTypes: true })) {
                if (!showHidden && entry.name.startsWith(".")) {
                    continue;
                }

                let isDir = entry.isDirectory();

                if (entry.isSymbolicLink()) {
                    try {
                        isDir = statSync(join(path, entry.name)).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }

                if (isDir) {
                    dirs.push({ name: entry.name, path: join(path, entry.name) });
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));
            // noid: folders on the shared computer are not this machine's to browse.
            const recent = [...new Set(app.sessions(user).map((session) => session.cwd))]
                .filter((cwd) => !app.claims(cwd))
                .slice(0, 8);

            return json(response, 200, {
                path,
                parent: dirname(path) === path ? null : dirname(path),
                home: homedir(),
                dirs: dirs.slice(0, 1000),
                recent,
            });
        }

        // A new folder, from the folder picker: it opens in the picker, ready to use.
        if (first === "fs" && second === undefined && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "Name the folder to make.");
            }

            return json(response, 200, { path: app.workspace.makeFolder(user, body.path) });
        }

        if (first === "settings" && method === "POST") {
            const body = await readJson<{
                approvalRule?: unknown;
                defaultModel?: unknown;
                pipCompactAt?: unknown;
                subagentModels?: unknown;
            }>(request);

            // One at a time: a second that fails must not leave the first changed.
            if (
                [
                    body.approvalRule,
                    body.defaultModel,
                    body.pipCompactAt,
                    body.subagentModels,
                ].filter((value) => value !== undefined).length > 1
            ) {
                throw new HttpError(400, "Change one setting at a time.");
            }

            // The models subagents may run on besides their session's own: the owner's (checked in `app.ts`).
            if (body.subagentModels !== undefined) {
                await app.setSubagentModels(user, body.subagentModels);
            }

            // "pipCompactAt": named as the config stores it.
            if (body.pipCompactAt !== undefined) {
                await app.setNoidCompactAt(user, body.pipCompactAt);
            }

            if (body.approvalRule !== undefined) {
                await app.setApprovalRule(user, body.approvalRule);
            }

            // Null clears it: new sessions start with the last model picked again.
            if (body.defaultModel !== undefined) {
                await app.setDefaultModel(user, body.defaultModel);
            }

            return json(response, 200, { ok: true });
        }

        // One model allowed for subagents, or no longer: the rest stay as they are. The owner's (checked in `app.ts`).
        if (first === "subagent-models" && second === undefined && method === "POST") {
            const body = await readJson<{ model?: unknown; allowed?: unknown }>(request);

            return json(response, 200, {
                subagentModels: await app.allowSubagentModel(user, body.model, body.allowed),
            });
        }

        // Routes extension modules add, each checking who may use it (`extension-routes.ts`).
        if (first === "x" && second !== undefined) {
            return extensionRoute(route, parts.slice(1));
        }

        if (first === "extensions" && second === undefined && method === "GET") {
            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ enabled?: unknown }>(request);

            if (typeof body.enabled !== "boolean") {
                throw new HttpError(400, "enabled must be true or false");
            }

            await app.setExtensionEnabled(user, second, body.enabled);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === "reload" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.reloadExtension(second);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "models" &&
            second === "refresh" &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);

            return json(response, 200, await app.providers.modelRefresh.refresh());
        }

        // For the owner, each subscription's sign-in is asked afresh first (three seconds at most; a mark found later
        // comes with the models): one that can no longer be renewed shows as needing sign-in. Others see what was last
        // found, so nobody else makes the server ask providers.
        if (first === "providers" && second === undefined && method === "GET") {
            if (user.role === "owner") {
                await app.providers.checkAll(3_000);
            }

            return json(response, 200, app.providers.list(user.role === "owner"));
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "login" &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ type?: string }>(request);

            return json(response, 200, {
                flowId: app.providers.startLogin(
                    user,
                    second,
                    body.type === "oauth" ? "oauth" : "api_key",
                ),
            });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "logout" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.providers.logout(second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
            app.providers.cancelLogin(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
            const body = await readJson<{ value?: string; cancel?: boolean }>(request);

            app.providers.answerLogin(
                user,
                second,
                third,
                body.cancel === true ? undefined : String(body.value ?? ""),
            );

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === "cancel" && method === "POST") {
            const body = (await readJson(request)) as { code?: unknown };

            if (typeof body.code !== "string") {
                throw new HttpError(400, "Say which invite.");
            }

            // Only whoever made it ends it; for anyone else it stays as it was, and nothing says whether it exists.
            auth.cancelInvite(body.code, user);

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === undefined && method === "POST") {
            const body = (await readJson(request)) as {
                role?: unknown;
                session?: unknown;
                minutes?: unknown;
            };
            const grant = inviteGrant(user, body);
            const invite = auth.createInvite(user, grant, inviteMinutes(body));
            const here = origin(request);
            const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(
                here,
            );
            const wildcard = options.listen.host === "0.0.0.0" || options.listen.host === "::";
            const lan =
                loopback && wildcard
                    ? lanAddresses().map((address) => `http://${address}:${options.listen.port}`)
                    : [];
            // A tunnel the launcher started is the way in for other devices.
            const tunnel = loopback ? app.access?.url : undefined;
            const base = tunnel ?? lan[0] ?? here;
            const link = `${base}/join/${invite.code}`;
            // An invite whose QR code could not be made is never shown: it ends rather than stay live, unseen.
            const svg = await QRCode.toString(link, {
                type: "svg",
                margin: 1,
                color: { dark: "#000000", light: "#ffffff" },
            }).catch((error: unknown) => {
                auth.cancelInvite(invite.code, user);

                throw error;
            });

            return json(response, 200, {
                ...invite,
                grant,
                url: link,
                svg,
                alternatives: (tunnel === undefined ? lan.slice(1) : lan).map(
                    (address) => `${address}/join/${invite.code}`,
                ),
                // Only this device can open a loopback link.
                local: loopback && lan.length === 0 && tunnel === undefined,
                ...(app.access === undefined ? {} : { access: app.access }),
            });
        }

        if (first === "restart" && method === "POST") {
            requireOwner(user);

            if (!app.supervised) {
                throw new HttpError(
                    409,
                    "Start Pi Pocket with bin/pi-pocket.js to restart from the app.",
                );
            }

            json(response, 200, { ok: true });
            setTimeout(() => options.restart(), 100);

            return;
        }

        throw new HttpError(404, "Unknown API route");
    };
}
