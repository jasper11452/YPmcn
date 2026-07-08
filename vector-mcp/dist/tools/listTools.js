/**
 * MCP tool definitions for the vector recall layer.
 */
export const TOOL_DEFINITIONS = [
    {
        name: "sync_creator_tag_vectors",
        description: "Sync creator tag vectors from MySQL source tables into the Qdrant vector store. Reads source rows, embeds tag combinations, and upserts into Qdrant.",
        inputSchema: {
            type: "object",
            properties: {
                sourceMappingPath: {
                    type: "string",
                    description: "Path to the source-field mapping JSON file. Uses default if omitted.",
                },
                platform: {
                    type: "string",
                    enum: ["xhs", "dy"],
                    description: "Platform to sync. Syncs all platforms if omitted.",
                },
                dryRun: {
                    type: "boolean",
                    description: "If true, validate and report without writing to Qdrant.",
                },
            },
            required: [],
        },
    },
    {
        name: "search_creator_tag_vectors",
        description: "Search for similar creators by tag vectors. Embeds positive/negative requirements, queries Qdrant, and optionally reranks results.",
        inputSchema: {
            type: "object",
            properties: {
                platform: {
                    type: "string",
                    enum: ["xhs", "dy"],
                    description: "Platform to search. Searches all if omitted.",
                },
                positiveRequirements: {
                    type: "array",
                    items: { type: "string" },
                    description: "Tags that should be present in matching creators.",
                },
                negativeRequirements: {
                    type: "array",
                    items: { type: "string" },
                    description: "Tags that should NOT be present in matching creators.",
                },
                limit: {
                    type: "number",
                    description: "Maximum number of results to return. Defaults to 20.",
                },
            },
            required: ["positiveRequirements", "negativeRequirements"],
        },
    },
    {
        name: "health_check_vector_store",
        description: "Check health and connectivity of the vector store dependencies (Qdrant, MySQL, Bailian).",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
];
