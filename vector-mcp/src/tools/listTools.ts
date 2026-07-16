// @ts-nocheck
export const TOOL_DEFINITIONS = [
  {
    name: "sync_creator_tag_vectors",
    description: "Sync creator tag vectors from MySQL source tables into the Qdrant vector store.",
    inputSchema: {
      type: "object",
      properties: {
        sourceMappingPath: { type: "string", description: "Path to the source-field mapping JSON file." },
        platform: { type: "string", enum: ["xiaohongshu", "douyin"], description: "Platform to sync." },
        cursor: { type: "string", description: "Manual incremental cursor; selects update_time > cursor." },
        limit: { type: "number", description: "Bounded source rows for this manual run." },
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
        platform: { type: "string", enum: ["xiaohongshu", "douyin"], description: "Platform to search." },
        queryText: { type: "string", description: "Direct local-test query text." },
        projectId: { type: ["string", "number"], description: "Optional core_project id used to load description." },
        positiveRequirements: { type: "array", items: { type: "string" }, description: "Tags to match." },
        negativeRequirements: { type: "array", items: { type: "string" }, description: "Tags to exclude." },
        limit: { type: "number", description: "Max results. Defaults to 20." },
        candidateLimit: { type: "number", description: "Local-test vector candidates before MySQL revalidation." },
        region: { type: "string", description: "MySQL-authoritative province/city hard filter." },
        followerMin: { type: "number", description: "MySQL-authoritative minimum follower hard filter." },
        followerMax: { type: "number", description: "MySQL-authoritative maximum follower hard filter." },
        priceMin: { type: "number", description: "Fails closed while source price is unavailable." },
        priceMax: { type: "number", description: "Fails closed while source price is unavailable." },
        compliance: { type: "string", description: "Fails closed while source compliance is unavailable." },
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
