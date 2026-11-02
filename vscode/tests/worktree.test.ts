import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { test } from "node:test";
import { resolveGit, Worktrees } from "../src/worktree.ts";

const gitExecutable = resolveGit("git");
const quote = (path: string) => "'" + path.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";

test("resolves a bare git command from absolute PATH entries only", () => {
  assert.equal(resolveGit(gitExecutable), gitExecutable);
  assert.equal(
    resolveGit(
      "git",
      `relative/bin${delimiter}${dirname(gitExecutable)}`,
    ),
    gitExecutable,
  );
  assert.throws(() => resolveGit("git", "relative/bin"), /Cannot find git/);
});

test("creates an isolated checkout without hooks, filters, inherited git environment or dirty files", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "superagent-worktree-")));
  const source = join(dir, "repo"),
    storage = join(dir, "work");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync(gitExecutable, args, { cwd: source, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(source, "file"), "committed\n");
    await writeFile(join(source, ".gitattributes"), "file filter=unsafe\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    git(
      "config",
      "filter.unsafe.smudge",
      `touch ${quote(join(dir, "smudge-executed"))}`,
    );
    git("config", "filter.unsafe.required", "true");
    const included = join(dir, "included.gitconfig");
    await writeFile(
      included,
      `[filter "unsafe"]\n\tsmudge = touch ${quote(join(dir, "included-filter-executed"))}\n\trequired = true\n`,
    );
    git("config", "--unset-all", "filter.unsafe.smudge");
    git("config", "--unset-all", "filter.unsafe.required");
    git("config", "include.path", included);
    await writeFile(
      join(source, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ntouch ${quote(join(dir, "hook-executed"))}\n`,
      { mode: 0o755 },
    );
    await writeFile(join(source, "file"), "dirty user work\n");
    const trees = new Worktrees(gitExecutable, source, storage);
    const checkout = await trees.prepare("ticket-1");
    assert.equal(await readFile(join(checkout, "file"), "utf8"), "committed\n");
    assert.equal(
      await readFile(join(source, "file"), "utf8"),
      "dirty user work\n",
    );
    await assert.rejects(readFile(join(dir, "smudge-executed")));
    await assert.rejects(readFile(join(dir, "hook-executed")));
    await assert.rejects(readFile(join(dir, "included-filter-executed")));
    assert.equal(await trees.prepare("ticket-1"), checkout);
    await assert.rejects(trees.prepare("../../escape"));
    assert.equal(await trees.ticketAt(checkout), "ticket-1");
    execFileSync(gitExecutable, ["switch", "--detach"], { cwd: checkout });
    await assert.rejects(trees.ticketAt(checkout), /branch|detached/i);
    execFileSync(
      gitExecutable,
      ["symbolic-ref", "HEAD", "refs/heads/superagent/ticket-1"],
      { cwd: checkout },
    );
    assert.equal(await trees.ticketAt(source), undefined);
    await rm(join(storage, ".ticket-1.ready"));
    await assert.rejects(trees.prepare("ticket-1"), /incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
