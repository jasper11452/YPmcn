// @ts-nocheck
export const TOOL_DEFINITIONS = [
    {
        name: "sync_creator_tag_vectors",
        description: "Sync creator tag vectors from MySQL source tables into the Qdrant vector store.",
        inputSchema: {
            type: "object",
            properties: {
                sourceMappingPath: { type: "string", description: "Path to the source-field mapping JSON file." },
                platform: { type: "string", enum: ["xhs", "dy"], description: "Platform to sync." },
                dryRun: { type: "boolean", description: "If true, validate without writing." },
            },
            required: [],
        },
    },
    {
        name: "search_creator_tag_vectors",
        description: "Search for similar creators by tag vectors.",
        inputSchema: {
            type: "object",
            properties: {
                platform: { type: "string", enum: ["xhs", "dy"], description: "Platform to search." },
                positiveRequirements: { type: "array", items: { type: "string" }, description: "Tags to match." },
                negativeRequirements: { type: "array", items: { type: "string" }, description: "Tags to exclude." },
                limit: { type: "number", description: "Max results. Defaults to 20." },
            },
            required: ["positiveRequirements", "negativeRequirements"],
        },
    },
    {
        name: "health_check_vector_store",
        description: "Check health of the vector store dependencies.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
];
