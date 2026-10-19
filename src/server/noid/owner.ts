/** noid's single owner: who it is, and the check its owner-only features (desktop, terminal, groups, auto review) share. */
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";

/** The owner of this server; there is always one, but a test may have made a server without. */
export function ownerOf(app: Pick<PocketApp, "config">): User | undefined {
    return app.config.users.find((user) => user.role === "owner");
}

/** Refuse anyone but the owner, saying why. */
export function requireOwner(user: User, why: string): void {
    if (user.role !== "owner") {
        throw new HttpError(403, why);
    }
}
