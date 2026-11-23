//! Conversion between worktree bytes and their stored blob form.
//!
//! Git never compares or patches raw worktree bytes against objects: content
//! passes through the clean/smudge pipeline (`core.autocrlf`, `eol`/`text`
//! attributes, `ident`, filter drivers) first. Skipping it makes every CRLF
//! checkout under `core.autocrlf=true` — the Git for Windows default — read as
//! modified and makes LF patches fail to apply.

use std::{
	collections::{BTreeMap, BTreeSet},
	io::Read,
	path::Path,
};

use gix::{
	bstr::{BString, ByteSlice},
	filter::plumbing::{
		driver::apply::Delay,
		pipeline::convert::{ToGitOutcome, ToWorktreeOutcome, to_git, to_worktree},
	},
	objs::Find,
};

use super::open::load_index_or_empty;
use crate::error::{Error, Result};

enum ConversionError {
	OptionalDriver(Error),
	Other(Error),
}

impl ConversionError {
	fn into_error(self) -> Error {
		match self {
			Self::OptionalDriver(err) | Self::Other(err) => err,
		}
	}
}

pub(crate) struct WorktreeFilter<'repo> {
	repo:             &'repo gix::Repository,
	pipeline:         gix::filter::plumbing::Pipeline,
	attributes:       gix::worktree::Stack,
	optional_drivers: BTreeMap<BString, bool>,
	encoding_attrs:   gix::attrs::search::Outcome,
	/// Index consulted by the safer-autocrlf rule: a path whose index blob
	/// already contains CR keeps its CRLFs (`git add` semantics). An empty
	/// index renormalizes unconditionally (`git apply` semantics).
	index:            gix::index::State,
	/// Paths read verbatim, as `git apply` does (`CONV_EOL_KEEP_CRLF`) when a
	/// patch's preimage itself carries CRLF line endings.
	verbatim:         BTreeSet<String>,
	op:               &'static str,
}

impl<'repo> WorktreeFilter<'repo> {
	/// Filter with `git add` semantics against `index`.
	pub(crate) fn new(
		repo: &'repo gix::Repository,
		op: &'static str,
		index: gix::index::State,
	) -> Result<Self> {
		let (pipeline, _) = repo
			.filter_pipeline(None)
			.map_err(|err| Error::backend(op, err))?;
		let (mut pipeline, attributes) = pipeline.into_parts();
		let mut optional_drivers = BTreeMap::new();
		for driver in &mut pipeline.options_mut().drivers {
			if !optional_drivers.contains_key(driver.name.as_bstr()) {
				optional_drivers.insert(driver.name.clone(), !driver.required);
			}
			// gix-filter 0.32 checks a single-file child's exit only when
			// required.
			driver.required = true;
		}
		let mut encoding_attrs = gix::attrs::search::Outcome::default();
		encoding_attrs.initialize_with_selection(&Default::default(), [
			"crlf",
			"ident",
			"filter",
			"eol",
			"text",
			"working-tree-encoding",
		]);
		Ok(Self {
			repo,
			pipeline,
			attributes,
			optional_drivers,
			encoding_attrs,
			index,
			verbatim: BTreeSet::new(),
			op,
		})
	}

	/// Filter with `git add` semantics against the index on disk.
	pub(crate) fn staging(repo: &'repo gix::Repository, op: &'static str) -> Result<Self> {
		let (index, _) = load_index_or_empty(repo, op)?.into_parts();
		Self::new(repo, op, index)
	}

	pub(crate) fn for_tree(
		repo: &'repo gix::Repository,
		op: &'static str,
		tree: gix::hash::ObjectId,
	) -> Result<Self> {
		let (index, _) = repo
			.index_from_tree(&tree)
			.map_err(|err| Error::backend(op, err))?
			.into_parts();
		let mut filter = Self::new(repo, op, index)?;
		filter.attributes = repo
			.attributes_only(&filter.index, gix::worktree::stack::state::attributes::Source::IdMapping)
			.map_err(|err| Error::backend(op, err))?
			.detach();
		Ok(filter)
	}

	/// Filter with `git apply` semantics: line endings are renormalized
	/// regardless of what the index holds.
	pub(crate) fn renormalizing(repo: &'repo gix::Repository, op: &'static str) -> Result<Self> {
		Self::new(repo, op, gix::index::State::new(repo.object_hash()))
	}

	/// Read `paths` without clean conversion.
	pub(crate) fn keep_verbatim(&mut self, paths: BTreeSet<String>) {
		self.verbatim = paths;
	}

	pub(crate) fn worktree_file_to_object(
		&mut self,
		path: &str,
	) -> Result<Option<(gix::hash::ObjectId, gix::objs::tree::EntryKind)>> {
		use gix::objs::tree::EntryKind;
		let repo = self.repo;
		let full_path = repo
			.workdir()
			.ok_or_else(|| Error::backend(self.op, "missing worktree"))?
			.join(path);
		let metadata = match std::fs::symlink_metadata(&full_path) {
			Ok(metadata) => metadata,
			Err(err) if gix::fs::io_err::is_not_found(err.kind(), err.raw_os_error()) => {
				return Ok(None);
			},
			Err(err) => return Err(err.into()),
		};
		let (id, kind) = if metadata.is_symlink() {
			let target = std::fs::read_link(&full_path)?;
			(
				repo
					.write_blob(gix::path::into_bstr(target).as_ref())
					.map_err(|err| Error::backend(self.op, err))?
					.detach(),
				EntryKind::Link,
			)
		} else if metadata.is_file() {
			let bytes = self.worktree_to_git(path, std::fs::read(&full_path)?)?;
			let id = repo
				.write_blob(&bytes)
				.map_err(|err| Error::backend(self.op, err))?
				.detach();
			(
				id,
				if gix::fs::is_executable(&metadata) {
					EntryKind::BlobExecutable
				} else {
					EntryKind::Blob
				},
			)
		} else if metadata.is_dir() {
			let Ok(submodule) = gix::open_opts(&full_path, repo.open_options().clone()) else {
				return Ok(None);
			};
			let Ok(id) = submodule.head_id() else {
				return Ok(None);
			};
			(id.detach(), EntryKind::Commit)
		} else {
			return Ok(None);
		};
		Ok(Some((id, kind)))
	}

	/// Convert worktree `bytes` found at repo-relative `path` to blob content.
	pub(crate) fn worktree_to_git(&mut self, path: &str, bytes: Vec<u8>) -> Result<Vec<u8>> {
		if self.verbatim.contains(path) {
			return Ok(bytes);
		}
		if let Some((encoding, driver)) = self.utf16_configuration(path)? {
			let bytes = self.apply_encoding_driver(
				path,
				bytes,
				driver,
				gix::filter::plumbing::driver::Operation::Clean,
			)?;
			let decoded = encoding
				.decode(&bytes)
				.map_err(|err| Error::backend(self.op, err))?;
			return Ok(self
				.clean(path, &decoded, true)
				.map_err(ConversionError::into_error)?
				.unwrap_or(decoded));
		}
		let converted = match self.clean(path, &bytes, false) {
			Err(ConversionError::OptionalDriver(_)) => {
				let drivers = std::mem::take(&mut self.pipeline.options_mut().drivers);
				let retry = self.clean(path, &bytes, false);
				self.pipeline.options_mut().drivers = drivers;
				retry
			},
			result => result,
		};
		Ok(converted
			.map_err(ConversionError::into_error)?
			.unwrap_or(bytes))
	}

	/// Convert blob `bytes` destined for repo-relative `path` to worktree
	/// content.
	pub(crate) fn git_to_worktree(&mut self, path: &str, bytes: Vec<u8>) -> Result<Vec<u8>> {
		if let Some((encoding, driver)) = self.utf16_configuration(path)? {
			let bytes = self
				.smudge(path, &bytes, true)
				.map_err(ConversionError::into_error)?
				.unwrap_or(bytes);
			let encoded = encoding
				.encode(&bytes)
				.map_err(|err| Error::backend(self.op, err))?;
			return self.apply_encoding_driver(
				path,
				encoded,
				driver,
				gix::filter::plumbing::driver::Operation::Smudge,
			);
		}
		let converted = match self.smudge(path, &bytes, false) {
			Err(ConversionError::OptionalDriver(_)) => {
				let drivers = std::mem::take(&mut self.pipeline.options_mut().drivers);
				let retry = self.smudge(path, &bytes, false);
				self.pipeline.options_mut().drivers = drivers;
				retry
			},
			result => result,
		};
		Ok(converted
			.map_err(ConversionError::into_error)?
			.unwrap_or(bytes))
	}

	fn utf16_configuration(&mut self, path: &str) -> Result<Option<(Utf16, Option<usize>)>> {
		let entry = self
			.attributes
			.at_entry(path.as_bytes().as_bstr(), None, &self.repo.objects)
			.map_err(|err| Error::backend(self.op, err))?;
		entry.matching_attributes(&mut self.encoding_attrs);
		let encoding = match self
			.encoding_attrs
			.iter_selected()
			.find(|attr| attr.assignment.name.as_str() == "working-tree-encoding")
			.expect("encoding selection")
			.assignment
			.state
		{
			gix::attrs::StateRef::Value(name) => Utf16::for_label(name.as_bstr()),
			_ => None,
		};
		let Some(encoding) = encoding else {
			return Ok(None);
		};
		let driver = match self
			.encoding_attrs
			.iter_selected()
			.find(|attr| attr.assignment.name.as_str() == "filter")
			.expect("driver selection")
			.assignment
			.state
		{
			gix::attrs::StateRef::Value(name) => self
				.pipeline
				.options_mut()
				.drivers
				.iter()
				.position(|driver| driver.name == name.as_bstr()),
			_ => None,
		};
		Ok(Some((encoding, driver)))
	}

	fn apply_encoding_driver(
		&mut self,
		path: &str,
		bytes: Vec<u8>,
		driver: Option<usize>,
		operation: gix::filter::plumbing::driver::Operation,
	) -> Result<Vec<u8>> {
		let Some(driver) = driver else {
			return Ok(bytes);
		};
		let drivers = std::mem::take(&mut self.pipeline.options_mut().drivers);
		let driver = &drivers[driver];
		let optional = self.optional_drivers.get(driver.name.as_bstr()) == Some(&true);
		let (ref_name, treeish, blob) = {
			let context = self.pipeline.driver_context_mut();
			(context.ref_name.take(), context.treeish, context.blob)
		};
		let context = gix::filter::plumbing::driver::apply::Context {
			rela_path: path.as_bytes().as_bstr(),
			ref_name: ref_name.as_ref().map(|name| name.as_bstr()),
			treeish,
			blob,
		};
		let converted = (|| {
			let mut input = bytes.as_slice();
			let output = self
				.pipeline
				.driver_state_mut()
				.apply(driver, &mut input, operation, context)
				.map_err(|err| Error::backend(self.op, err))?;
			match output {
				Some(mut output) => {
					let mut out = Vec::new();
					output
						.read_to_end(&mut out)
						.map_err(|err| Error::backend(self.op, err))?;
					Ok(Some(out))
				},
				None => Ok(None),
			}
		})();
		self.pipeline.options_mut().drivers = drivers;
		self.pipeline.driver_context_mut().ref_name = ref_name;
		match converted {
			Ok(Some(out)) => Ok(out),
			Ok(None) => Ok(bytes),
			Err(_) if optional => Ok(bytes),
			Err(err) => Err(err),
		}
	}

	fn clean(
		&mut self,
		path: &str,
		bytes: &[u8],
		utf16: bool,
	) -> std::result::Result<Option<Vec<u8>>, ConversionError> {
		let repo = self.repo;
		let mut optional = false;
		let outcome = self
			.pipeline
			.convert_to_git(
				bytes,
				Path::new(path),
				&mut |_, attrs| {
					select_pipeline_attributes(attrs, utf16, false);
					self
						.encoding_attrs
						.copy_into(self.attributes.attributes_collection(), attrs);
					optional = attrs.iter_selected().any(|attr| {
						attr.assignment.name.as_str() == "filter"
							&& matches!(attr.assignment.state, gix::attrs::StateRef::Value(name)
							if self.optional_drivers.get(name.as_bstr()) == Some(&true))
					});
				},
				&mut |buf| {
					let Some(entry) = self.index.entry_by_path(path.as_bytes().as_bstr()) else {
						return Ok(None);
					};
					let object = repo.objects.try_find(&entry.id, buf)?;
					Ok(object
						.filter(|object| object.kind == gix::objs::Kind::Blob)
						.map(|_| ()))
				},
			)
			.map_err(|err| {
				let driver_failed = matches!(
					err,
					to_git::Error::Driver(_) | to_git::Error::ReadProcessOutputToBuffer(_)
				);
				let err = Error::backend(self.op, err);
				if optional && driver_failed {
					ConversionError::OptionalDriver(err)
				} else {
					ConversionError::Other(err)
				}
			})?;
		match outcome {
			ToGitOutcome::Unchanged(_) => Ok(None),
			ToGitOutcome::Buffer(buf) => Ok(Some(buf.to_vec())),
			ToGitOutcome::Process(mut read) => {
				let mut out = Vec::new();
				read.read_to_end(&mut out).map_err(|err| {
					let err = Error::backend(self.op, err);
					if optional {
						ConversionError::OptionalDriver(err)
					} else {
						ConversionError::Other(err)
					}
				})?;
				Ok(Some(out))
			},
		}
	}

	fn smudge(
		&mut self,
		path: &str,
		bytes: &[u8],
		utf16: bool,
	) -> std::result::Result<Option<Vec<u8>>, ConversionError> {
		let ident = self
			.encoding_attrs
			.iter_selected()
			.any(|attr| attr.assignment.name.as_str() == "ident" && attr.assignment.state.is_set());
		let expanded = if ident {
			expand_ident(bytes, self.repo.object_hash())
				.map_err(|err| ConversionError::Other(Error::backend(self.op, err)))?
		} else {
			None
		};
		let mut optional = false;
		let outcome = self
			.pipeline
			.convert_to_worktree(
				expanded.as_deref().unwrap_or(bytes),
				path.as_bytes().as_bstr(),
				&mut |_, attrs| {
					select_pipeline_attributes(attrs, utf16, true);
					self
						.encoding_attrs
						.copy_into(self.attributes.attributes_collection(), attrs);
					optional = attrs.iter_selected().any(|attr| {
						attr.assignment.name.as_str() == "filter"
							&& matches!(attr.assignment.state, gix::attrs::StateRef::Value(name)
							if self.optional_drivers.get(name.as_bstr()) == Some(&true))
					});
				},
				Delay::Forbid,
			)
			.map_err(|err| {
				let driver_failed = matches!(err, to_worktree::Error::Driver(_));
				let err = Error::backend(self.op, err);
				if optional && driver_failed {
					ConversionError::OptionalDriver(err)
				} else {
					ConversionError::Other(err)
				}
			})?;
		match outcome {
			ToWorktreeOutcome::Unchanged(_) => Ok(expanded),
			ToWorktreeOutcome::Buffer(buf) => Ok(Some(buf.to_vec())),
			mut outcome @ ToWorktreeOutcome::Process(_) => {
				let mut out = Vec::new();
				outcome.read_to_end(&mut out).map_err(|err| {
					let err = Error::backend(self.op, err);
					if optional {
						ConversionError::OptionalDriver(err)
					} else {
						ConversionError::Other(err)
					}
				})?;
				Ok(Some(out))
			},
		}
	}
}

fn select_pipeline_attributes(attrs: &mut gix::attrs::search::Outcome, utf16: bool, smudge: bool) {
	// gix-filter resolves these six attributes by position.
	attrs.initialize_with_selection(&Default::default(), [
		"crlf",
		if smudge { "" } else { "ident" },
		if utf16 { "" } else { "filter" },
		"eol",
		"text",
		if utf16 { "" } else { "working-tree-encoding" },
	]);
}

fn expand_ident(
	bytes: &[u8],
	hash: gix::hash::Kind,
) -> std::result::Result<Option<Vec<u8>>, gix::hash::hasher::Error> {
	let mut cursor = 0;
	let mut copied = 0;
	let mut output: Option<(Vec<u8>, gix::hash::ObjectId)> = None;
	while let Some(offset) = bytes[cursor..].find_byte(b'$') {
		let start = cursor + offset;
		cursor = start + 1;
		let end = if bytes[start..].starts_with(b"$Id$") {
			start + 4
		} else if bytes[start..].starts_with(b"$Id:") {
			let Some(end) = bytes[start + 4..]
				.find_byte(b'$')
				.map(|offset| start + 4 + offset)
			else {
				break;
			};
			let content = &bytes[start + 4..end];
			if content.contains(&b'\n')
				|| content.len() > 2 && content[1..content.len() - 1].contains(&b' ')
			{
				continue;
			}
			end + 1
		} else {
			continue;
		};
		if output.is_none() {
			let id = gix::objs::compute_hash(hash, gix::objs::Kind::Blob, bytes)?;
			output = Some((Vec::with_capacity(bytes.len() + hash.len_in_hex() + 3), id));
		}
		let (out, id) = output.as_mut().expect("initialized");
		out.extend_from_slice(&bytes[copied..start]);
		out.extend_from_slice(b"$Id: ");
		id.write_hex_to(&mut *out).expect("writing to memory");
		out.extend_from_slice(b" $");
		copied = end;
		cursor = end;
	}
	Ok(output.map(|(mut out, _)| {
		out.extend_from_slice(&bytes[copied..]);
		out
	}))
}

#[derive(Clone, Copy)]
enum Utf16 {
	Bom,
	Le,
	Be,
	LeBom,
}

impl Utf16 {
	const fn for_label(label: &[u8]) -> Option<Self> {
		if label.eq_ignore_ascii_case(b"UTF-16") {
			Some(Self::Bom)
		} else if label.eq_ignore_ascii_case(b"UTF-16LE") {
			Some(Self::Le)
		} else if label.eq_ignore_ascii_case(b"UTF-16BE") {
			Some(Self::Be)
		} else if label.eq_ignore_ascii_case(b"UTF-16LE-BOM") {
			Some(Self::LeBom)
		} else {
			None
		}
	}

	const fn default_le() -> bool {
		// Apple's iconv emits big-endian UTF-16; GNU iconv uses native order.
		cfg!(not(target_os = "macos")) && cfg!(target_endian = "little")
	}

	fn decode(self, bytes: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
		if bytes.is_empty() {
			return Ok(Vec::new());
		}
		let bom = if bytes.starts_with(b"\xff\xfe") {
			Some(true)
		} else if bytes.starts_with(b"\xfe\xff") {
			Some(false)
		} else {
			None
		};
		let (le, bytes) = match self {
			Self::Bom => (bom.ok_or("UTF-16 requires a byte order mark")?, &bytes[2..]),
			Self::Le | Self::Be if bom.is_some() => {
				return Err("UTF-16LE/BE prohibits a byte order mark");
			},
			Self::Le => (true, bytes),
			Self::Be => (false, bytes),
			Self::LeBom => {
				(bom.unwrap_or_else(Self::default_le), if bom.is_some() { &bytes[2..] } else { bytes })
			},
		};
		if bytes.len() % 2 != 0 {
			return Err("UTF-16 contains an incomplete code unit");
		}
		let units = bytes.as_chunks::<2>().0.iter().map(|unit| {
			if le {
				u16::from_le_bytes(*unit)
			} else {
				u16::from_be_bytes(*unit)
			}
		});
		let mut out = String::with_capacity(bytes.len() / 2 * 3);
		for character in char::decode_utf16(units) {
			out.push(character.map_err(|_| "UTF-16 contains an unpaired surrogate")?);
		}
		Ok(out.into_bytes())
	}

	fn encode(self, bytes: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
		let text = std::str::from_utf8(bytes).map_err(|_| "blob is not valid UTF-8")?;
		if text.is_empty() {
			return Ok(Vec::new());
		}
		let le =
			matches!(self, Self::Le | Self::LeBom) || matches!(self, Self::Bom) && Self::default_le();
		let mut out = Vec::with_capacity(text.len() * 2 + 2);
		match self {
			Self::Bom => out.extend_from_slice(if le { b"\xff\xfe" } else { b"\xfe\xff" }),
			Self::LeBom => out.extend_from_slice(b"\xff\xfe"),
			_ => {},
		}
		for unit in text.encode_utf16() {
			out.extend_from_slice(&if le {
				unit.to_le_bytes()
			} else {
				unit.to_be_bytes()
			});
		}
		Ok(out)
	}
}

impl super::GitRepo {
	/// Convert worktree `data` found at each repo-relative path to the blob
	/// `git add` would store: `.gitattributes` `text`/`eol`, `core.autocrlf`
	/// (a path whose index blob holds CR keeps its CRLFs), `ident`, and clean
	/// filter drivers such as Git LFS. A reftable repository cannot be opened
	/// in-process and returns `data` unchanged.
	pub fn worktree_to_git(&self, entries: Vec<(String, Vec<u8>)>) -> Result<Vec<Vec<u8>>> {
		if self.is_reftable() {
			return Ok(entries.into_iter().map(|(_, data)| data).collect());
		}
		let repo = self.gix()?;
		let mut filter = WorktreeFilter::staging(&repo, "git add")?;
		entries
			.into_iter()
			.map(|(path, data)| filter.worktree_to_git(&path, data))
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, process::Command};

	use crate::git::GitRepo;

	fn git(dir: &std::path::Path, args: &[&str]) {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	}

	#[test]
	fn worktree_to_git_applies_autocrlf_and_eol_attributes() {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "core.autocrlf", "true"]);
		fs::write(temp.path().join(".gitattributes"), "*.bin -text\n*.cmd text eol=crlf\n").unwrap();
		let repo = GitRepo::require(temp.path()).unwrap();

		let converted = repo
			.worktree_to_git(vec![
				("a.txt".into(), b"one\r\ntwo\r\n".to_vec()),
				("run.cmd".into(), b"echo\r\n".to_vec()),
				("raw.bin".into(), b"keep\r\n".to_vec()),
			])
			.unwrap();
		assert_eq!(converted, vec![b"one\ntwo\n".to_vec(), b"echo\n".to_vec(), b"keep\r\n".to_vec()]);
	}
}
