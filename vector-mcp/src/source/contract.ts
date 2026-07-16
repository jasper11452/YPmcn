// @ts-nocheck
export type SourcePlatform = "xiaohongshu" | "douyin";
export type SourceField = "platform" | "kwUid" | "display_name" | "content_tags" | "grow_tags" | "source_updated_at" | "source_table" | "profile_url";
export const REQUIRED_FIELDS: readonly SourceField[] = ["platform", "kwUid", "content_tags", "grow_tags", "source_updated_at", "source_table"];
export type SourceMapping = Record<SourceField, string>;
export type SourceMappings = Record<SourcePlatform, SourceMapping>;

import { readFileSync } from "node:fs";

export function validateSourceMapping(mappings: SourceMappings): { ok: true } | { ok: false; missing: Array<{ platform: SourcePlatform; field: SourceField }> } {
  const missing: Array<{ platform: SourcePlatform; field: SourceField }> = [];
  for (const platform of ["xiaohongshu", "douyin"] as SourcePlatform[]) {
    const mapping = mappings[platform];
    if (!mapping) { missing.push({ platform, field: "platform" }); continue; }
    for (const field of REQUIRED_FIELDS) {
      if (!mapping[field]) missing.push({ platform, field });
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export function loadSourceMapping(jsonPath: string): SourceMappings {
  const raw = readFileSync(jsonPath, "utf-8");
  const mappings = JSON.parse(raw) as SourceMappings;
  const validation = validateSourceMapping(mappings);
  if (!validation.ok) {
    throw new Error(`Invalid source mapping: missing fields for ${JSON.stringify(validation.missing)}`);
  }
  return mappings;
}
