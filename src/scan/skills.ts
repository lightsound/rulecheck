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

    // Skill directories are read with bounded parallelism: on a remote snapshot every file is a
    // network call, and a repository with dozens of installed skills (or one skill with a
    // hundred reference files) would otherwise spend a quarter of a minute reading them one by
    // one. Order is preserved, so the inventory is the same as a sequential read.
    const inventoried = yield* Effect.forEach(
      yield* dedupeLinks(fs, repo.skills),
      (discovered) =>
        Effect.gen(function* () {
          const files = yield* collectFiles(fs, path, discovered.path, discovered.path);
          const skillMd = files.find((f) => f.relativePath === "SKILL.md");
          const content = skillMd ? new TextDecoder().decode(skillMd.content) : "";
          const check = checkSkillFrontmatter(content, discovered.name);
          const skillIssues: SkillIssue[] = check.errors.map((error) => ({
            kind: "invalid-frontmatter",
            file: `${discovered.relativePath}/SKILL.md`,
            line: 1,
            skill: discovered.name,
            message: error,
          }));
          const skill: Omit<InstalledSkill, "lockState"> = {
            name: discovered.name,
            agentDir: discovered.agentDir,
            relativePath: discovered.relativePath,
            frontmatterName: check.name,
            hash: computeSkillHash(files),
            files: files.length,
            links: discovered.links,
          };
          return { skill, skillIssues };
        }),
      { concurrency: SKILL_READ_CONCURRENCY },
    );
    for (const { skill, skillIssues } of inventoried) {
      skills.push(skill);
      issues.push(...skillIssues);
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

/** Skills inventoried at once, and files read at once inside a skill. */
const SKILL_READ_CONCURRENCY = 8;

const collectFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  base: string,
  dir: string,
): Effect.Effect<SkillFileContent[]> =>
  Effect.gen(function* () {
    const paths = yield* listFiles(fs, path, dir);
    return yield* Effect.forEach(
      paths,
      (full) =>
        fs
          .readFile(full)
          .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(new Uint8Array())))
          .pipe(
            Effect.map((content) => ({
              relativePath: path.relative(base, full).split(path.sep).join("/"),
              content,
            })),
          ),
      { concurrency: SKILL_READ_CONCURRENCY },
    );
  });

/** Every file below `dir`, depth first, in directory-listing order; hash-ignored directories skipped. */
const listFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([])));
    const files: string[] = [];
    for (const name of entries) {
      const full = path.join(dir, name);
      const info = yield* fs.stat(full).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") {
        if (SKILL_HASH_IGNORED_DIRECTORIES.has(name)) continue;
        files.push(...(yield* listFiles(fs, path, full)));
        continue;
      }
      if (info.value.type === "File") files.push(full);
    }
    return files;
  });
