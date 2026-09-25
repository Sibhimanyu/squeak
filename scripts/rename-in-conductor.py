#!/usr/bin/env python3
"""
Rename this repository inside Conductor, with Conductor QUIT.

    scripts/rename-in-conductor.py [new-name]          # default: squeak

Conductor has no rename: its settings say to remove and re-add a repository,
which would take its workspaces and their chats with it. This does the rename
in place instead, keeping every chat:

  1. repos.name, so the sidebar and new workspaces use the new name;
  2. each workspace's folder, moved from workspaces/<old>/<dir> to
     workspaces/<new>/<dir>, and its workspace_path;
  3. Claude Code's transcript folders (~/.claude/projects/<path-as-name>),
     which are keyed by folder path — without this, no existing chat in a
     moved workspace could be resumed;
  4. git's links between the checkout and every worktree.

The repository is found by its root path (the checkout this script lives in),
so the old name never has to be typed. A backup of conductor.db is taken
first; everything else is a rename that can be reversed.

Chat history that mentions the old name is left exactly as it was written.
"""

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()


def claude_project_dir(root: Path, folder: str) -> Path:
    # Claude Code names a project's transcript folder after its path, with
    # "/" and "." as "-".
    return root / folder.replace("/", "-").replace(".", "-")


def main() -> int:
    # The main checkout, even when run from a worktree: git lists it first.
    listing = subprocess.run(
        ["git", "-C", str(Path(__file__).resolve().parent), "worktree", "list", "--porcelain"],
        capture_output=True, text=True,
    ).stdout
    here = next((line[len("worktree "):] for line in listing.splitlines() if line.startswith("worktree ")), "")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("new_name", nargs="?", default="squeak")
    parser.add_argument("--db", default=str(HOME / "Library/Application Support/com.conductor.app/conductor.db"))
    parser.add_argument("--checkout", default=str(here))
    parser.add_argument("--claude-projects", default=str(HOME / ".claude/projects"))
    parser.add_argument("--allow-running", action="store_true", help="tests only")
    parser.add_argument("--no-git", action="store_true", help="tests only")
    args = parser.parse_args()

    if not args.allow_running:
        running = subprocess.run(["pgrep", "-f", "/Applications/Conductor.app/Contents/MacOS/"], capture_output=True)
        if running.returncode == 0:
            print("Quit Conductor first (⌘Q), then run this again. It rewrites Conductor's own records.")
            return 1

    db_path = Path(args.db)
    backup = db_path.with_name(f"{db_path.name}.before-rename-{time.strftime('%Y%m%d-%H%M%S')}")
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(backup)
    src.backup(dst)
    dst.close()
    print(f"backup: {backup}")

    db = src
    db.row_factory = sqlite3.Row
    checkout = str(Path(args.checkout).resolve())
    repo = db.execute("select id, name from repos where root_path = ?", (checkout,)).fetchone()
    if repo is None:
        print(f"No Conductor repository has root path {checkout}. Run scripts/move-checkout.sh first.")
        return 1
    old_name, new_name = repo["name"], args.new_name
    if old_name == new_name:
        print(f"Already named {new_name}.")
        return 0
    print(f"renaming Conductor's repository to {new_name}")

    claude_root = Path(args.claude_projects)
    moved_worktrees = []

    def move_claude_project(old_folder: str, new_folder: str) -> None:
        old_dir, new_dir = claude_project_dir(claude_root, old_folder), claude_project_dir(claude_root, new_folder)
        if old_dir.is_dir() and not new_dir.exists():
            old_dir.rename(new_dir)
            print(f"  transcripts: {old_dir.name} -> {new_dir.name}")

    for workspace in db.execute(
        "select id, directory_name, workspace_path from workspaces where repository_id = ?", (repo["id"],)
    ).fetchall():
        old_path = workspace["workspace_path"]
        if not old_path:
            continue
        old = Path(old_path)
        if old.parent.name != old_name:
            continue  # not in the name-derived location; leave it alone
        new = old.parent.parent / new_name / old.name
        if old.is_dir():
            if new.exists():
                print(f"  {new} already exists; leaving {old} where it is")
                continue
            new.parent.mkdir(parents=True, exist_ok=True)
            old.rename(new)
            moved_worktrees.append(str(new))
            print(f"  workspace: {old} -> {new}")
        db.execute("update workspaces set workspace_path = ? where id = ?", (str(new), workspace["id"]))
        move_claude_project(str(old), str(new))

    # Sessions once run in the checkout itself, before it moved.
    move_claude_project(str(Path(checkout).parent / old_name), checkout)

    db.execute("update repos set name = ? where id = ?", (new_name, repo["id"]))
    db.commit()
    db.close()

    for leftover in {Path(p).parent.parent / old_name for p in moved_worktrees}:
        try:
            leftover.rmdir()
            print(f"  removed empty {leftover}")
        except OSError:
            pass

    if moved_worktrees and not args.no_git:
        subprocess.run(["git", "-C", checkout, "worktree", "repair", *moved_worktrees], check=False)

    print("done. Open Conductor: the repository, its workspaces and every chat carry the new name.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
