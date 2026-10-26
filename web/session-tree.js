/** A top row's branches: none. One array for all of them, so a memoized row sees the same value each time. */
const NO_BRANCHES = Object.freeze([]);

// Presentation only: linked sessions stay independent sessions, never subagents of the one that started them.
export function sessionForest(shown, { pinned = [], folders = false } = {}) {
    const byId = new Map(shown.map((session) => [session.id, session]));
    const pins = new Set(pinned);
    const parents = new Map();

    for (const session of shown) {
        const parent = byId.get(session.linkedFrom?.id);

        if (
            parent &&
            parent.id !== session.id &&
            !pins.has(session.id) &&
            (!folders || parent.cwd === session.cwd)
        ) {
            parents.set(session.id, parent.id);
        }
    }

    // Stored links should be acyclic, but malformed input must not hide rows or loop forever. noid: a session whose
    // links are known to end at a root is not walked again (taking links away never makes a loop), so a long chain
    // costs its length, not its length squared.
    const ends = new Set();

    for (const session of shown) {
        const seen = new Set([session.id]);
        let at = parents.get(session.id);

        while (at !== undefined && !ends.has(at)) {
            if (seen.has(at)) {
                parents.delete(session.id);
                break;
            }

            seen.add(at);
            at = parents.get(at);
        }

        if (at === undefined || ends.has(at)) {
            for (const each of seen) {
                ends.add(each);
            }
        }
    }

    const children = new Map(shown.map((session) => [session.id, []]));

    for (const session of shown) {
        const parent = parents.get(session.id);

        if (parent !== undefined) {
            children.get(parent).push(session);
        }
    }

    // How many rows a row has under it, at any depth: what folding it hides. noid: worked out without recursion, so a
    // chain of links however long cannot run out of stack.
    const counted = new Map();

    const count = (id) => {
        const stack = [id];

        while (stack.length > 0) {
            const at = stack.at(-1);
            const waiting = children.get(at).filter((child) => !counted.has(child.id));

            if (waiting.length > 0) {
                stack.push(...waiting.map((child) => child.id));
            } else {
                stack.pop();
                counted.set(
                    at,
                    children.get(at).reduce((sum, child) => sum + 1 + counted.get(child.id), 0),
                );
            }
        }

        return counted.get(id);
    };

    const rows = new Map();
    const roots = [];

    for (const session of shown) {
        if (parents.has(session.id)) {
            continue;
        }

        const family = [];
        const pending = [{ session, branches: NO_BRANCHES, descendants: count(session.id) }];
        let updatedAt = session.updatedAt;

        while (pending.length > 0) {
            const row = pending.pop();
            const descendants = children.get(row.session.id);

            family.push(row);
            updatedAt = Math.max(updatedAt, row.session.updatedAt);

            for (let index = descendants.length - 1; index >= 0; index--) {
                pending.push({
                    session: descendants[index],
                    branches: [...row.branches, index < descendants.length - 1],
                    descendants: count(descendants[index].id),
                });
            }
        }

        rows.set(session.id, family);
        roots.push({ ...session, updatedAt });
    }

    roots.sort((a, b) => b.updatedAt - a.updatedAt);

    return { roots, rows };
}

/** A list of rows in tree order without those under a folded row (`folded`: the ids folded). */
export function unfolded(rows, folded) {
    const out = [];
    let under = null;

    for (const row of rows) {
        const depth = row.branches.length;

        if (under !== null && depth > under) {
            continue;
        }

        under = row.descendants > 0 && folded.has(row.session.id) ? depth : null;
        out.push(row);
    }

    return out;
}

/**
 * noid: for the sessions not `shown` that `mark` says something of, the nearest shown session each is linked under (by
 * `linkedFrom`, however deep), with the first such mark found for it, or `first` when one under it says that.
 */
export function foldedUnder(sessions, shown, mark, first) {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const marks = new Map();

    for (const session of sessions) {
        const said = shown.has(session.id) ? undefined : mark(session);

        if (said === undefined) {
            continue;
        }

        const passed = new Set();
        let up = session.linkedFrom?.id;

        while (up !== undefined && !shown.has(up) && !passed.has(up)) {
            passed.add(up);
            up = byId.get(up)?.linkedFrom?.id;
        }

        if (up !== undefined && shown.has(up) && (!marks.has(up) || said === first)) {
            marks.set(up, said);
        }
    }

    return marks;
}
