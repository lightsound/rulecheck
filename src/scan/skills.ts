import { Effect, type FileSystem, type Path } from "effect";
import {
  checkSkillFrontmatter,
  computeSkillHash,
  parseSkillsLock,
  reconcileSkills,
  SKILL_AGENT_DIRS,
  SKILL_HASH_IGNORED_DIRECTORIES,
  type SkillFileContent,
} from "../domain/skills.ts";
import type { InstalledSkill, SkillIssue, SkillsInventory } from "../domain/types.ts";
import { isGitignored, loadGitignore } from "./verify.ts";
import type { DiscoveredRepo, DiscoveredSkill } from "./walk.ts";

/**
 * Hash every skill directory, check its SKILL.md frontmatter, and relate it to `skills-lock.json`.
 *
 * `npx skills` installs into `.agents/skills/<name>` and symlinks `.claude/skills/<name>` and the
 * like to it, so directories that resolve to the same real path are one skill with links.
 */
export const inventorySkills = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repo: DiscoveredRepo,
): Effect.Effect<SkillsInventory> =>
  Effect.gen(function* () {
    const skills: Omit<InstalledSkill, "lockState">[] = [];
    const issues: SkillIssue[] = [];

    for (const discovered of yield* dedupeLinks(fs, repo.skills)) {
      const files = yield* collectFiles(fs, path, discovered.path, discovered.path);
      const skillMd = files.find((f) => f.relativePath === "SKILL.md");
      const content = skillMd ? new TextDecoder().decode(skillMd.content) : "";
      const check = checkSkillFrontmatter(content, discovered.name);
      for (const error of check.errors) {
        issues.push({
          kind: "invalid-frontmatter",
          file: `${discovered.relativePath}/SKILL.md`,
          line: 1,
          skill: discovered.name,
          message: error,
        });
      }
      skills.push({
        name: discovered.name,
        agentDir: discovered.agentDir,
        relativePath: discovered.relativePath,
        frontmatterName: check.name,
        hash: computeSkillHash(files),
        files: files.length,
        links: discovered.links,
      });
    }

    const lockText =
      repo.skillsLockPath === null
        ? null
        : yield* fs
            .readFileString(repo.skillsLockPath)
            .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<string | null>(null)));
    const lock = lockText === null ? null : parseSkillsLock(lockText);

    const inventory = reconcileSkills(skills, lock, issues);
    if (inventory.issues.every((issue) => issue.kind !== "missing")) return inventory;

    // Teams that gitignore their skill directories restore them from the lock on install, so a
    // fresh checkout legitimately lacks them.
    const gitignore = yield* loadGitignore(fs, path, repo.root);
    return {
      ...inventory,
      issues: inventory.issues.filter(
        (issue) =>
          issue.kind !== "missing" ||
          !isGitignored(
            gitignore,
            path,
            repo.root,
            SKILL_AGENT_DIRS.map((dir) => path.join(repo.root, dir, "skills", issue.skill)),
          ),
      ),
    };
  });

/**
 * Group skill directories by real path. The directory that is not a symlink is kept (falling back
 * to the first seen); the others become its `links`.
 */
const dedupeLinks = (
  fs: FileSystem.FileSystem,
  skills: ReadonlyArray<DiscoveredSkill>,
): Effect.Effect<Array<DiscoveredSkill & { links: string[] }>> =>
  Effect.gen(function* () {
    const groups = new Map<string, { primary: DiscoveredSkill; links: string[] }>();
    for (const skill of skills) {
      const real = yield* fs
        .realPath(skill.path)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(skill.path)));
      const group = groups.get(real);
      if (!group) {
        groups.set(real, { primary: skill, links: [] });
        continue;
      }
      if (group.primary.path !== real && skill.path === real) {
        group.links.push(group.primary.relativePath);
        group.primary = skill;
      } else {
        group.links.push(skill.relativePath);
      }
    }
    return [...groups.values()]
      .map(({ primary, links }) => ({ ...primary, links: links.sort() }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  });

const collectFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  base: string,
  dir: string,
): Effect.Effect<SkillFileContent[]> =>
  Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));
    const files: SkillFileContent[] = [];
    for (const name of entries) {
      const full = path.join(dir, name);
      const info = yield* fs.stat(full).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") {
        if (SKILL_HASH_IGNORED_DIRECTORIES.has(name)) continue;
        files.push(...(yield* collectFiles(fs, path, base, full)));
        continue;
      }
      if (info.value.type !== "File") continue;
      const content = yield* fs
        .readFile(full)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(new Uint8Array())));
      files.push({
        relativePath: path.relative(base, full).split(path.sep).join("/"),
        content,
      });
    }
    return files;
  });
