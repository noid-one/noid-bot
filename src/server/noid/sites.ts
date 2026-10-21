/**
 * Sites, as approvals trust them: the registrable domain of a web address, so `docs.example.com` is `example.com`'s
 * site. After rakazo's `egress.ts` (`hostSite`, `sitesInText`, Apache-2.0), with a short list of suffixes in place of
 * the public suffix list: shared hosts count each tenant as its own site, so trusting `alice.github.io` never trusts
 * `attacker.github.io`.
 */
import { normalizeUrl } from "../browser/urls.ts";

/**
 * Suffixes under which each name is its own site: country second levels, and hosts where anyone gets a name. A suffix
 * missing here makes its sites too wide (`a.co.xx` and `b.co.xx` one site), so the common ones are listed.
 */
const SUFFIXES = new Set([
    // Country second levels.
    "ac.uk",
    "co.uk",
    "gov.uk",
    "org.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "co.jp",
    "ne.jp",
    "or.jp",
    "co.kr",
    "co.in",
    "co.za",
    "com.ar",
    "com.br",
    "com.cn",
    "com.co",
    "com.mx",
    "com.sg",
    "com.tr",
    "com.tw",
    "com.hk",
    "com.es",
    // Shared hosts.
    "github.io",
    "gitlab.io",
    "githubusercontent.com",
    "pages.dev",
    "workers.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "appspot.com",
    "blogspot.com",
    "wordpress.com",
    "substack.com",
    "medium.com",
    "notion.site",
    "s3.amazonaws.com",
    "cloudfront.net",
    "azurewebsites.net",
    "onrender.com",
    "fly.dev",
    "railway.app",
    "glitch.me",
    "replit.app",
    "ngrok.io",
    "ngrok-free.app",
    "ngrok.app",
    "trycloudflare.com",
    "loca.lt",
    "requestcatcher.com",
    "webhook.site",
    "pipedream.net",
]);

/** The site of a host name: an IP address or a one-label name (`localhost`) is its own. */
export function hostSite(hostname: string): string | undefined {
    const host = hostname.trim().toLowerCase().replace(/\.$/, "");

    if (host === "") {
        return undefined;
    }

    if (host.startsWith("[") || /^[\d.]+$/.test(host)) {
        return host;
    }

    const labels = host.split(".");

    for (const size of [3, 2]) {
        if (labels.length > size && SUFFIXES.has(labels.slice(-size).join("."))) {
            return labels.slice(-size - 1).join(".");
        }
    }

    return labels.slice(-2).join(".");
}

/**
 * The site a web address goes to, read as the browser tool reads it (`normalizeUrl`: `example.com`, `host:port`,
 * `http:evil.com`, `https:/evil.com`), or undefined for one that is not http(s) (a file, say). An http(s) address
 * whose host cannot be read is a site of its own that nothing trusts.
 */
export function urlSite(address: string): string | undefined {
    const normal = normalizeUrl(address);

    if (normal === undefined) {
        return undefined;
    }

    try {
        const url = new URL(normal);

        return url.protocol === "http:" || url.protocol === "https:"
            ? (hostSite(url.hostname) ?? `(no host) ${normal}`)
            : undefined;
    } catch {
        return undefined;
    }
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DOMAIN_IN_TEXT =
    /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9](?![\w-])/gi;

/**
 * The sites a person named in their own words: links, and bare names such as `news.ycombinator.com`. A link grants
 * only its own host, not a name in its path or query; an address after `@` is an email, not a site.
 */
export function sitesInText(text: string): Set<string> {
    const sites = new Set<string>();

    for (const [match] of text.matchAll(URL_IN_TEXT)) {
        const site = urlSite(match.replace(/[.,;:!?)\]}]+$/, ""));

        if (site !== undefined) {
            sites.add(site);
        }
    }

    for (const [match] of text.replace(URL_IN_TEXT, " ").matchAll(DOMAIN_IN_TEXT)) {
        const site = hostSite(match);

        if (site !== undefined) {
            sites.add(site);
        }
    }

    return sites;
}
