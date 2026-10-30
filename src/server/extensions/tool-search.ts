/**
 * Tool search keeps tools that few conversations use out of every request until Pi asks for them. Each of them, with its
 * prompt section, costs tokens on every request of every conversation; here Pi gets one `tool_search` tool and a line
 * that names what it can load, and a search loads the matches for the next call. Loaded tools stay offered on that
 * branch. Turn this module off and every tool below is offered again, as before.
 *
 * Edit `DEFERRED` to choose which tools wait: what each is for, and the prompt section that goes with it, if one does.
 * From pi-pocket 0.27 (PR #224, #225).
 */
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
    createToolSearchExtension,
    TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import {
    type ConversationId,
    defineExtension,
    type PromptSection,
    type ToolExecutionApi,
    type ToolRegistration,
    section,
    wrapSection,
    wrapTool,
} from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { browserGuide } from "./browser.ts";

/** What loading a search matches at most, when the query is not the names of tools. */
const SEARCH_LIMIT = 2;

/**
 * Tools that wait to be searched for: what each is for, the key of the prompt section shown once it is loaded, and
 * what that section would say, for the codemode route, where the section never shows.
 */
const DEFERRED: Record<
    string,
    { use: string; section?: string; note?: (host: PocketHost, id: ConversationId) => string }
> = {
    browser: {
        use: "open and test web pages in a real browser",
        section: "browser",
        note: browserGuide,
    },
    schedule: { use: "send yourself a message later" },
    watch_pr: { use: "watch a pull request's checks" },
};

/** Each prompt section that waits, and the tools that show it once any of them is loaded. */
const sections = new Map<string, string[]>();

for (const [name, { section: key }] of Object.entries(DEFERRED)) {
    if (key !== undefined) {
        sections.set(key, [...(sections.get(key) ?? []), name]);
    }
}

export default function createToolSearch(host: PocketHost) {
    const base = createToolSearchExtension();
    const search = base.tools![0]!;

    /**
     * A model whose provider takes tool changes in the messages (Claude 4.8 and 5 and later) keeps its tool list, and its
     * prompt cache, when a tool loads. For any other model a load changes the list and writes the cache again, so there
     * the tool is not loaded: Pi gets its description and parameters in the result, and calls it from a codemode script,
     * which can call a tool that is not offered. The conversation's tool list never changes.
     */
    const throughCodemode = async (api: ToolExecutionApi<never>, context: Context) => {
        const agent = await api.agent(context);
        const ref = agent.model;
        const compat =
            ref === undefined
                ? undefined
                : (api.models.getModel(ref.provider, ref.modelId)?.compat as
                      | {
                            supportsMidConvoSystemMessages?: boolean;
                            supportsMidConvoToolChanges?: boolean;
                        }
                      | undefined);

        return (
            (compat?.supportsMidConvoSystemMessages !== true ||
                compat?.supportsMidConvoToolChanges !== true) &&
            agent.tools.some((tool) => tool.name === "codemode")
        );
    };

    const explain = async (names: string[], api: ToolExecutionApi<never>, context: Context) => {
        const waiting = (await api.agent(context)).deferred;

        return names
            .map((name) => {
                const tool = waiting.find((each) => each.name === name)!;
                const note = DEFERRED[name]?.note?.(host, api.conversationId) ?? "";

                return `## ${name}\nCall it from a codemode script: await tools.${name}({ ...args })\n${tool.description}\n${note}\nParameters (JSON Schema): ${JSON.stringify(tool.parameters)}`;
            })
            .join("\n\n");
    };

    // A query that is only names of waiting tools loads exactly those: a BM25 search for "browser" also matches every
    // tool whose text mentions one, and each load is kept for the branch.
    const exact: ToolRegistration = {
        ...search,
        description:
            "Load tools that wait (deferred_tools lists them) before you use them. The query is their names (`browser`, or `browser, schedule`) or words to search for.",
        parameters: Type.Object({
            query: Type.String({ description: "Names of waiting tools, or words to search for." }),
            limit: Type.Optional(
                Type.Number({
                    description: `Matches a text search loads (default ${SEARCH_LIMIT}).`,
                }),
            ),
        }),
        async execute(args: { query: string; limit?: number }, api, context) {
            const names = String(args.query)
                .split(/[\s,]+/)
                .filter(Boolean);
            const waiting = (await api.agent(context)).deferred.map((tool) => tool.name);
            const result =
                names.length > 0 && names.every((name) => waiting.includes(name))
                    ? ({
                          output: [
                              {
                                  type: "text",
                                  text: `Loaded ${names.join(", ")}. Use them from your next call.`,
                              },
                          ],
                          details: { loaded: names },
                          control: { addTools: names },
                      } as Awaited<ReturnType<typeof search.execute>>)
                    : await search.execute(
                          { ...args, limit: args.limit ?? SEARCH_LIMIT } as never,
                          api,
                          context,
                      );
            const loaded = (result.details as { loaded?: string[] } | undefined)?.loaded ?? [];

            if (loaded.length === 0 || !(await throughCodemode(api as never, context))) {
                return result;
            }

            return {
                output: [
                    {
                        type: "text",
                        text: `Use these through codemode:\n\n${await explain(loaded, api as never, context)}`,
                    },
                ],
                details: { loaded: [] },
            };
        },
    } as ToolRegistration;

    return defineExtension({
        name: "pocket-tool-search",
        tools: [exact],
        sections: [
            section("deferred_tools", ({ agent }) =>
                agent.deferred.length === 0
                    ? undefined
                    : `Load a tool before you use it: ${TOOL_SEARCH_TOOL_NAME} with its name as the query. Waiting:\n${agent.deferred
                          .map(
                              (tool) =>
                                  `- ${tool.name}: ${DEFERRED[tool.name]?.use ?? tool.description.split(".")[0]}`,
                          )
                          .join("\n")}`,
            ),
        ],
        wraps: [
            ...Object.keys(DEFERRED).map((name) =>
                wrapTool({ name } as ToolRegistration, (tool) => ({ ...tool, deferred: true })),
            ),
            // A section waits with its tools: its text is of no use while none of them is offered.
            ...[...sections].map(([key, names]) =>
                wrapSection(key, (inner: PromptSection) => ({
                    ...inner,
                    render: (input, context) =>
                        input.agent.tools.some((tool) => names.includes(tool.name))
                            ? inner.render(input, context)
                            : undefined,
                })),
            ),
        ],
    });
}
