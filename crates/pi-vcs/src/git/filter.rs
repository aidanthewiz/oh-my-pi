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
			// gix-filter 0.32 checks a single-file child's exit only when required.
			driver.required = true;
		}
		Ok(Self {
			repo,
			pipeline,
			attributes,
			optional_drivers,
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
		let converted = match self.clean(path, &bytes) {
			Err(ConversionError::OptionalDriver(_)) => {
				let drivers = std::mem::take(&mut self.pipeline.options_mut().drivers);
				let retry = self.clean(path, &bytes);
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
		let converted = match self.smudge(path, &bytes) {
			Err(ConversionError::OptionalDriver(_)) => {
				let drivers = std::mem::take(&mut self.pipeline.options_mut().drivers);
				let retry = self.smudge(path, &bytes);
				self.pipeline.options_mut().drivers = drivers;
				retry
			},
			result => result,
		};
		Ok(converted
			.map_err(ConversionError::into_error)?
			.unwrap_or(bytes))
	}

	fn clean(
		&mut self,
		path: &str,
		bytes: &[u8],
	) -> std::result::Result<Option<Vec<u8>>, ConversionError> {
		let repo = self.repo;
		let entry = self
			.attributes
			.at_path(Path::new(path), None, &repo.objects)
			.map_err(|err| ConversionError::Other(Error::backend(self.op, err)))?;
		let mut optional = false;
		let outcome = self
			.pipeline
			.convert_to_git(
				bytes,
				Path::new(path),
				&mut |_, attrs| {
					entry.matching_attributes(attrs);
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
	) -> std::result::Result<Option<Vec<u8>>, ConversionError> {
		let entry = self
			.attributes
			.at_entry(path.as_bytes().as_bstr(), None, &self.repo.objects)
			.map_err(|err| ConversionError::Other(Error::backend(self.op, err)))?;
		let mut optional = false;
		let outcome = self
			.pipeline
			.convert_to_worktree(
				bytes,
				path.as_bytes().as_bstr(),
				&mut |_, attrs| {
					entry.matching_attributes(attrs);
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
			ToWorktreeOutcome::Unchanged(_) => Ok(None),
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
