type PreviewResolution = "mapped" | "preserved" | "missing_required" | "semantic_ambiguity";

export type StandardBriefPreviewAtom = {
  sourceText?: string;
  field: string;
  resolution: PreviewResolution;
  disposition?: "mapped" | "preserved";
  targetField?: string;
  value?: unknown;
  preservedText?: string;
  candidates?: string[];
  reason?: string;
  confidence: number;
  inferred: boolean;
};

export type StandardBriefPreview = {
  schemaVersion: "ypmcn-requirement-preview-v1";
  authoritative: true;
  gate: "missing_required" | "semantic_ambiguity" | "ready";
  atoms: StandardBriefPreviewAtom[];
  projection: Record<string, unknown>;
  missingRequired: string[];
  semanticAmbiguities: string[];
  summary: {
    atomCount: number;
    mappedCount: number;
    preservedCount: number;
    unresolvedCount: number;
  };
};

type LocatedAtom = StandardBriefPreviewAtom & { start: number; end: number };

const REQUIRED_FIELDS = ["platform", "quantityTotal", "submissionDeadlineAt", "creatorPriceTier"] as const;
const PRICE_FIELD_LABEL = "(?:(?:单达人|达人)?[ \\t]*(?:L[ \\t]*[123][ \\t]*)?(?:官方)?(?:价格|单价|预算|报价))";
const FIELD_LABEL = `(?:品牌|产品|项目|(?:发布|传播)?平台|档期|${PRICE_FIELD_LABEL}|返点(?:要求)?|返佣|内容|账号类型|达人类型|数量|达人数量|预计定号数|招募|DDL|截止(?:时间)?|提报(?:截止)?(?:时间)?)`;
const BRIEF_BLOCK_LABEL = `(?:${FIELD_LABEL}|合作形式|参考账号)`;

type BriefCandidate = {
  start: number;
  value: string;
  fieldCount: number;
};

function fieldMatches(value: string): RegExpMatchArray[] {
  return [...value.matchAll(new RegExp(`(${BRIEF_BLOCK_LABEL})\\s*[：:]`, "gi"))];
}

function structuredLine(value: string): boolean {
  return new RegExp(`^\\s*(?:[-*]\\s*)?[“”"'「」『』]?\\s*${BRIEF_BLOCK_LABEL}\\s*[：:]`, "i").test(value);
}

function structuredBriefCandidates(input: string): BriefCandidate[] {
  const lines = input.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const candidates: BriefCandidate[] = [];
  for (let index = 0; index < lines.length;) {
    const matches = fieldMatches(lines[index]);
    const startsWithField = structuredLine(lines[index]);
    if (!startsWithField && matches.length < 3) {
      index += 1;
      continue;
    }

    const startInLine = matches[0]?.index ?? 0;
    let endIndex = index + 1;
    while (endIndex < lines.length && structuredLine(lines[endIndex])) endIndex += 1;
    const value = [lines[index].slice(startInLine), ...lines.slice(index + 1, endIndex)].join("\n").trim();
    const candidateFields = fieldMatches(value);
    if (candidateFields.length >= 3) {
      candidates.push({
        start: offsets[index] + startInLine,
        value,
        fieldCount: candidateFields.length,
      });
    }
    index = endIndex;
  }
  return candidates;
}

export function extractStandardBrief(input: string): string {
  const candidates = structuredBriefCandidates(input);
  const selected = candidates.reduce<BriefCandidate | undefined>((best, candidate) => {
    if (!best || candidate.fieldCount > best.fieldCount) return candidate;
    if (candidate.fieldCount === best.fieldCount && candidate.start > best.start) return candidate;
    return best;
  }, undefined);
  const firstField = new RegExp(`${FIELD_LABEL}\\s*[：:]`, "i").exec(input);
  const value = selected?.value ?? (firstField ? input.slice(firstField.index) : input);
  return value
    .trim()
    .replace(/[。！？!?]+$/g, "")
    .trim();
}

function labeledFieldPattern(label: string, flags = "g"): RegExp {
  return new RegExp(
    `(?:^|(?<=[\\n；;，,]))\\s*${label}\\s*[：:]\\s*([\\s\\S]*?)(?=\\s*(?:[；;\\n]|[，,](?=\\s*${FIELD_LABEL}\\s*[：:])|$))`,
    flags,
  );
}

function localDate(now: Date, timeZone: string): Date {
  const values: Record<string, number> = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return new Date(Date.UTC(values.year, values.month - 1, values.day));
}

function dateTimeForMonthDay(now: Date, timeZone: string, month: number, day: number, hour: number, minute: number): string | undefined {
  const today = localDate(now, timeZone);
  let year = today.getUTCFullYear();
  if (month < today.getUTCMonth() + 1 || (month === today.getUTCMonth() + 1 && day < today.getUTCDate())) year += 1;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function normalizedHour(hour: number, period: string | undefined): number | undefined {
  if (hour > 23) return undefined;
  if (!period) return hour;
  if (hour > 12) return undefined;
  if (/下午|晚上/.test(period)) return hour === 12 ? 12 : hour + 12;
  if (/上午|早上/.test(period)) return hour === 12 ? 0 : hour;
  return hour === 0 ? 12 : hour;
}

function dateTimeForRelativeDay(now: Date, timeZone: string, days: number, hour: number, minute: number): string {
  const date = localDate(now, timeZone);
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function amount(value: string, unit = ""): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  const normalized = unit.toLowerCase();
  return Math.round(parsed * (normalized === "w" || normalized === "万" ? 10_000 : normalized === "k" || normalized === "千" ? 1_000 : 1));
}

function addMatch(
  brief: string,
  matches: LocatedAtom[],
  pattern: RegExp,
  build: (match: RegExpExecArray) => Omit<LocatedAtom, "start" | "end" | "sourceText"> | undefined,
  allowOverlap = false,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(brief)) !== null) {
    const built = build(match);
    if (!built) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (!allowOverlap && matches.some((item) => start < item.end && end > item.start)) continue;
    matches.push({ ...built, sourceText: match[0], start, end });
  }
}

function priceRange(match: RegExpExecArray): string | undefined {
  const lower = amount(match.groups?.lower ?? match.groups?.exact ?? "", match.groups?.lowerUnit ?? match.groups?.exactUnit ?? "");
  if (lower === undefined) return undefined;
  if (match.groups?.upper) {
    const upper = amount(match.groups.upper, match.groups.upperUnit || match.groups.lowerUnit || "");
    if (upper === undefined || lower > upper) return undefined;
    return JSON.stringify([lower, upper]);
  }
  if (match.groups?.upperOnly) return JSON.stringify([0, lower]);
  return JSON.stringify([lower, lower]);
}

function priceTarget(source: string, brief: string): string | undefined {
  const explicit = /L\s*([123])/i.exec(source);
  if (explicit) return `kolOfficialPriceL${explicit[1]}`;
  const context = `${source}\n${brief}`;
  const hasImage = /图文/.test(context);
  const hasVideo = /视频/.test(context);
  if (/小红书|红书|XHS/i.test(brief)) {
    if (hasImage && !hasVideo) return "kolOfficialPriceL1";
    if (hasVideo && !hasImage) return "kolOfficialPriceL2";
  }
  if (/抖音|Douyin|\bDY\b/i.test(brief)) {
    if (/60\s*s?\s*(?:以上|\+)/i.test(context)) return "kolOfficialPriceL3";
    if (/(?:21\s*[-~～—至到]\s*60|21\s*至\s*60)\s*s/i.test(context)) return "kolOfficialPriceL2";
    if (/(?:1\s*[-~～—至到]\s*20|20\s*s?\s*(?:以内|以下))/i.test(context)) return "kolOfficialPriceL1";
  }
  return undefined;
}

export function isStandardBrief(prompt: unknown): prompt is string {
  if (typeof prompt !== "string" || prompt.trim().length < 12) return false;
  const indicators = [
    /小红书|红书|抖音|Douyin|\bXHS\b/i,
    /数量|\d+\s*(?:位|名|个)达人/,
    /价格|单价|预算|报价/,
    /返点|返佣/,
    /账号类型|达人类型/,
    /提报|截止|发布(?:时间|档期|周期)/,
  ];
  return indicators.filter((pattern) => pattern.test(prompt)).length >= 3;
}

export function parseStandardBrief(
  brief: string,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
): StandardBriefPreview {
  brief = extractStandardBrief(brief);
  const matches: LocatedAtom[] = [];

  for (const [label, field, targetField] of [
    ["品牌", "brandName", "brandName"],
    ["产品", "product", "product"],
    ["项目", "projectName", "projectName"],
    ["内容", "description", "description"],
  ] as const) {
    addMatch(brief, matches, labeledFieldPattern(label), (match) => ({
      field,
      resolution: "mapped",
      disposition: "mapped",
      targetField,
      value: field === "description" && /图文为主/.test(brief) ? `图文为主；${match[1].trim()}` : match[1].trim(),
      confidence: 1,
      inferred: false,
    }));
  }

  addMatch(brief, matches, labeledFieldPattern("(?:发布|传播)?平台", "gi"), (match) => ({
    field: "platform",
    resolution: "mapped",
    disposition: "mapped",
    targetField: "platform",
    value: /抖音|\bdy\b|douyin/i.test(match[1]) ? "douyin" : "xiaohongshu",
    confidence: 1,
    inferred: false,
  }));

  addMatch(brief, matches, /(?:预计定号数|达人数量|数量|招募)[ \t]*[：:]?[ \t]*(\d+)[ \t]*(?:位|名|个)?(?:达人|博主)?/gi, (match) => {
    const quantity = Number(match[1]);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return undefined;
    return {
      field: "quantityTotal",
      resolution: "mapped",
      disposition: "mapped",
      targetField: "quantityTotal",
      value: quantity,
      confidence: 1,
      inferred: false,
    };
  });

  addMatch(brief, matches, /(?:返点(?:要求)?|返佣)\s*[：:]?\s*(?<lower>\d+(?:\.\d+)?)\s*%\s*(?:(?<upper>\d+(?:\.\d+)?)\s*%)?\s*(?<atLeast>\+|以上|及以上|起|至少|不低于)?/gi, (match) => {
    const lower = Number(match.groups?.lower) / 100;
    const upper = match.groups?.upper ? Number(match.groups.upper) / 100 : match.groups?.atLeast ? 1 : lower;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper > 1 || lower > upper) return undefined;
    return {
      field: "rebate",
      resolution: "mapped",
      disposition: "mapped",
      targetField: "rebate",
      value: JSON.stringify([lower, upper]),
      confidence: 1,
      inferred: false,
    };
  }, true);

  addMatch(brief, matches, /(?:单达人|达人)?[ \t]*(?:L[ \t]*[123][ \t]*)?(?:官方)?(?:价格|单价|预算|报价)[ \t]*[：:]?[ \t]*(?:L[ \t]*[123][ \t]*)?(?:单达人|达人)?[ \t]*(?:(?<lower>\d+(?:\.\d+)?)[ \t]*(?<lowerUnit>[kKwW万千]?)[ \t]*[-~～—至到][ \t]*(?<upper>\d+(?:\.\d+)?)[ \t]*(?<upperUnit>[kKwW万千]?)|(?<exact>\d+(?:\.\d+)?)[ \t]*(?<exactUnit>[kKwW万千]?))[ \t]*元?[ \t]*(?<upperOnly>以内|以下|封顶|之内)?/gi, (match) => {
    const range = priceRange(match);
    if (!range) return undefined;
    const targetField = priceTarget(match[0], brief);
    if (!targetField) {
      return {
        field: "creatorPriceTier",
        resolution: "semantic_ambiguity",
        value: range,
        candidates: ["kolOfficialPriceL1", "kolOfficialPriceL2", "kolOfficialPriceL3"],
        reason: "The single-creator price has no uniquely determined content tier.",
        confidence: 1,
        inferred: false,
      };
    }
    return {
      field: "creatorPriceTier",
      resolution: "mapped",
      disposition: "mapped",
      targetField,
      value: range,
      confidence: 1,
      inferred: false,
    };
  });

  addMatch(brief, matches, labeledFieldPattern("(?:账号类型|达人类型)"), (match) => ({
    field: "accountTaxonomy",
    resolution: "preserved",
    disposition: "preserved",
    preservedText: match[0],
    confidence: 1,
    inferred: false,
  }));

  addMatch(brief, matches, /意向档期\s*[：:]\s*(?=\n|$)/g, () => ({
    field: "submissionDeadlineAt",
    resolution: "missing_required",
    reason: "The supplied schedule field is explicitly blank.",
    confidence: 1,
    inferred: false,
  }));

  addMatch(brief, matches, /(?:今天|明天|后天)\s*(\d{1,2})(?::|点)(\d{1,2})?\s*(?:前|之前)?(?:提报|截止)?/g, (match) => {
    const relative = match[0].startsWith("后天") ? 2 : match[0].startsWith("明天") ? 1 : 0;
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (hour > 23 || minute > 59) return undefined;
    return {
      field: "submissionDeadlineAt",
      resolution: "mapped",
      disposition: "mapped",
      targetField: "submissionDeadlineAt",
      value: dateTimeForRelativeDay(now, timeZone, relative, hour, minute),
      confidence: 1,
      inferred: true,
    };
  });

  addMatch(brief, matches, /(?:DDL|截止(?:时间)?|提报(?:截止)?(?:时间)?)\s*[：:]?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(上午|早上|中午|下午|晚上)?\s*(\d{1,2})(?::|点)(\d{1,2})?\s*(?:前|之前)?/gi, (match) => {
    const hour = normalizedHour(Number(match[4]), match[3]);
    const minute = Number(match[5] ?? 0);
    if (hour === undefined || minute > 59) return undefined;
    const value = dateTimeForMonthDay(now, timeZone, Number(match[1]), Number(match[2]), hour, minute);
    if (!value) return undefined;
    return {
      field: "submissionDeadlineAt",
      resolution: "mapped",
      disposition: "mapped",
      targetField: "submissionDeadlineAt",
      value,
      confidence: 1,
      inferred: true,
    };
  });

  addMatch(brief, matches, /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(\d{1,2})(?::|点)(\d{1,2})?\s*(?:前|之前)?(?:提报|截止)?/g, (match) => {
    const [, year, month, day, hour, minute = "0"] = match;
    return {
      field: "submissionDeadlineAt",
      resolution: "mapped",
      disposition: "mapped",
      targetField: "submissionDeadlineAt",
      value: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`,
      confidence: 1,
      inferred: false,
    };
  });

  addMatch(brief, matches, /(?:DDL|截止(?:时间)?|提报(?:截止)?)\s*[：:]\s*(20\d{2})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(?:提交|提报|截止)?/gi, (match) => ({
    field: "submissionDeadlineAt",
    resolution: "mapped",
    disposition: "mapped",
    targetField: "submissionDeadlineAt",
    value: `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")} ${match[4].padStart(2, "0")}:${match[5].padStart(2, "0")}:${(match[6] ?? "0").padStart(2, "0")}`,
    confidence: 1,
    inferred: false,
  }));

  const schedulePattern = /档期\s*[：:]\s*(20\d{2})-(\d{1,2})-(\d{1,2})\s*(?:至|到|[-~～—])\s*(20\d{2})-(\d{1,2})-(\d{1,2})/g;
  const schedule = schedulePattern.exec(brief);
  if (schedule) {
    const start = schedule.index;
    const end = start + schedule[0].length;
    const base = { sourceText: schedule[0], resolution: "mapped" as const, disposition: "mapped" as const, confidence: 1, inferred: false, start, end };
    matches.push({
      ...base,
      field: "projectStartStart",
      targetField: "projectStartStart",
      value: `${schedule[1]}-${schedule[2].padStart(2, "0")}-${schedule[3].padStart(2, "0")} 00:00:00`,
    });
    matches.push({
      ...base,
      field: "projectStartEnd",
      targetField: "projectStartEnd",
      value: `${schedule[4]}-${schedule[5].padStart(2, "0")}-${schedule[6].padStart(2, "0")} 23:59:59`,
    });
  }

  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const occupied = matches.map(({ start, end }) => ({ start, end }));
  let cursor = 0;
  for (const interval of [...occupied, { start: brief.length, end: brief.length }]) {
    if (cursor < interval.start) {
      const gap = brief.slice(cursor, interval.start);
      const fragments = gap.split(/[\n，,；;]+/);
      let searchFrom = cursor;
      for (const fragment of fragments) {
        const sourceText = fragment.trim().replace(/^[：:\-。.!！？?]+|[：:\-。.!！？?]+$/g, "").trim();
        if (!sourceText) {
          searchFrom += fragment.length + 1;
          continue;
        }
        const start = brief.indexOf(sourceText, searchFrom);
        if (start >= 0 && !/^(?:发布|传播)?平台$/.test(sourceText)) {
          matches.push({
            sourceText,
            field: "rawMessagesJson",
            resolution: "preserved",
            disposition: "preserved",
            preservedText: sourceText,
            confidence: 1,
            inferred: false,
            start,
            end: start + sourceText.length,
          });
          searchFrom = start + sourceText.length;
        }
      }
    }
    cursor = Math.max(cursor, interval.end);
  }
  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const atoms: StandardBriefPreviewAtom[] = matches.map(({ start: _start, end: _end, ...atom }) => atom);
  const mappedFields = new Set(atoms.filter((atom) => atom.resolution === "mapped").map((atom) => atom.field));
  const ambiguityFields = new Set(atoms.filter((atom) => atom.resolution === "semantic_ambiguity").map((atom) => atom.field));

  for (const field of REQUIRED_FIELDS) {
    if (mappedFields.has(field) || ambiguityFields.has(field)) continue;
    atoms.push({
      field,
      resolution: "missing_required",
      reason: `Required field ${field} has no concrete candidate in the Brief.`,
      confidence: 1,
      inferred: false,
    });
  }

  const projection: Record<string, unknown> = {};
  for (const atom of atoms) {
    if (atom.resolution === "mapped" && atom.targetField) projection[atom.targetField] = atom.value;
  }
  const missingRequired = atoms.filter((atom) => atom.resolution === "missing_required").map((atom) => atom.field);
  const semanticAmbiguities = atoms.filter((atom) => atom.resolution === "semantic_ambiguity").map((atom) => atom.field);
  const mappedCount = atoms.filter((atom) => atom.resolution === "mapped").length;
  const preservedCount = atoms.filter((atom) => atom.resolution === "preserved").length;
  const unresolvedCount = atoms.length - mappedCount - preservedCount;

  return {
    schemaVersion: "ypmcn-requirement-preview-v1",
    authoritative: true,
    gate: missingRequired.length > 0 ? "missing_required" : semanticAmbiguities.length > 0 ? "semantic_ambiguity" : "ready",
    atoms,
    projection,
    missingRequired,
    semanticAmbiguities,
    summary: { atomCount: atoms.length, mappedCount, preservedCount, unresolvedCount },
  };
}

export function renderStandardBriefPreview(preview: StandardBriefPreview): string {
  return `YPmcn authoritative machine-readable requirement preview (do not recount, remap, or replace):\n${JSON.stringify(preview)}`;
}

export function buildStandardBriefReadyPayload(
  input: string,
  preview: StandardBriefPreview,
): Record<string, unknown> | undefined {
  if (preview.gate !== "ready" || preview.summary.unresolvedCount !== 0) return undefined;
  const atoms = preview.atoms.map((atom) => {
    if (!atom.sourceText || (atom.disposition !== "mapped" && atom.disposition !== "preserved")) return undefined;
    const base = {
      sourceText: atom.sourceText,
      disposition: atom.disposition,
      confidence: atom.confidence,
      inferred: atom.inferred,
    };
    if (atom.disposition === "mapped" && atom.targetField) return { ...base, targetField: atom.targetField };
    if (atom.disposition === "preserved" && atom.preservedText === atom.sourceText) {
      return { ...base, preservedText: atom.preservedText };
    }
    return undefined;
  });
  if (atoms.some((atom) => atom === undefined)) return undefined;
  return {
    ...preview.projection,
    rawMessagesJson: {
      schemaVersion: "ypmcn-brief-v1",
      originalBrief: extractStandardBrief(input),
      atoms,
      coverageCheck: { ...preview.summary },
    },
    status: "ready",
  };
}

export function renderStandardBriefReadyArguments(payload: Record<string, unknown>): string {
  return `YPmcn authoritative initial validate_requirement arguments (use this object exactly for the first call; after a deterministic argument rejection, preserve confirmed facts and follow the same-turn repair loop):\n${JSON.stringify({ payload })}`;
}

function ambiguityQuestion(field: string): string {
  if (field === "creatorPriceTier") {
    return "- 价格口径：4w以下是项目总预算，还是单达人官方报价？若为单达人报价，请确认 L1、L2 或 L3。";
  }
  if (field === "accountTaxonomy") {
    return "- 账号类型：母婴类、亲子相关是内容主题，还是平台达人 taxonomy？若为 taxonomy，请提供平台正式分类值。";
  }
  return `- ${field}：请确认唯一业务含义。`;
}

export function renderStandardBriefReply(preview: StandardBriefPreview): string {
  const confirmed = preview.atoms
    .filter((atom) => atom.resolution === "mapped" && atom.targetField)
    .map((atom) => `- ${atom.targetField}: ${JSON.stringify(atom.value)}`);
  const unresolved = [
    ...preview.missingRequired.map((field) => `- ${field}：请补充必填值。`),
    ...preview.semanticAmbiguities.map(ambiguityQuestion),
  ];
  return [
    "## 需求解析（权威结构化结果）",
    "```json",
    JSON.stringify(preview, null, 2),
    "```",
    "",
    "## 需求确认",
    "### 已确认",
    ...(confirmed.length > 0 ? confirmed : ["- 无"]),
    "### 需确认",
    ...(unresolved.length > 0 ? unresolved : ["- 无"]),
    "### 影响",
    preview.gate === "ready"
      ? "- 需求已满足校验条件；下一步首个业务 Tool 必须是 validate_requirement。"
      : `- 当前 gate=${preview.gate}；确认完成前不得调用任何 Tool。`,
  ].join("\n");
}
