/** Agent Skills (SKILL.md folders) — M8. */

export interface SkillFileDTO {
  path: string;
  size: number;
  mime: string;
}

export type SkillSource = "upload" | "editor" | "github" | "model";

export interface SkillDTO {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceUrl: string | null;
  enabled: boolean;
  files: SkillFileDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetailDTO extends SkillDTO {
  /** Full SKILL.md text (front matter included). */
  skillMd: string;
  /** Parsed front matter (name, description, license, metadata …). */
  frontmatter: Record<string, unknown>;
}

export interface SkillImportResult {
  imported: SkillDTO[];
  skipped: { name: string; reason: string }[];
}

/** Agent Skills naming rule: lowercase letters, digits and single hyphens, 1–64 chars. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
export const SKILL_DESCRIPTION_MAX = 1024;

export const SKILL_TEMPLATE = `---
name: my-skill
description: 說明這個 Skill 做什麼、什麼時候該用它（模型依這段描述決定是否載入）。
---

# My Skill

## 何時使用
- …

## 步驟
1. …
`;
