//! Shared-checkout guard layered into the `git` builtin.
//!
//! Opt-in: active only when `PI_GIT_GUARD` is truthy in the session or process
//! environment (the coding agent sets it from its `bash.gitGuard` setting).
//!
//! Agents sharing one checkout lose work when one of them runs a git command
//! that discards uncommitted changes or moves HEAD. The guard judges every
//! `git` the shell dispatches — after expansion, in the directory it actually
//! runs in — and refuses:
//!
//! - `stash`, except the read-only `stash list` and `stash show` and `stash
//!   create`, which writes only an object;
//! - `reset --hard`, and `reset` to a commit other than HEAD's;
//! - `switch`, and `checkout` of a branch or commit;
//! - `checkout` of paths and working-tree `restore`, unless a merge, rebase,
//!   cherry-pick, or revert is underway, where they pick conflict sides — and
//!   even then not forced (`-f`, `--force`, `--discard-changes`) or over the
//!   whole tree (`.`, `:/`, `*`).
//!
//! Index-only commands always run: `reset [<path>…]` and `restore --staged`
//! only unstage. Git started by path (`/usr/bin/git`) or by another program
//! (`xargs git`, `sh -c`) never reaches the builtin and is not judged.

use std::path::{Path, PathBuf};

use omp_vcs::git::GitRepo;

use super::is_git_repo_location_var;

/// Exit status of a refused command; git's own for a refused operation.
pub const REFUSED_EXIT: u8 = 1;

/// A judged `git` invocation, detached from the shell so its repository reads
/// can run off the shell's thread.
pub struct Review(Judgment);

/// What the builtin does with a judged command.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
	/// Run git.
	Run,
	/// Print this message instead of running git.
	Refuse(String),
}

impl Review {
	/// Judges `args` (git's arguments, without `git`) as git would run them
	/// in `cwd` with the exported variables named by `exported`.
	pub fn of<'a>(cwd: &Path, mut exported: impl Iterator<Item = &'a str>, args: &[String]) -> Self {
		let Some(invocation) = Invocation::parse(args) else {
			return Self(Judgment::Allow);
		};
		let verdict = classify(invocation.sub, invocation.args);
		if verdict == Verdict::Allow {
			return Self(Judgment::Allow);
		}
		Self(Judgment::Check(invocation.sub, verdict, Site {
			dir:        invocation
				.dirs
				.iter()
				.fold(cwd.to_owned(), |dir, next| dir.join(next)),
			// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … retarget git as
			// `--git-dir` does.
			redirected: invocation.redirected || exported.any(is_git_repo_location_var),
		}))
	}

	/// Whether git runs after reading the repository state the verdict needs.
	/// Blocks on repository I/O: run it off the shell's thread.
	pub fn decide(self) -> Decision {
		let Judgment::Check(sub, verdict, site) = self.0 else {
			return Decision::Run;
		};
		if site.redirected {
			return Decision::Refuse(Refusal::Redirected(sub).message());
		}
		let repository = GitRepo::discover(&site.dir);
		in_shared(&repository, sub, verdict, &site.dir)
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message()))
	}
}

/// What the guard decided, or which repository read decides it.
enum Judgment {
	Allow,
	/// Decided by the checkout git runs in.
	Check(Sub, Verdict, Site),
}

/// Where git would run.
struct Site {
	/// The working directory with `-C` applied.
	dir:        PathBuf,
	/// Git is pointed at a repository other than the one found from `dir`.
	redirected: bool,
}

/// Why `verdict`, run in `dir`, is refused in a checkout other sessions may be
/// using, if it is.
fn in_shared<E>(
	repository: &Result<Option<GitRepo>, E>,
	sub: Sub,
	verdict: Verdict,
	dir: &Path,
) -> Option<Refusal> {
	let repo = repository.as_ref().ok().and_then(Option::as_ref);
	match verdict {
		Verdict::Allow => None,
		Verdict::Stash => Some(Refusal::Stash),
		Verdict::Destructive => Some(Refusal::Destructive(sub)),
		Verdict::BranchMove => Some(Refusal::BranchMove(sub)),
		Verdict::ResetTo(rev) => match repo {
			Some(repo) => moves_head(repo, &rev).then_some(Refusal::CommitMove),
			// Outside a repository git fails on its own.
			None => repository.is_err().then_some(Refusal::CommitMove),
		},
		Verdict::ConflictOnly => outside_conflict(repo, sub),
		Verdict::CheckoutOne(operand) => {
			if repo.is_some_and(|repo| !names_path(repo, dir, &operand)) {
				Some(Refusal::BranchMove(sub))
			} else {
				outside_conflict(repo, sub)
			}
		},
	}
}

/// Whether `reset` to `rev` moves HEAD in `repo`.
fn moves_head(repo: &GitRepo, rev: &str) -> bool {
	match (repo.resolve_ref(rev), repo.head_sha()) {
		// Not a revision: git reads it as a path and only rewrites the index.
		(Ok(None), _) => false,
		(Ok(Some(target)), Ok(head)) => head.as_deref() != Some(target.as_str()),
		_ => true,
	}
}

/// Why a working-tree rewrite in `repo` is refused, if it is: it runs only
/// mid-merge, -rebase, -cherry-pick, or -revert. Without a readable repository
/// it is not mid-operation.
fn outside_conflict(repo: Option<&GitRepo>, sub: Sub) -> Option<Refusal> {
	(!repo.is_some_and(|repo| repo.operation_in_progress().unwrap_or(false)))
		.then_some(Refusal::OutsideConflict(sub))
}

/// Whether `checkout <operand>`, run in `dir`, restores a path: the operand
/// names no revision, and it is a glob or a file that exists there. Git takes
/// any other name as a branch to create from a remote-tracking one, through
/// whatever fetch refspec maps it, or fails on its own; and `A...B`, `A...`,
/// or `...B` as their merge base, even beside a file of that name.
fn names_path(repo: &GitRepo, dir: &Path, operand: &str) -> bool {
	!operand.contains("...")
		&& matches!(repo.resolve_ref(operand), Ok(None))
		&& (operand.contains(['*', '?', '[', '\\']) || dir.join(operand).symlink_metadata().is_ok())
}

/// A git subcommand the guard judges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sub {
	Stash,
	Reset,
	Checkout,
	Switch,
	Restore,
}

impl Sub {
	fn parse(name: &str) -> Option<Self> {
		Some(match name {
			"stash" => Self::Stash,
			"reset" => Self::Reset,
			"checkout" => Self::Checkout,
			"switch" => Self::Switch,
			"restore" => Self::Restore,
			_ => return None,
		})
	}

	const fn name(self) -> &'static str {
		match self {
			Self::Stash => "stash",
			Self::Reset => "reset",
			Self::Checkout => "checkout",
			Self::Switch => "switch",
			Self::Restore => "restore",
		}
	}

	/// Short and long options whose value may be the next argument.
	const fn valued(self) -> (&'static [char], &'static [&'static str]) {
		match self {
			Self::Stash => (&[], &[]),
			Self::Reset => (&['U'], &["pathspec-from-file", "unified", "inter-hunk-context"]),
			Self::Checkout => (&['b', 'B', 'U'], &[
				"orphan",
				"conflict",
				"pathspec-from-file",
				"unified",
				"inter-hunk-context",
			]),
			Self::Switch => (&['c', 'C'], &["orphan", "conflict"]),
			Self::Restore => (&['s', 'U'], &[
				"source",
				"conflict",
				"pathspec-from-file",
				"unified",
				"inter-hunk-context",
			]),
		}
	}

	/// Long options git accepts, which it also accepts abbreviated.
	const fn long_options(self) -> &'static [&'static str] {
		match self {
			// Only the subcommand and its operands matter.
			Self::Stash => &[],
			Self::Reset => &[
				"auto-advance",
				"hard",
				"intent-to-add",
				"inter-hunk-context",
				"keep",
				"merge",
				"mixed",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"quiet",
				"recurse-submodules",
				"refresh",
				"soft",
				"unified",
			],
			Self::Checkout => &[
				"auto-advance",
				"conflict",
				"detach",
				"force",
				"guess",
				"ignore-other-worktrees",
				"ignore-skip-worktree-bits",
				"inter-hunk-context",
				"merge",
				"orphan",
				"ours",
				"overlay",
				"overwrite-ignore",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"progress",
				"quiet",
				"recurse-submodules",
				"theirs",
				"track",
				"unified",
			],
			Self::Switch => &[
				"conflict",
				"create",
				"detach",
				"discard-changes",
				"force",
				"force-create",
				"guess",
				"ignore-other-worktrees",
				"merge",
				"orphan",
				"overwrite-ignore",
				"progress",
				"quiet",
				"recurse-submodules",
				"track",
			],
			Self::Restore => &[
				"conflict",
				"ignore-skip-worktree-bits",
				"ignore-unmerged",
				"inter-hunk-context",
				"merge",
				"ours",
				"overlay",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"progress",
				"quiet",
				"recurse-submodules",
				"source",
				"staged",
				"theirs",
				"unified",
				"worktree",
			],
		}
	}
}

/// `git [<global options>] <sub> <args>…` with a guarded subcommand.
struct Invocation<'a> {
	/// `-C` directories, applied in order.
	dirs:       Vec<&'a str>,
	/// `--git-dir`/`--work-tree` point git at another repository.
	redirected: bool,
	sub:        Sub,
	args:       &'a [String],
}

impl<'a> Invocation<'a> {
	/// `None` when the subcommand is not guarded, or there is none.
	fn parse(args: &'a [String]) -> Option<Self> {
		let mut dirs = Vec::new();
		let mut redirected = false;
		let mut at = 0;
		while let Some(arg) = args.get(at) {
			at += 1;
			match arg.as_str() {
				"-C" => {
					dirs.push(args.get(at)?.as_str());
					at += 1;
				},
				"--git-dir" | "--work-tree" => {
					redirected = true;
					at += 1;
				},
				"-c" | "--config-env" | "--namespace" | "--super-prefix" | "--attr-source" => at += 1,
				arg if arg.starts_with("--git-dir=") || arg.starts_with("--work-tree=") => {
					redirected = true;
				},
				arg if arg.starts_with('-') => {},
				name => {
					return Some(Self { dirs, redirected, sub: Sub::parse(name)?, args: &args[at..] });
				},
			}
		}
		None
	}
}

/// One subcommand argument, read the way git's parse-options reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arg<'a> {
	/// `--name` or `--name=value`, by name; an abbreviation by the name it
	/// stands for.
	Long(&'a str),
	/// `--no-name`, by the name it negates.
	Negated(&'a str),
	/// One letter of a short-option bundle: `-qf` yields `q`, then `f`.
	Short(char),
	/// A non-option argument before `--`.
	Operand(&'a str),
	/// An argument after `--`.
	Pathspec(&'a str),
}

/// Splits `sub`'s arguments into options and operands, skipping option values
/// so they are never mistaken for operands.
fn scan(sub: Sub, args: &[String]) -> Vec<Arg<'_>> {
	let (short_valued, long_valued) = sub.valued();
	let mut scanned = Vec::new();
	let mut options = true;
	let mut args = args.iter();
	while let Some(arg) = args.next() {
		if arg == "--" {
			scanned.extend(args.by_ref().map(|arg| Arg::Pathspec(arg)));
			break;
		}
		if !options {
			scanned.push(Arg::Operand(arg));
		} else if arg == "--end-of-options" {
			options = false;
		} else if let Some(long) = arg.strip_prefix("--") {
			let (spelled, inline) = long
				.split_once('=')
				.map_or((long, false), |(name, _)| (name, true));
			match super::long_option(sub.long_options(), spelled) {
				Some((name, true)) => scanned.push(Arg::Negated(name)),
				Some((name, false)) => {
					if !inline && long_valued.contains(&name) {
						args.next();
					}
					scanned.push(Arg::Long(name));
				},
				// Unknown or ambiguous: git refuses it on its own.
				None => scanned.push(Arg::Long(spelled)),
			}
		} else if let Some(bundle) = arg.strip_prefix('-').filter(|bundle| !bundle.is_empty()) {
			for (at, flag) in bundle.char_indices() {
				scanned.push(Arg::Short(flag));
				if short_valued.contains(&flag) {
					// The value is the rest of the bundle, else the next argument.
					if at + flag.len_utf8() == bundle.len() {
						args.next();
					}
					break;
				}
			}
		} else {
			scanned.push(Arg::Operand(arg));
		}
	}
	scanned
}

/// What a guarded command would do, judged from its arguments alone.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
	Allow,
	Stash,
	/// Discards the working tree or index wholesale; refused even mid-conflict.
	Destructive,
	/// `reset` to this revision without a pathspec: moves HEAD unless it names
	/// HEAD's commit.
	ResetTo(String),
	/// Rewrites working-tree files; allowed only mid-conflict.
	ConflictOnly,
	/// Switches branches or moves one; refused even mid-conflict.
	BranchMove,
	/// `checkout` with one operand and no pathspec: git switches to it when it
	/// names a commit and restores it as a path otherwise.
	CheckoutOne(String),
}

fn classify(sub: Sub, args: &[String]) -> Verdict {
	match sub {
		Sub::Stash => match args.first().map(String::as_str) {
			Some("list" | "show" | "create") => Verdict::Allow,
			_ => Verdict::Stash,
		},
		Sub::Reset => classify_reset(&scan(sub, args)),
		Sub::Checkout | Sub::Switch | Sub::Restore => classify_tree_write(sub, &scan(sub, args)),
	}
}

/// `reset` moves HEAD only in its `reset [<mode>] <commit>` form: one revision
/// and no pathspec. With paths, a pathspec file, or `--patch` it rewrites index
/// entries only.
fn classify_reset(args: &[Arg<'_>]) -> Verdict {
	let flags = Flags::of(Sub::Reset, args);
	let mut operands = Vec::new();
	let mut pathspec = false;
	for arg in args {
		match *arg {
			Arg::Pathspec(_) => pathspec = true,
			Arg::Operand(operand) => operands.push(operand),
			Arg::Long(_) | Arg::Negated(_) | Arg::Short(_) => {},
		}
	}
	let index_only = pathspec || flags.any(&["patch", "pathspec-from-file"]);
	let mode = flags.last(&["hard", "soft", "mixed", "merge", "keep"]);
	match operands[..] {
		_ if mode == Some("hard") => Verdict::Destructive,
		[rev] if !index_only && !matches!(rev, "HEAD" | "@") => Verdict::ResetTo(rev.to_owned()),
		_ => Verdict::Allow,
	}
}

/// `checkout`, `switch`, and `restore` rewrite working-tree files or switch
/// branches — except `restore --staged` without `--worktree`, which only
/// unstages, and a bare `checkout`, which only reports.
fn classify_tree_write(sub: Sub, args: &[Arg<'_>]) -> Verdict {
	if sub == Sub::Checkout && args.is_empty() {
		return Verdict::Allow;
	}
	let flags = Flags::of(sub, args);
	let mut operands = Vec::new();
	let (mut new_branch, mut pathspec, mut whole_tree) = (false, false, false);
	for arg in args {
		match (sub, *arg) {
			(Sub::Checkout, Arg::Short('b' | 'B')) => new_branch = true,
			(Sub::Checkout, Arg::Operand(spec)) => {
				// `-` is the previous branch.
				new_branch |= spec == "-";
				whole_tree |= is_whole_tree(spec);
				operands.push(spec);
			},
			(Sub::Checkout | Sub::Restore, Arg::Pathspec(spec))
			| (Sub::Restore, Arg::Operand(spec)) => {
				whole_tree |= is_whole_tree(spec);
				pathspec = true;
			},
			_ => {},
		}
	}
	let forced = flags.on("force") || (sub == Sub::Switch && flags.on("discard-changes"));
	let branch = sub == Sub::Switch || new_branch || flags.any(&["orphan", "detach", "track"]);
	let paths = sub == Sub::Restore
		|| pathspec
		|| flags.any(&["ours", "theirs", "patch", "pathspec-from-file"]);
	if flags.on("staged") && !flags.on("worktree") {
		Verdict::Allow
	} else if forced || whole_tree {
		Verdict::Destructive
	} else if branch {
		Verdict::BranchMove
	} else if let [operand] = operands[..]
		&& !paths
	{
		Verdict::CheckoutOne(operand.to_owned())
	} else {
		Verdict::ConflictOnly
	}
}

/// A subcommand's flags as git reads them: of `--name`, `--no-name`, and the
/// short form, the last one given wins.
struct Flags<'a>(Vec<(&'a str, bool)>);

impl<'a> Flags<'a> {
	fn of(sub: Sub, args: &[Arg<'a>]) -> Self {
		Self(
			args
				.iter()
				.filter_map(|arg| match (sub, *arg) {
					(_, Arg::Long(name)) => Some((name, true)),
					(_, Arg::Negated(name)) => Some((name, false)),
					(Sub::Reset | Sub::Checkout | Sub::Restore, Arg::Short('p')) => {
						Some(("patch", true))
					},
					(Sub::Checkout | Sub::Switch, Arg::Short('f')) => Some(("force", true)),
					(Sub::Checkout, Arg::Short('2')) => Some(("ours", true)),
					(Sub::Checkout, Arg::Short('3')) => Some(("theirs", true)),
					(Sub::Checkout | Sub::Switch, Arg::Short('d')) => Some(("detach", true)),
					(Sub::Checkout | Sub::Switch, Arg::Short('t')) => Some(("track", true)),
					(Sub::Restore, Arg::Short('S')) => Some(("staged", true)),
					(Sub::Restore, Arg::Short('W')) => Some(("worktree", true)),
					_ => None,
				})
				.collect(),
		)
	}

	fn on(&self, name: &str) -> bool {
		self
			.0
			.iter()
			.rev()
			.find(|(flag, _)| *flag == name)
			.is_some_and(|&(_, on)| on)
	}

	fn any(&self, names: &[&str]) -> bool {
		names.iter().any(|name| self.on(name))
	}

	/// Which of `names`, mutually exclusive modes, was given last.
	fn last(&self, names: &[&str]) -> Option<&'a str> {
		self
			.0
			.iter()
			.rev()
			.find(|(flag, on)| *on && names.contains(flag))
			.map(|&(flag, _)| flag)
	}
}

/// Whether `spec` covers everything under the working directory or the
/// repository root: `.`, `*`, `:/`, or a path climbing out with `..`.
fn is_whole_tree(spec: &str) -> bool {
	let rest = spec
		.strip_prefix(":/")
		.or_else(|| spec.strip_prefix(":(top)"))
		.unwrap_or(spec);
	rest == "*" || rest.split('/').all(|part| matches!(part, "" | "." | ".."))
}

/// Why the guard refuses a command.
enum Refusal {
	Stash,
	Destructive(Sub),
	CommitMove,
	BranchMove(Sub),
	OutsideConflict(Sub),
	Redirected(Sub),
}

impl Refusal {
	fn message(&self) -> String {
		match self {
			Self::Stash => "git stash is blocked by workspace policy — do not work around it.\nThis \
			                is a SHARED workspace; stash mutates the tree/index other concurrent \
			                agents rely on, silently trashing their work. You cannot stash with \
			                unmerged paths anyway — resolve conflicts in place. Read-only `git stash \
			                list` and `git stash show` remain available, as does `git stash create`, \
			                which touches neither the tree nor the stash list.\n"
				.to_owned(),
			Self::Destructive(sub) => format!(
				"git {} is blocked: this form (--hard / --force / --discard-changes, or a whole-tree \
				 pathspec like `.`, `:/`, `*`) discards the working tree/index wholesale and would \
				 destroy other agents' uncommitted work — being mid-conflict does not make it \
				 safe.\nResolve conflicts with targeted forms instead: git checkout/restore \
				 --ours|--theirs <path>. Unstage with git reset <path> or git restore --staged \
				 <path>.\n",
				sub.name()
			),
			Self::CommitMove => "git reset to another commit is blocked: moving HEAD/the branch \
			                     (e.g. `HEAD~1`, a sha, or a branch name) rewrites history other \
			                     agents share.\nUnstaging is allowed — drop the commit argument: git \
			                     reset [-q] [--] <path> (or bare git reset to unstage everything), \
			                     or git restore --staged <path>.\n"
				.to_owned(),
			Self::BranchMove(sub) => format!(
				"git {} to another branch or commit is blocked by workspace policy — do not work \
				 around it.\nThis is a SHARED workspace; switching branches moves HEAD and the \
				 working tree under other concurrent agents. A merge or rebase in progress does not \
				 make it safe. While resolving conflicts, git checkout -- <path> and git restore \
				 <path> still run; put -- before a path that shares its name with a branch.\nInspect \
				 other revisions read-only with git show <rev>:<path> / git diff / git log.\n",
				sub.name()
			),
			Self::OutsideConflict(sub) => format!(
				"git {} is blocked by workspace policy — do not work around it.\nThis is a SHARED \
				 workspace; overwriting working-tree files discards uncommitted changes other \
				 concurrent agents rely on. It is exempt only while a merge/rebase conflict is being \
				 resolved, and the repository is not in one.\nUnstaging is always allowed: git reset \
				 [<path>] / git restore --staged <path>. To undo working-tree edits, edit forward; \
				 inspect history read-only with git diff/log/show.\n",
				sub.name()
			),
			Self::Redirected(sub) => format!(
				"git {} is blocked: the conflict exemption checks the repository found from the \
				 working directory, and this command points git elsewhere (--git-dir / --work-tree / \
				 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE), so that repository's state cannot be \
				 verified.\nRun it from inside the target checkout (cd or git -C) without overriding \
				 git's repository location.\n",
				sub.name()
			),
		}
	}
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::path::Path;

	use super::*;
	#[cfg(unix)]
	use crate::git::tests::{fixture, git, run_with};

	#[cfg(unix)]
	async fn guarded(repo: &Path, command: &str) -> (Option<i32>, String) {
		run_with(repo, command, &["PI_GIT_GUARD"]).await
	}

	/// The guard sees the command as the shell runs it, so an expanded
	/// subcommand is still a stash; listing stays available.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn stash_is_refused_however_it_is_spelled() {
		let (_temp, repo) = fixture();
		std::fs::write(repo.join("tracked.txt"), "mine\n").expect("edit");

		let (code, output) = guarded(&repo, "git stash list && s=stash && git $s").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "mine\n");
		assert_eq!(git(&repo, &["stash", "list"]), "");

		// `create` only writes the stash commit and prints its id.
		let (code, output) = guarded(&repo, "git stash create").await;
		assert_eq!(code, Some(0), "{output}");
		let id = output.trim();
		assert_eq!(git(&repo, &["cat-file", "-t", id]), "commit\n");
		assert_eq!(git(&repo, &["show", &format!("{id}:tracked.txt")]), "mine\n");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "mine\n");
		assert_eq!(git(&repo, &["stash", "list"]), "");

		// Off unless asked for, also beside the worktree layer.
		let (code, output) = run_with(&repo, "git stash -q", &["PI_SMART_GIT"]).await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "tracked\n");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn reset_unstages_but_never_discards_or_moves_head() {
		let (_temp, repo) = fixture();
		std::fs::write(repo.join("tracked.txt"), "mine\n").expect("edit");
		git(&repo, &["add", "tracked.txt"]);

		// `main` is HEAD's commit, so resetting to it only unstages.
		let (code, output) = guarded(&repo, "git reset -q main && git reset -q tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "");

		let (code, output) = guarded(&repo, "git reset --hard").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "mine\n");

		git(&repo, &["commit", "-qam", "second"]);
		let head = git(&repo, &["rev-parse", "HEAD"]);
		let (code, output) = guarded(&repo, "git reset --soft HEAD~1").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
	}

	/// Outside a conflict every working-tree rewrite is refused; while one is
	/// being resolved — conflicted or resolved but uncommitted — targeted
	/// forms run, while whole-tree, redirected, and branch-switching ones still
	/// do not.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn working_tree_rewrites_wait_for_a_conflict() {
		let (_temp, repo) = fixture();
		git(&repo, &["checkout", "-qb", "side"]);
		std::fs::write(repo.join("tracked.txt"), "theirs\n").expect("edit side");
		git(&repo, &["commit", "-qam", "side"]);
		git(&repo, &["checkout", "-q", "main"]);
		std::fs::write(repo.join("tracked.txt"), "ours\n").expect("edit main");
		git(&repo, &["commit", "-qam", "main"]);
		std::fs::write(repo.join("tracked.txt"), "uncommitted\n").expect("edit");

		for command in ["git checkout tracked.txt", "git restore tracked.txt"] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
		}
		let (code, output) = guarded(&repo, "git switch -q side").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "uncommitted\n");

		git(&repo, &["checkout", "-q", "--", "tracked.txt"]);
		let (code, output) = guarded(&repo, "git merge -q side").await;
		assert_eq!(code, Some(1), "the merge conflicts: {output}");

		let (code, output) = guarded(&repo, "git checkout --theirs .").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		let (code, output) = guarded(&repo, "git --git-dir=.git checkout --theirs tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");

		// A branch only a remote has is checked out as a new local branch.
		git(&repo, &["remote", "add", "origin", "../nowhere"]);
		git(&repo, &["update-ref", "refs/remotes/origin/remoteonly", "HEAD"]);
		let head = git(&repo, &["rev-parse", "HEAD"]);
		for command in [
			"git checkout -q side",
			"git checkout -q -B main HEAD~1",
			"git switch -q side",
			"git checkout -q remoteonly",
			"git checkout -q -d",
			"git checkout -q --det",
		] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
		}
		assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
		assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main\n");
		assert!(repo.join(".git/MERGE_HEAD").exists());

		let (code, output) =
			guarded(&repo, "cd .. && git -C repo checkout --theirs tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "theirs\n");

		// Resolved: no unmerged entries left, but MERGE_HEAD remains.
		git(&repo, &["add", "tracked.txt"]);
		std::fs::write(repo.join("tracked.txt"), "scratch\n").expect("edit");
		let (code, output) = guarded(&repo, "git restore tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "theirs\n");

		// Git switches for a merge base (even beside a file of that name), a
		// branch any fetch refspec maps, and a patch flag taken back; a file
		// sharing a remote branch's name is still a path.
		let fetch = "+refs/heads/*:refs/custom/origin/*";
		git(&repo, &["config", "--add", "remote.origin.fetch", fetch]);
		git(&repo, &["update-ref", "refs/custom/origin/custom", "HEAD"]);
		std::fs::write(repo.join("main...side"), "a file\n").expect("write main...side");
		for command in [
			"git checkout -q main...side",
			"git checkout -q main...",
			"git checkout -q custom",
			"git checkout -q -p --no-patch side",
		] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
		}
		assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
		assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main\n");
		assert!(repo.join(".git/MERGE_HEAD").exists());
		git(&repo, &["update-ref", "refs/remotes/origin/tracked.txt", "HEAD"]);
		std::fs::write(repo.join("tracked.txt"), "scratch\n").expect("edit");
		let (code, output) = guarded(&repo, "git checkout --no-guess tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "theirs\n");
	}

	/// git keeps `REBASE_HEAD` after a rebase that stopped on a conflict
	/// finishes; the rebase is over, so working-tree rewrites are refused again.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_finished_rebase_is_not_a_conflict() {
		let (_temp, repo) = fixture();
		git(&repo, &["checkout", "-qb", "side"]);
		std::fs::write(repo.join("tracked.txt"), "side\n").expect("edit side");
		git(&repo, &["commit", "-qam", "side"]);
		git(&repo, &["checkout", "-q", "main"]);
		std::fs::write(repo.join("tracked.txt"), "main\n").expect("edit main");
		git(&repo, &["commit", "-qam", "main"]);
		git(&repo, &["checkout", "-q", "side"]);
		let (code, output) = run_with(&repo, "git rebase -q main", &[]).await;
		assert_eq!(code, Some(1), "the rebase conflicts: {output}");
		std::fs::write(repo.join("tracked.txt"), "resolved\n").expect("resolve");
		git(&repo, &["add", "tracked.txt"]);
		let (code, output) = run_with(&repo, "GIT_EDITOR=true git rebase --continue", &[]).await;
		assert_eq!(code, Some(0), "{output}");
		assert!(repo.join(".git/REBASE_HEAD").exists());

		std::fs::write(repo.join("tracked.txt"), "uncommitted\n").expect("edit");
		let (code, output) = guarded(&repo, "git checkout tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "uncommitted\n");
	}

	#[cfg(unix)]
	fn read(checkout: &Path) -> String {
		std::fs::read_to_string(checkout.join("tracked.txt")).expect("read tracked")
	}

	#[cfg(unix)]
	fn strict_checkouts() -> (tempfile::TempDir, Vec<(&'static str, PathBuf)>) {
		let (temp, repo) = fixture();
		std::fs::write(repo.join("second.txt"), "second\n").expect("second file");
		git(&repo, &["add", "second.txt"]);
		git(&repo, &["commit", "-qm", "second"]);
		git(&repo, &["branch", "safety-other", "HEAD~1"]);
		let parent = repo.parent().expect("fixture parent");
		let linked = parent.join("linked");
		git(&repo, &["worktree", "add", "-q", "-b", "topic", &linked.to_string_lossy()]);
		let clone = parent.join("clone");
		git(parent, &["clone", "-q", &repo.to_string_lossy(), &clone.to_string_lossy()]);
		let mut cases = vec![("main", repo.clone()), ("linked", linked.clone()), ("clone", clone)];
		for (name, target) in [("bare.git", "bare-wt"), (".git", "dot-wt")] {
			let bare = parent.join(name);
			let worktree = parent.join(target);
			git(parent, &["clone", "-q", "--bare", &repo.to_string_lossy(), &bare.to_string_lossy()]);
			git(&bare, &["worktree", "add", "-q", &worktree.to_string_lossy(), "main"]);
			cases.push((target, worktree));
		}
		git(&linked, &[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			&repo.to_string_lossy(),
			"lib",
		]);
		git(&linked, &["commit", "-qm", "library"]);
		cases.push(("submodule", linked.join("lib")));
		for (_, checkout) in &cases {
			git(checkout, &["config", "user.name", "t"]);
			git(checkout, &["config", "user.email", "t@t"]);
			git(checkout, &["config", "commit.gpgSign", "false"]);
			git(checkout, &["config", "core.hooksPath", "/dev/null"]);
		}
		(temp, cases)
	}

	#[cfg(unix)]
	fn quote(value: &str) -> String {
		format!("'{}'", value.replace('\'', "'\\''"))
	}

	#[cfg(unix)]
	fn dispatch_gate(parent: &Path, other: Option<&Path>, command: &str) -> (String, PathBuf) {
		use std::os::unix::fs::PermissionsExt as _;

		let bin = parent.join("gate-bin");
		std::fs::create_dir_all(&bin).expect("gate bin");
		let wrapper = bin.join("git");
		std::fs::write(
			&wrapper,
			concat!(
				"#!/bin/sh\nset -eu\n: > \"$GUARD_MARKER\"\n",
				"if [ -n \"$GUARD_OTHER\" ]; then \"$GUARD_REAL_GIT\" -C \"$GUARD_OTHER\" stash push \
				 -q; fi\n",
				"exec \"$GUARD_REAL_GIT\" \"$@\"\n",
			),
		)
		.expect("gate wrapper");
		std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))
			.expect("chmod gate");
		let real = std::process::Command::new("/bin/sh")
			.args(["-c", "command -v git"])
			.output()
			.expect("find git");
		assert!(real.status.success(), "find git: {}", String::from_utf8_lossy(&real.stderr));
		let real = String::from_utf8(real.stdout).expect("git path");
		let marker = parent.join("guard-dispatched");
		let command = format!(
			"export GUARD_REAL_GIT={} GUARD_MARKER={} GUARD_OTHER={}; export PATH={}:\"$PATH\"; \
			 {command}",
			quote(real.trim()),
			quote(&marker.to_string_lossy()),
			quote(
				&other
					.map(|path| path.to_string_lossy().into_owned())
					.unwrap_or_default()
			),
			quote(&bin.to_string_lossy()),
		);
		(command, marker)
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn strict_policy_preserves_every_checkout_without_external_discard() {
		let (_temp, cases) = strict_checkouts();
		for (label, checkout) in cases {
			std::fs::write(checkout.join("tracked.txt"), "saved stash\n").expect("stash edit");
			git(&checkout, &["stash", "push", "-q"]);
			let oid = git(&checkout, &["rev-parse", "stash@{0}"]);
			std::fs::write(checkout.join("tracked.txt"), "staged\n").expect("staged edit");
			git(&checkout, &["add", "tracked.txt"]);
			std::fs::write(checkout.join("tracked.txt"), "unstaged\n").expect("working edit");
			for path in ["private file\n.txt", ":(literal)private"] {
				std::fs::write(checkout.join(path), "untracked private\n").expect("private file");
			}
			let head = git(&checkout, &["rev-parse", "HEAD"]);
			let branch = git(&checkout, &["symbolic-ref", "HEAD"]);
			let index = git(&checkout, &["ls-files", "--stage"]);
			let stashes = git(&checkout, &["stash", "list", "--format=%H"]);
			let parent = checkout.parent().expect("checkout parent");
			let (control, marker) = dispatch_gate(parent, None, "git show HEAD:tracked.txt");
			let (code, output) = guarded(&checkout, &control).await;
			assert_eq!(code, Some(0), "{label}: {output}");
			assert_eq!(output, "tracked\n", "{label}");
			assert!(marker.exists(), "{label}: allowed inspection must reach real Git");
			std::fs::remove_file(&marker).expect("remove control marker");
			for command in [
				"git reset --hard".to_owned(),
				"git reset --ha".to_owned(),
				"git reset --hard --recurse-submodules".to_owned(),
				"git -C . reset --hard".to_owned(),
				"cd . && git reset --hard".to_owned(),
				"git --git-dir=.git reset --hard".to_owned(),
				"git reset --soft HEAD~1".to_owned(),
				"git switch safety-other".to_owned(),
				"git checkout -q safety-other".to_owned(),
				"git checkout -f -- tracked.txt".to_owned(),
				"git restore tracked.txt".to_owned(),
				"git checkout --theirs .".to_owned(),
				"s=stash; git $s".to_owned(),
				"git stash pop".to_owned(),
				"git stash drop".to_owned(),
				"git stash clear".to_owned(),
				"git stash apply".to_owned(),
				"git stash branch attempted".to_owned(),
				format!("git stash apply {}", oid.trim()),
			] {
				let (guarded_command, marker) = dispatch_gate(parent, None, &command);
				let (code, output) = guarded(&checkout, &guarded_command).await;
				assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{label}: {command}: {output}");
				assert!(!marker.exists(), "{label}: {command}: external Git must not run");
				assert_eq!(read(&checkout), "unstaged\n", "{label}: {command}");
				assert_eq!(git(&checkout, &["ls-files", "--stage"]), index, "{label}: {command}");
				assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head, "{label}: {command}");
				assert_eq!(git(&checkout, &["symbolic-ref", "HEAD"]), branch, "{label}: {command}");
				assert_eq!(
					git(&checkout, &["stash", "list", "--format=%H"]),
					stashes,
					"{label}: {command}"
				);
				for path in ["private file\n.txt", ":(literal)private"] {
					assert_eq!(
						std::fs::read_to_string(checkout.join(path)).expect("private file"),
						"untracked private\n",
						"{label}: {command}: {path:?}",
					);
				}
				assert_eq!(git(&checkout, &["for-each-ref", "refs/omp/discarded"]), "");
			}
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn strict_guard_never_dispatches_untracked_or_ignored_obstruction_reset() {
		for (path, ignored) in [("x", false), ("cache/nested/x", true)] {
			let (_temp, repo) = fixture();
			std::fs::create_dir_all(repo.join(path).parent().expect("path parent")).expect("parents");
			std::fs::write(repo.join(path), "commit A\n").expect("A");
			git(&repo, &["add", "-f", "--", path]);
			git(&repo, &["commit", "-qm", "A"]);
			let a = git(&repo, &["rev-parse", "HEAD"]);
			git(&repo, &["rm", "-q", "--", path]);
			git(&repo, &["commit", "-qm", "B"]);
			let parent = repo.parent().expect("fixture parent");
			let worktree = parent.join("wt");
			git(&repo, &["worktree", "add", "-q", "-b", "topic", &worktree.to_string_lossy()]);
			std::fs::create_dir_all(worktree.join(path).parent().expect("path parent"))
				.expect("parents");
			std::fs::write(worktree.join(path), "synthetic private payload\n").expect("private file");
			let listing = if ignored {
				git(&worktree, &["ls-files", "--others", "--ignored", "--exclude-standard"])
			} else {
				git(&worktree, &["ls-files", "--others", "--exclude-standard"])
			};
			assert_eq!(listing, format!("{path}\n"));
			let head = git(&worktree, &["rev-parse", "HEAD"]);
			let index = git(&worktree, &["ls-files", "--stage"]);
			let (command, marker) =
				dispatch_gate(parent, None, &format!("git reset --hard {}", a.trim()));
			let (code, output) = guarded(&worktree, &command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{path}: {output}");
			assert!(!marker.exists(), "{path}: reset must not reach external Git");
			assert_eq!(
				std::fs::read_to_string(worktree.join(path)).expect("private file"),
				"synthetic private payload\n",
			);
			assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), head);
			assert_eq!(git(&worktree, &["ls-files", "--stage"]), index);
			assert_eq!(git(&worktree, &["for-each-ref", "refs/omp/discarded"]), "");
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn strict_stash_refusal_prevents_the_shared_reflog_dispatch_race() {
		for op in ["pop", "drop", "clear", "apply", "branch recovered"] {
			let (_temp, repo) = fixture();
			let parent = repo.parent().expect("fixture parent");
			let (a, b) = (parent.join("a"), parent.join("b"));
			for (branch, path) in [("a", &a), ("b", &b)] {
				git(&repo, &["worktree", "add", "-q", "-b", branch, &path.to_string_lossy()]);
			}
			std::fs::write(a.join("tracked.txt"), "A stash\n").expect("A edit");
			git(&a, &["stash", "push", "-q"]);
			let entries = git(&a, &["stash", "list", "--format=%H"]);
			let a_head = git(&a, &["rev-parse", "HEAD"]);
			let a_index = git(&a, &["ls-files", "--stage"]);
			std::fs::write(b.join("tracked.txt"), "B pending stash\n").expect("B edit");
			let b_head = git(&b, &["rev-parse", "HEAD"]);
			let b_index = git(&b, &["ls-files", "--stage"]);
			let (command, marker) = dispatch_gate(parent, Some(&b), &format!("git stash {op}"));
			let (code, output) = guarded(&a, &command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{op}: {output}");
			assert!(!marker.exists(), "{op}: B push and A mutation must remain undispatched");
			assert_eq!(read(&a), "tracked\n");
			assert_eq!(read(&b), "B pending stash\n");
			assert_eq!(git(&a, &["stash", "list", "--format=%H"]), entries);
			assert_eq!(git(&a, &["rev-parse", "HEAD"]), a_head);
			assert_eq!(git(&a, &["ls-files", "--stage"]), a_index);
			assert_eq!(git(&b, &["rev-parse", "HEAD"]), b_head);
			assert_eq!(git(&b, &["ls-files", "--stage"]), b_index);
			assert_eq!(git(&a, &["branch", "--list", "recovered"]), "");
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn safe_inspection_object_creation_and_unstaging_remain_supported() {
		let (_temp, cases) = strict_checkouts();
		for (label, checkout) in cases {
			std::fs::write(checkout.join("tracked.txt"), "staged\n").expect("staged edit");
			git(&checkout, &["add", "tracked.txt"]);
			std::fs::write(checkout.join("tracked.txt"), "unstaged\n").expect("working edit");
			let head = git(&checkout, &["rev-parse", "HEAD"]);
			let index = git(&checkout, &["ls-files", "--stage"]);
			let stashes = git(&checkout, &["stash", "list", "--format=%H"]);
			let (code, output) = guarded(&checkout, "git stash create").await;
			assert_eq!(code, Some(0), "{label}: {output}");
			let oid = output.trim();
			assert_eq!(git(&checkout, &["cat-file", "-t", oid]), "commit\n");
			assert_eq!(git(&checkout, &["show", &format!("{oid}:tracked.txt")]), "unstaged\n");
			assert_eq!(git(&checkout, &["show", &format!("{oid}^2:tracked.txt")]), "staged\n");
			assert_eq!(git(&checkout, &["ls-files", "--stage"]), index);
			let (code, output) = guarded(&checkout, &format!("git show {oid}:tracked.txt")).await;
			assert_eq!(code, Some(0), "{label}: {output}");
			assert_eq!(output, "unstaged\n", "{label}");
			let (code, output) =
				guarded(&checkout, &format!("git stash show -p --no-color {oid}")).await;
			assert_eq!(code, Some(0), "{label}: {output}");
			assert!(output.contains("+unstaged\n"), "{label}: {output}");
			let (code, output) = guarded(&checkout, "git stash list --format=%H").await;
			assert_eq!(code, Some(0), "{label}: {output}");
			assert_eq!(output, stashes, "{label}");
			for command in ["git reset -- tracked.txt", "git restore --staged -- tracked.txt"] {
				git(&checkout, &["add", "tracked.txt"]);
				assert_eq!(git(&checkout, &["show", ":tracked.txt"]), "unstaged\n");
				let (code, output) = guarded(&checkout, command).await;
				assert_eq!(code, Some(0), "{label}: {command}: {output}");
				assert_eq!(git(&checkout, &["show", ":tracked.txt"]), "tracked\n");
				assert_eq!(read(&checkout), "unstaged\n");
				assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head);
				assert_eq!(git(&checkout, &["stash", "list", "--format=%H"]), stashes);
			}
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn targeted_conflict_resolution_remains_available_in_linked_and_nested_checkouts() {
		let (_temp, cases) = strict_checkouts();
		for (label, checkout) in cases.into_iter().filter(|(label, _)| *label != "main") {
			let original = format!("resolution-{label}");
			let side = format!("conflict-{label}");
			git(&checkout, &["checkout", "-qb", &original]);
			git(&checkout, &["checkout", "-qb", &side]);
			std::fs::write(checkout.join("tracked.txt"), "theirs\n").expect("side edit");
			git(&checkout, &["commit", "-qam", "theirs"]);
			git(&checkout, &["checkout", "-q", &original]);
			std::fs::write(checkout.join("tracked.txt"), "ours\n").expect("main edit");
			git(&checkout, &["commit", "-qam", "ours"]);
			let head = git(&checkout, &["rev-parse", "HEAD"]);
			let (code, output) = run_with(&checkout, &format!("git merge -q {side}"), &[]).await;
			assert_eq!(code, Some(1), "{label}: {output}");
			assert_eq!(git(&checkout, &["show", ":2:tracked.txt"]), "ours\n");
			assert_eq!(git(&checkout, &["show", ":3:tracked.txt"]), "theirs\n");
			let merge_head = git(&checkout, &["rev-parse", "MERGE_HEAD"]);
			for command in ["git checkout --theirs .", "git checkout -f -- tracked.txt"] {
				let (command, marker) =
					dispatch_gate(checkout.parent().expect("checkout parent"), None, command);
				let (code, output) = guarded(&checkout, &command).await;
				assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{label}: {output}");
				assert!(!marker.exists(), "{label}: broad or forced conflict write must not run");
			}
			let (code, output) = guarded(&checkout, "git checkout --theirs -- tracked.txt").await;
			assert_eq!(code, Some(0), "{label}: {output}");
			assert_eq!(read(&checkout), "theirs\n");
			assert_eq!(git(&checkout, &["show", ":2:tracked.txt"]), "ours\n");
			assert_eq!(git(&checkout, &["show", ":3:tracked.txt"]), "theirs\n");
			git(&checkout, &["add", "tracked.txt"]);
			std::fs::write(checkout.join("tracked.txt"), "scratch\n").expect("scratch edit");
			let (code, output) = guarded(&checkout, "git restore -- tracked.txt").await;
			assert_eq!(code, Some(0), "{label}: {output}");
			assert_eq!(read(&checkout), "theirs\n");
			assert_eq!(git(&checkout, &["show", ":tracked.txt"]), "theirs\n");
			assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), head);
			assert_eq!(git(&checkout, &["rev-parse", "MERGE_HEAD"]), merge_head);
		}
	}
}
