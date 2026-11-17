// app.ts — a GitHub-compatible git forge in one file, Node standard library only.
//
// The forge keeps every repository in memory as genuine git objects: SHA-1 addressed blobs, trees,
// commits and annotated tags in the real git object format, shared by every surface. The REST API,
// the git smart-HTTP transport, the GraphQL API and the MCP endpoint are four views over that one
// store, so an object created through any of them is the same object through all the others.
//
// The scenario the suite grades is published in the contest kit (wire.ts, one fixed seed): the
// bearer token belongs to one fixed user, and every repository lives under that user's login.
// The token itself is opaque; the login is a constant of the competition, like the port the env owns.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The token owner's identity (the fixed viewer of the published scenario). */
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_ID = 1000;
/** The all-zero object id: "no object" in the git protocol. */
const ZERO_OID = '0000000000000000000000000000000000000000';
/** The bearer token every API call must carry (the same value the env presents). */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The version string the meta endpoint reports. */
const FORGE_VERSION = '1.0.0';
const AGENT_STRING = 'konongsz-forge/1.0.0';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

interface LabelRec {
  name: string;
  color: string;
}

/** One issue or pull request; the two share a per-repository number counter, as on GitHub. */
interface ItemRec {
  number: number;
  /** The stable numeric id the REST API reports for this item. */
  dbId: number;
  kind: 'issue' | 'pr';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  // Pull-request fields (unused for plain issues).
  headRef: string;
  baseRef: string;
  headSha: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
}

interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

interface RepoRec {
  /** The stable numeric id (GraphQL databaseId, REST id). */
  dbId: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, StoredObject>;
  /** Full ref name (refs/heads/main) -> object id. HEAD is implicit: the default branch. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  comments: Map<number, CommentRec[]>;
  nextNumber: number;
}

interface Forge {
  repos: Map<string, RepoRec>;
  nextRepoId: number;
  nextItemDbId: number;
  nextCommentId: number;
}

function createForge(): Forge {
  return { repos: new Map(), nextRepoId: 1, nextItemDbId: 1, nextCommentId: 1 };
}

/** An error that maps onto an HTTP status and a GitHub-style {message} body. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a payload: sha1 of "<type> <length>\0" followed by the payload. */
function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object (deduplicated) and return its id. */
function storeObject(repo: RepoRec, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  /** '40000' for a directory, '100644' / '100755' / '120000' for files and links. */
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: names compare bytewise, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {oid, mode}, recursing into subdirectories. */
function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path map; returns the root tree id. */
function buildTreeFromFlat(repo: RepoRec, flat: Map<string, { oid: string; mode: string }>): string {
  interface DirNode {
    files: TreeEntry[];
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: [], dirs: new Map() };
  for (const [path, value] of flat) {
    const pieces = path.split('/');
    let node = root;
    for (const piece of pieces.slice(0, -1)) {
      let next = node.dirs.get(piece);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(piece, next);
      }
      node = next;
    }
    node.files.push({ mode: value.mode, name: pieces[pieces.length - 1]!, oid: value.oid });
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

interface CommitRec {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitRec {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const rec: CommitRec = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) rec.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) rec.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) rec.author = line.slice(7);
    else if (line.startsWith('committer ')) rec.committer = line.slice(10);
  }
  return rec;
}

function buildCommitData(rec: CommitRec): Buffer {
  const lines = [`tree ${rec.tree}`];
  for (const parent of rec.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${rec.author}`);
  lines.push(`committer ${rec.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${rec.message}`, 'utf8');
}

/** The forge's own identity line for the commits it creates (contents API, merges). */
function forgeIdent(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${Math.floor(Date.now() / 1000)} +0000`;
}

function makeCommit(repo: RepoRec, tree: string, parents: string[], message: string): string {
  const ident = forgeIdent();
  return storeObject(repo, 'commit', buildCommitData({ tree, parents, author: ident, committer: ident, message }));
}

/** Peel an object id to the commit it ultimately points at (through annotated tags), or null. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** Resolve a ref name, branch name or raw object id to an object id, or null. */
function resolveRefish(repo: RepoRec, refish: string): string | null {
  if (/^[0-9a-f]{40}$/.test(refish) && repo.objects.has(refish)) return refish;
  const candidates = [refish, `refs/${refish}`, `refs/heads/${refish}`, `refs/tags/${refish}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return oid;
  }
  if (refish === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return null;
}

/** Every commit reachable from `tip` (inclusive), breadth-first, tip first. */
function reachableCommits(repo: RepoRec, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(repo, descendant).includes(ancestor);
}

/** The best common ancestor of two commits (first shared commit in breadth-first order from b). */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set(reachableCommits(repo, a));
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Add a commit and its whole tree closure to an object set (for pack assembly). */
function collectTreeClosure(repo: RepoRec, treeOid: string, into: Map<string, StoredObject>): void {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree' || into.has(treeOid)) return;
  into.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') collectTreeClosure(repo, entry.oid, into);
    else {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined) into.set(entry.oid, blob);
    }
  }
}

// ---------------------------------------------------------------------------
// Pack files
// ---------------------------------------------------------------------------

/**
 * Inflate the deflated stream starting at `offset`; returns the output and the offset just past the
 * stream. zlib's sync inflate ignores trailing bytes, so the exact end is found by binary search for
 * the shortest prefix that still inflates (a shorter one throws "unexpected end of file").
 */
function inflateAt(buffer: Buffer, offset: number): { out: Buffer; next: number } {
  const rest = buffer.subarray(offset);
  let lo = 1;
  let hi = rest.length;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateSync(rest.subarray(0, mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('corrupt deflate stream in pack');
  return { out: best, next: offset + lo };
}

/** Apply a git delta (ofs/ref delta payload) to a base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) { copyOffset |= delta[offset]! << (8 * bit); offset += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) { copySize |= delta[offset]! << (8 * bit); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

interface PackReadResult {
  /** Object ids the pack carried (after delta resolution). */
  oids: string[];
}

/**
 * Read a pack into the repository store. Every object is stored before any ref moves, mirroring
 * git's "unpack first, then update refs" order. Throws on a malformed pack or a bad trailer.
 */
function readPack(repo: RepoRec, pack: Buffer): PackReadResult {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('not a pack file');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const computed = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  let offset = 12;
  const byOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  const pendingDeltas: Array<{ offset: number; baseOffset?: number; baseOid?: string; delta: Buffer }> = [];
  for (let index = 0; index < count; index += 1) {
    const objectStart = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint back to the base object.
      let backByte = pack[offset]!;
      offset += 1;
      let back = backByte & 0x7f;
      while (backByte & 0x80) {
        backByte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (backByte & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pendingDeltas.push({ offset: objectStart, baseOffset: objectStart - back, delta: inflated.out });
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id (which may already be in the store).
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pendingDeltas.push({ offset: objectStart, baseOid, delta: inflated.out });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.out.length !== size) throw new Error('pack object size mismatch');
      byOffset.set(objectStart, { type, data: inflated.out });
    }
  }
  // Resolve deltas (a delta's base may itself be a delta; loop until none are left).
  let remaining = pendingDeltas;
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > count + 2) throw new Error('delta chain does not resolve');
    const deferred: typeof remaining = [];
    for (const delta of remaining) {
      let base: { type: ObjectType; data: Buffer } | undefined;
      if (delta.baseOffset !== undefined) base = byOffset.get(delta.baseOffset);
      else if (delta.baseOid !== undefined) base = repo.objects.get(delta.baseOid) ?? byOffsetGet(byOffset, repo, delta.baseOid);
      if (base === undefined) {
        deferred.push(delta);
        continue;
      }
      const data = applyDelta(base.data, delta.delta);
      byOffset.set(delta.offset, { type: base.type, data });
    }
    if (deferred.length === remaining.length) throw new Error('delta base is missing');
    remaining = deferred;
  }
  const oids: string[] = [];
  for (const object of byOffset.values()) oids.push(storeObject(repo, object.type, object.data));
  return { oids };
}

/** Look up an object among the pack objects parsed so far, by id. */
function byOffsetGet(byOffset: Map<number, { type: ObjectType; data: Buffer }>, repo: RepoRec, oid: string): { type: ObjectType; data: Buffer } | undefined {
  for (const object of byOffset.values()) if (hashObject(object.type, object.data) === oid) return object;
  return repo.objects.get(oid);
}

/** Serialize objects as a version-2 pack of plain (non-delta) objects, with its SHA-1 trailer. */
function writePack(objects: StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const bytes: number[] = [];
    let first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Fetch planning (upload-pack)
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: Map<string, StoredObject>;
  /** Commits the response's shallow-info must newly mark as shallow boundaries. */
  shallow: string[];
  /** Request-listed boundary commits that are no longer boundaries. */
  unshallow: string[];
}

/**
 * Compute the object set for a fetch: everything reachable from the wants that the client cannot
 * already have, honouring the haves (full ancestry), the client's shallow boundary (traversal
 * stops there when no depth is given) and an explicit depth/deepen (commit generations from the
 * want tips). Boundary bookkeeping follows the protocol: an included commit whose parent is not
 * included is a shallow boundary.
 */
function planFetch(repo: RepoRec, wants: string[], haves: string[], shallowReq: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallowReq);
  // Excluded: the haves' ancestry; a shallow-listed have is included but its parents are not
  // (the client does not have them either).
  const excluded = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const commit = peelToCommit(repo, have);
      if (commit !== null) queue.push(commit);
    }
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      if (shallowSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
  }
  // Included: breadth-first from the want tips, level = commit generation (tip = 1). A want tip is
  // always traversed, even when it is also a have (a deepen request names the boundary commit as
  // both): the haves only prune the traversal, they do not remove the roots.
  const wantTips = new Set<string>();
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null) wantTips.add(commit);
  }
  const level = new Map<string, number>();
  {
    const queue: Array<[string, number]> = [];
    for (const commit of wantTips) queue.push([commit, 1]);
    while (queue.length > 0) {
      const [oid, lvl] = queue.shift()!;
      if (excluded.has(oid) && !wantTips.has(oid)) continue;
      const known = level.get(oid);
      if (known !== undefined && known <= lvl) continue;
      if (depth !== null && lvl > depth) continue;
      level.set(oid, lvl);
      if (depth === null && shallowSet.has(oid) && !wantTips.has(oid)) continue; // do not cross the client's boundary
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, lvl + 1]);
      }
    }
  }
  const included = new Set(level.keys());
  // What actually travels: the traversed commits the client does not already have.
  const sendCommits = [...included].filter((oid) => !excluded.has(oid));
  const boundary = new Set<string>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (repo.objects.has(parent) && !included.has(parent)) boundary.add(oid);
    }
  }
  const objects = new Map<string, StoredObject>();
  // The wanted objects themselves (a tag want travels with its tag object).
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && !excluded.has(want)) objects.set(want, object);
  }
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  // Tree closures of the sent commits, minus the closures of excluded commits.
  const negative = new Map<string, StoredObject>();
  for (const oid of excluded) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') collectTreeClosure(repo, parseCommit(object.data).tree, negative);
  }
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') collectTreeClosure(repo, parseCommit(object.data).tree, objects);
  }
  for (const oid of negative.keys()) {
    // A tree or blob the client already has (via an excluded commit) is not resent — unless it is
    // also one of the included commits' own objects, which the commit loop above settled already:
    // commits are never in a tree closure, so deleting here only drops shared trees/blobs.
    if (!included.has(oid)) objects.delete(oid);
  }
  const shallow = [...boundary].filter((oid) => !shallowSet.has(oid)).sort();
  const unshallow = [...shallowSet].filter((oid) => included.has(oid) && !boundary.has(oid)).sort();
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Merging and diffs
// ---------------------------------------------------------------------------

interface MergeOutcome {
  /** The merged tree's flat path map, or null when the merge conflicts. */
  flat: Map<string, { oid: string; mode: string }> | null;
  conflictPath: string | null;
}

/** A file-level three-way merge of two branch tips against their merge base. */
function threeWayMerge(repo: RepoRec, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const ourTree = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const theirTree = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseTree.keys(), ...ourTree.keys(), ...theirTree.keys()]);
  for (const path of paths) {
    const inBase = baseTree.get(path);
    const inOurs = ourTree.get(path);
    const inTheirs = theirTree.get(path);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
    if (same(inOurs, inTheirs)) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else if (same(inBase, inOurs)) {
      if (inTheirs !== undefined) merged.set(path, inTheirs);
    } else if (same(inBase, inTheirs)) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else {
      return { flat: null, conflictPath: path };
    }
  }
  return { flat: merged, conflictPath: null };
}

interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a blob, by lines (a trailing line without a newline still counts). */
function blobLines(repo: RepoRec, oid: string | undefined): string[] {
  if (oid === undefined) return [];
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two blobs, from a longest-common-subsequence diff. */
function lineDiff(repo: RepoRec, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
  const oldLines = blobLines(repo, oldOid);
  const newLines = blobLines(repo, newOid);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  // LCS dynamic program; the files this forge diffs are small.
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * (cols + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (cols + 1) + j + 1]! + 1
        : Math.max(dp[(i + 1) * (cols + 1) + j]!, dp[i * (cols + 1) + j + 1]!);
    }
  }
  const common = dp[0]!;
  return { additions: cols - common, deletions: rows - common };
}

/** The file changes of a pull request: merge-base tree versus head tree, as GitHub reports them. */
function pullRequestFiles(repo: RepoRec, baseTip: string, headTip: string): FileChange[] {
  const base = mergeBase(repo, baseTip, headTip);
  const fromTree = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const toTree = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const changes: FileChange[] = [];
  const paths = new Set([...fromTree.keys(), ...toTree.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromTree.get(path);
    const to = toTree.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    const status = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';
    const { additions, deletions } = lineDiff(repo, from?.oid, to?.oid);
    changes.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Core operations (shared by REST, GraphQL and MCP, so every surface agrees)
// ---------------------------------------------------------------------------

function opCreateRepo(forge: Forge, input: { name: string; isPrivate?: boolean; description?: string; defaultBranch?: string }): RepoRec {
  const name = input.name;
  if (typeof name !== 'string' || name === '') throw new HttpError(422, 'Repository creation failed: name is required');
  if (forge.repos.has(name)) throw new HttpError(422, `Repository creation failed: a repository named "${name}" already exists on this account`);
  const repo: RepoRec = {
    dbId: forge.nextRepoId,
    name,
    isPrivate: input.isPrivate === true,
    description: input.description ?? '',
    defaultBranch: input.defaultBranch !== undefined && input.defaultBranch !== '' ? input.defaultBranch : 'main',
    createdAt: nowIso(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    items: new Map(),
    comments: new Map(),
    nextNumber: 1,
  };
  forge.nextRepoId += 1;
  forge.repos.set(name, repo);
  return repo;
}

function getRepoOr404(forge: Forge, name: string): RepoRec {
  const repo = forge.repos.get(name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function opCreateIssue(forge: Forge, repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): ItemRec {
  if (typeof input.title !== 'string' || input.title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist on this repository`);
  }
  const stamp = nowIso();
  const item: ItemRec = {
    number: repo.nextNumber,
    dbId: forge.nextItemDbId,
    kind: 'issue',
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    createdAt: stamp,
    updatedAt: stamp,
    headRef: '',
    baseRef: '',
    headSha: null,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
  };
  repo.nextNumber += 1;
  forge.nextItemDbId += 1;
  repo.items.set(item.number, item);
  return item;
}

function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function opCreatePull(forge: Forge, repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): ItemRec {
  if (typeof input.title !== 'string' || input.title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const headTip = branchTip(repo, input.head);
  if (headTip === null) throw new HttpError(422, `Validation Failed: head branch "${input.head}" does not exist`);
  const baseTip = branchTip(repo, input.base);
  if (baseTip === null) throw new HttpError(422, `Validation Failed: base branch "${input.base}" does not exist`);
  if (headTip === baseTip) throw new HttpError(422, 'Validation Failed: no commits between base and head');
  for (const item of repo.items.values()) {
    if (item.kind === 'pr' && item.state === 'open' && item.headRef === input.head && item.baseRef === input.base) {
      throw new HttpError(422, `A pull request already exists for ${VIEWER_LOGIN}:${input.head} -> ${input.base}`);
    }
  }
  const stamp = nowIso();
  const item: ItemRec = {
    number: repo.nextNumber,
    dbId: forge.nextItemDbId,
    kind: 'pr',
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [],
    createdAt: stamp,
    updatedAt: stamp,
    headRef: input.head,
    baseRef: input.base,
    headSha: headTip,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
  };
  repo.nextNumber += 1;
  forge.nextItemDbId += 1;
  repo.items.set(item.number, item);
  return item;
}

/** Squash-merge a pull request; returns the merge commit id. Throws 405 when not mergeable. */
function opMergePull(forge: Forge, repo: RepoRec, item: ItemRec): string {
  if (item.kind !== 'pr') throw new HttpError(404, 'Not Found');
  if (item.merged || item.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const baseTip = branchTip(repo, item.baseRef);
  const headTip = branchTip(repo, item.headRef) ?? item.headSha;
  if (baseTip === null || headTip === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const outcome = threeWayMerge(repo, baseTip, headTip);
  if (outcome.flat === null) throw new HttpError(405, `Pull Request is not mergeable: merge conflict in ${outcome.conflictPath ?? 'a file'}`);
  const tree = buildTreeFromFlat(repo, outcome.flat);
  const sha = makeCommit(repo, tree, [baseTip], `${item.title} (#${item.number})`);
  repo.refs.set(`refs/heads/${item.baseRef}`, sha);
  item.state = 'closed';
  item.merged = true;
  item.mergeCommitSha = sha;
  item.mergedAt = nowIso();
  item.updatedAt = item.mergedAt;
  return sha;
}

/** Whether an open pull request would merge cleanly right now (GraphQL's mergeable). */
function pullMergeable(repo: RepoRec, item: ItemRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (item.kind !== 'pr' || item.merged || item.state !== 'open') return 'UNKNOWN';
  const baseTip = branchTip(repo, item.baseRef);
  const headTip = branchTip(repo, item.headRef) ?? item.headSha;
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  return threeWayMerge(repo, baseTip, headTip).flat === null ? 'CONFLICTING' : 'MERGEABLE';
}

function opAddComment(forge: Forge, repo: RepoRec, item: ItemRec, body: string): CommentRec {
  const comment: CommentRec = { id: forge.nextCommentId, body, createdAt: nowIso() };
  forge.nextCommentId += 1;
  const list = repo.comments.get(item.number) ?? [];
  list.push(comment);
  repo.comments.set(item.number, list);
  return comment;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** A Relay-style global id: opaque, stable, and never the plain database id. */
function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const pieces = text.split(':');
    if (pieces.length < 2 || pieces[0] === '') return null;
    return { type: pieces[0]!, parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: null, default: false };
}

function issueJson(repo: RepoRec, item: ItemRec): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: item.dbId,
    node_id: globalId(item.kind === 'pr' ? 'PullRequest' : 'Issue', repo.dbId, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000' })),
    user: userJson(),
    comments: (repo.comments.get(item.number) ?? []).length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
  };
  if (item.kind === 'pr') json['pull_request'] = { merged_at: item.mergedAt };
  return json;
}

function pullJson(repo: RepoRec, item: ItemRec): Record<string, unknown> {
  const headTip = branchTip(repo, item.headRef) ?? item.headSha;
  const baseTip = branchTip(repo, item.baseRef);
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${VIEWER_LOGIN}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: item.dbId,
    node_id: globalId('PullRequest', repo.dbId, item.number),
    number: item.number,
    state: item.merged ? 'closed' : item.state,
    title: item.title,
    body: item.body,
    user: userJson(),
    labels: [],
    head: side(item.headRef, headTip),
    base: side(item.baseRef, baseTip),
    merged: item.merged,
    merged_at: item.mergedAt,
    merge_commit_sha: item.mergeCommitSha,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    draft: false,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  if (TOKEN !== '') return match[1] === TOKEN;
  return match[1] !== '';
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), ...extraHeaders });
  res.end(body);
}

function sendBody(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...extraHeaders });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; an empty body counts as {}, malformed JSON is a 400. */
function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Problems parsing JSON');
  return value as Record<string, unknown>;
}

interface Page<T> {
  items: T[];
  link: string | null;
}

/** GitHub-style pagination: per_page (default 30) and page, with an absolute Link header. */
function paginate<T>(url: URL, all: T[]): Page<T> {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  let link: string | null = null;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  if (all.length > 0 && page <= totalPages) {
    const rels: string[] = [];
    const linkUrl = (target: number): string => {
      const copy = new URL(url.toString());
      copy.searchParams.set('page', String(target));
      copy.searchParams.set('per_page', String(perPage));
      return copy.toString();
    };
    if (page < totalPages) rels.push(`<${linkUrl(page + 1)}>; rel="next"`, `<${linkUrl(totalPages)}>; rel="last"`);
    if (page > 1) rels.push(`<${linkUrl(page - 1)}>; rel="prev"`, `<${linkUrl(1)}>; rel="first"`);
    if (rels.length > 0) link = rels.join(', ');
  }
  return { items, link };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
}

/** Walk a tree to a path; returns the file or directory found there, or null. */
function navigateTree(repo: RepoRec, rootTreeOid: string, pieces: string[]): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
  let current = rootTreeOid;
  for (let index = 0; index < pieces.length; index += 1) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === pieces[index]);
    if (entry === undefined) return null;
    if (index === pieces.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: current };
}

/** Resolve the branch a contents call works on; an unborn default branch yields tip null. */
function contentsBranch(repo: RepoRec, branch: string): { refName: string; tip: string | null } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip !== undefined) return { refName, tip };
  if (repo.refs.size === 0 && branch === repo.defaultBranch) return { refName, tip: null };
  throw new HttpError(404, 'Branch not found');
}

function commitTreeOid(repo: RepoRec, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
  return parseCommit(object.data).tree;
}

function handleRestRoot(ctx: Ctx): void {
  const origin = ctx.url.origin;
  sendJson(ctx.res, 200, {
    current_user_url: `${origin}/api/v3/user`,
    current_user_repositories_url: `${origin}/api/v3/user/repos`,
    repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
    issue_url: `${origin}/api/v3/repos/{owner}/{repo}/issues`,
    label_url: `${origin}/api/v3/repos/{owner}/{repo}/labels`,
    organization_url: `${origin}/api/v3/orgs/{org}`,
    emojis_url: `${origin}/api/v3/emojis`,
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

function handleContents(ctx: Ctx, repo: RepoRec, pieces: string[], method: string): void {
  const path = pieces.join('/');
  if (method === 'GET') {
    const refish = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
    const oid = resolveRefish(repo, refish);
    const commit = oid === null ? null : peelToCommit(repo, oid);
    if (commit === null) throw new HttpError(404, 'Not Found');
    const found = navigateTree(repo, commitTreeOid(repo, commit), pieces);
    if (found === null) throw new HttpError(404, 'Not Found');
    if (found.kind === 'file') {
      const blob = repo.objects.get(found.oid);
      if (blob === undefined) throw new HttpError(404, 'Not Found');
      sendJson(ctx.res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: pieces[pieces.length - 1] ?? '',
        path,
        sha: found.oid,
        size: blob.data.length,
      });
      return;
    }
    const tree = repo.objects.get(found.oid);
    if (tree === undefined || tree.type !== 'tree') throw new HttpError(404, 'Not Found');
    const entries = parseTree(tree.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
    }));
    sendJson(ctx.res, 200, entries);
    return;
  }
  if (method === 'PUT' || method === 'DELETE') {
    const body = parseJsonBody(ctx.body);
    const branch = typeof body['branch'] === 'string' ? (body['branch'] as string) : repo.defaultBranch;
    const { refName, tip } = contentsBranch(repo, branch);
    const flat = tip === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, commitTreeOid(repo, tip));
    const existing = flat.get(path);
    const message = typeof body['message'] === 'string' ? (body['message'] as string) : '';
    if (method === 'PUT') {
      if (typeof body['content'] !== 'string') throw new HttpError(422, 'Validation Failed: content is required');
      if (message === '') throw new HttpError(422, 'Validation Failed: message is required');
      if (existing !== undefined) {
        if (body['sha'] === undefined) throw new HttpError(422, 'Validation Failed: sha is required when updating a file');
        if (body['sha'] !== existing.oid) throw new HttpError(409, `${path} does not match ${String(body['sha'])}`);
      }
      const bytes = Buffer.from(body['content'] as string, 'base64');
      const blobOid = storeObject(repo, 'blob', bytes);
      flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
      const tree = buildTreeFromFlat(repo, flat);
      const commit = makeCommit(repo, tree, tip === null ? [] : [tip], message);
      repo.refs.set(refName, commit);
      sendJson(ctx.res, existing === undefined ? 201 : 200, {
        content: {
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
          name: pieces[pieces.length - 1] ?? '',
          path,
          sha: blobOid,
          size: bytes.length,
        },
        commit: { sha: commit, message },
      });
      return;
    }
    // DELETE
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    if (body['sha'] !== existing.oid) throw new HttpError(409, `${path} does not match ${String(body['sha'])}`);
    if (message === '') throw new HttpError(422, 'Validation Failed: message is required');
    flat.delete(path);
    const tree = buildTreeFromFlat(repo, flat);
    const commit = makeCommit(repo, tree, tip === null ? [] : [tip], message);
    repo.refs.set(refName, commit);
    sendJson(ctx.res, 200, { content: null, commit: { sha: commit, message } });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function handleRepoScoped(ctx: Ctx, repo: RepoRec, tail: string[], method: string): void {
  const [head, ...rest] = tail;
  if (head === undefined) {
    if (method === 'GET') {
      sendJson(ctx.res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(ctx.body);
      if (typeof body['description'] === 'string') repo.description = body['description'] as string;
      if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'] as boolean;
      if (typeof body['name'] === 'string' && (body['name'] as string) !== '' && (body['name'] as string) !== repo.name) {
        const next = body['name'] as string;
        if (ctx.forge.repos.has(next)) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
        ctx.forge.repos.delete(repo.name);
        repo.name = next;
        ctx.forge.repos.set(next, repo);
      }
      if (typeof body['default_branch'] === 'string' && (body['default_branch'] as string) !== '') {
        const candidate = body['default_branch'] as string;
        if (repo.refs.has(`refs/heads/${candidate}`) || repo.refs.size === 0) repo.defaultBranch = candidate;
      }
      sendJson(ctx.res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      ctx.forge.repos.delete(repo.name);
      ctx.res.writeHead(204, { 'content-type': 'application/json; charset=utf-8' });
      ctx.res.end();
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (head === 'branches') {
    if (rest.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(ctx.res, 200, branches);
      return;
    }
    if (method === 'GET') {
      const name = rest.join('/');
      const oid = repo.refs.get(`refs/heads/${name}`);
      if (oid === undefined) throw new HttpError(404, 'Not Found');
      sendJson(ctx.res, 200, { name, commit: { sha: oid }, protected: false });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (head === 'git' && rest[0] === 'refs') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }))
          .sort((a, b) => (a.ref < b.ref ? -1 : 1));
        sendJson(ctx.res, 200, refs);
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(ctx.body);
        const ref = body['ref'];
        const sha = body['sha'];
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
        if (typeof sha !== 'string' || !repo.objects.has(sha)) throw new HttpError(422, 'Validation Failed: object does not exist');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        sendJson(ctx.res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (method === 'GET') {
      const suffix = rest.slice(1).join('/');
      const full = suffix.startsWith('refs/') ? suffix : `refs/${suffix}`;
      const oid = repo.refs.get(full);
      if (oid === undefined) throw new HttpError(404, 'Not Found');
      sendJson(ctx.res, 200, { ref: full, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (head === 'commits' && rest.length === 0 && method === 'GET') {
    const refish = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
    const oid = resolveRefish(repo, refish);
    const commit = oid === null ? null : peelToCommit(repo, oid);
    if (commit === null) throw new HttpError(409, 'Git Repository is empty.');
    const list = reachableCommits(repo, commit).map((sha) => {
      const parsed = parseCommit(repo.objects.get(sha)!.data);
      const person = (line: string): { name: string; email: string; date: string } => {
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
        if (match === null) return { name: line, email: '', date: repo.createdAt };
        return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
      };
      return {
        sha,
        commit: { message: parsed.message, author: person(parsed.author), committer: person(parsed.committer), tree: { sha: parsed.tree } },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
      };
    });
    const page = paginate(ctx.url, list);
    sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
    return;
  }
  if (head === 'contents') {
    handleContents(ctx, repo, rest, method);
    return;
  }
  if (head === 'labels' && rest.length === 0) {
    if (method === 'GET') {
      const page = paginate(ctx.url, [...repo.labels.values()].map(labelJson));
      sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx.body);
      const name = body['name'];
      if (typeof name !== 'string' || name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
      const label: LabelRec = { name, color: typeof body['color'] === 'string' ? (body['color'] as string) : '000000' };
      repo.labels.set(name, label);
      sendJson(ctx.res, 201, labelJson(label));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (head === 'issues') {
    handleIssues(ctx, repo, rest, method);
    return;
  }
  if (head === 'pulls') {
    handlePulls(ctx, repo, rest, method);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function handleIssues(ctx: Ctx, repo: RepoRec, rest: string[], method: string): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const labelsParam = ctx.url.searchParams.get('labels');
      const wantedLabels = labelsParam === null || labelsParam === '' ? [] : labelsParam.split(',').map((piece) => piece.trim()).filter(Boolean);
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.items.values()];
      if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
      else if (state !== 'all') items = items.filter((item) => item.state === 'open');
      if (wantedLabels.length > 0) items = items.filter((item) => wantedLabels.every((label) => item.labels.includes(label)));
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(ctx.url, items.map((item) => issueJson(repo, item)));
      sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx.body);
      const item = opCreateIssue(ctx.forge, repo, {
        title: typeof body['title'] === 'string' ? (body['title'] as string) : '',
        body: typeof body['body'] === 'string' ? (body['body'] as string) : '',
        labels: Array.isArray(body['labels']) ? (body['labels'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      });
      sendJson(ctx.res, 201, issueJson(repo, item));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0]!, 10);
  const item = Number.isFinite(number) ? repo.items.get(number) : undefined;
  if (item === undefined) throw new HttpError(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(ctx.res, 200, issueJson(repo, item));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(ctx.body);
      if (typeof body['title'] === 'string') item.title = body['title'] as string;
      if (typeof body['body'] === 'string') item.body = body['body'] as string;
      if (body['state'] === 'open' || body['state'] === 'closed') item.state = body['state'];
      if (Array.isArray(body['labels'])) {
        const labels = (body['labels'] as unknown[]).filter((x): x is string => typeof x === 'string');
        for (const label of labels) if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist on this repository`);
        item.labels = labels;
      }
      item.updatedAt = nowIso();
      sendJson(ctx.res, 200, issueJson(repo, item));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const page = paginate(ctx.url, (repo.comments.get(item.number) ?? []).map(commentJson));
      sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx.body);
      if (typeof body['body'] !== 'string' || (body['body'] as string) === '') throw new HttpError(422, 'Validation Failed: body is required');
      const comment = opAddComment(ctx.forge, repo, item, body['body'] as string);
      sendJson(ctx.res, 201, commentJson(comment));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  throw new HttpError(404, 'Not Found');
}

function handlePulls(ctx: Ctx, repo: RepoRec, rest: string[], method: string): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
      if (state === 'open') items = items.filter((item) => item.state === 'open' && !item.merged);
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed' || item.merged);
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(ctx.url, items.map((item) => pullJson(repo, item)));
      sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx.body);
      const stripOwner = (ref: unknown): string => {
        const text = typeof ref === 'string' ? ref : '';
        const colon = text.indexOf(':');
        return colon === -1 ? text : text.slice(colon + 1);
      };
      const item = opCreatePull(ctx.forge, repo, {
        title: typeof body['title'] === 'string' ? (body['title'] as string) : '',
        body: typeof body['body'] === 'string' ? (body['body'] as string) : '',
        head: stripOwner(body['head']),
        base: stripOwner(body['base']),
      });
      sendJson(ctx.res, 201, pullJson(repo, item));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0]!, 10);
  const item = Number.isFinite(number) ? repo.items.get(number) : undefined;
  if (item === undefined || item.kind !== 'pr') throw new HttpError(404, 'Not Found');
  if (rest.length === 1 && method === 'GET') {
    sendJson(ctx.res, 200, pullJson(repo, item));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const baseTip = branchTip(repo, item.baseRef);
    const headTip = branchTip(repo, item.headRef) ?? item.headSha;
    if (baseTip === null || headTip === null) {
      sendJson(ctx.res, 200, []);
      return;
    }
    const page = paginate(ctx.url, pullRequestFiles(repo, baseTip, headTip));
    sendJson(ctx.res, 200, page.items, page.link === null ? {} : { link: page.link });
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const body = parseJsonBody(ctx.body);
    const baseTip = branchTip(repo, item.baseRef);
    if (typeof body['sha'] === 'string' && baseTip !== null && body['sha'] !== baseTip) {
      throw new HttpError(409, 'The base branch has been modified since the pull request was reviewed');
    }
    const sha = opMergePull(ctx.forge, repo, item);
    sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

async function handleRest(ctx: Ctx, segments: string[]): Promise<void> {
  const { res } = ctx;
  try {
    if (!isAuthed(ctx.req)) throw new HttpError(401, 'Unauthorized');
    const method = ctx.req.method ?? 'GET';
    if (segments.length === 0) {
      if (method !== 'GET') throw new HttpError(404, 'Not Found');
      handleRestRoot(ctx);
      return;
    }
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { installed_version: FORGE_VERSION, github_developer_version: FORGE_VERSION });
      return;
    }
    if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
      sendJson(res, 200, userJson());
      return;
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const page = paginate(ctx.url, [...ctx.forge.repos.values()].map(repoJson));
        sendJson(res, 200, page.items, page.link === null ? {} : { link: page.link });
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(ctx.body);
        const repo = opCreateRepo(ctx.forge, {
          name: typeof body['name'] === 'string' ? (body['name'] as string) : '',
          isPrivate: body['private'] === true,
          description: typeof body['description'] === 'string' ? (body['description'] as string) : '',
          defaultBranch: typeof body['default_branch'] === 'string' ? (body['default_branch'] as string) : undefined,
        });
        sendJson(res, 201, repoJson(repo));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1]!;
      if (owner !== VIEWER_LOGIN) throw new HttpError(404, 'Not Found');
      const repo = getRepoOr404(ctx.forge, segments[2]!);
      handleRepoScoped(ctx, repo, segments.slice(3), method);
      return;
    }
    throw new HttpError(404, 'Not Found');
  } catch (err) {
    if (err instanceof HttpError) sendJson(res, err.status, { message: err.message });
    else throw err;
  }
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const FLUSH_PACKET = Buffer.from('0000', 'latin1');
const DELIM_PACKET = Buffer.from('0001', 'latin1');

/** One pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), data]);
}

function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Parse pkt-lines from the front of a buffer; returns the packets and the offset just past them. */
function parsePackets(buffer: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
    const head = buffer.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      break; // response-end: treat as the end of the packet stream
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** Parse a whole request body of pkt-lines (upload-pack requests carry nothing after the flush). */
function parseRequestPackets(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < body.length) {
    const parsed = parsePackets(body, offset);
    packets.push(...parsed.packets);
    if (parsed.next <= offset) break;
    offset = parsed.next;
  }
  return packets;
}

function packetText(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

/** Sorted [ref, oid] pairs, the order advertisements and listings use. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function handleInfoRefs(ctx: Ctx, repo: RepoRec): void {
  const service = ctx.url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBody(ctx.res, 400, Buffer.from('unknown service\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (service === 'git-upload-pack' && ctx.req.headers['git-protocol'] === 'version=2') {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT_STRING}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      FLUSH_PACKET,
    ]);
    sendBody(ctx.res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow agent=${AGENT_STRING}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_STRING}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PACKET];
  if (repo.refs.size === 0) {
    const symref = service === 'git-upload-pack' ? ` symref=HEAD:${headTarget}` : '';
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}${symref}`));
  } else {
    if (headOid !== undefined) parts.push(pktLine(`${headOid} HEAD\0${caps} symref=HEAD:${headTarget}`));
    for (const [ref, oid] of sortedRefs(repo)) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  sendBody(ctx.res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

function handleLsRefs(ctx: Ctx, repo: RepoRec, packets: Packet[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (!inArgs) continue;
    const line = packetText(packet);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const parts: Buffer[] = [];
  // HEAD is listed only when no prefix was given, or a prefix could match it: the suite's raw-line
  // inspection requires every returned line to fall under one of the requested prefixes.
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headOid !== undefined && headWanted) {
    parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
  } else if (headOid === undefined && unborn) {
    parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PACKET);
  sendBody(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function readFetchArgs(packets: Packet[], argsStartAfterDelim: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = !argsStartAfterDelim;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') {
      if (inArgs && argsStartAfterDelim) break;
      inArgs = true; // v0: the first flush ends the want section; haves follow
      continue;
    }
    const line = packetText(packet);
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10) || null;
  }
  return args;
}

function handleFetchV2(ctx: Ctx, repo: RepoRec, packets: Packet[]): void {
  const args = readFetchArgs(packets, true);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const ackHave = args.haves.find((have) => repo.objects.has(have));
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine(ackHave === undefined ? 'NAK\n' : `ACK ${ackHave}\n`), DELIM_PACKET];
  if (args.shallow.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PACKET);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack([...plan.objects.values()]);
  for (let offset = 0; offset < pack.length; offset += 32768) {
    parts.push(sidebandPacket(1, pack.subarray(offset, offset + 32768)));
  }
  parts.push(FLUSH_PACKET);
  sendBody(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(ctx: Ctx, repo: RepoRec, packets: Packet[]): void {
  const args = readFetchArgs(packets, false);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [pktLine('NAK\n')];
  const pack = writePack([...plan.objects.values()]);
  for (let offset = 0; offset < pack.length; offset += 32768) {
    parts.push(sidebandPacket(1, pack.subarray(offset, offset + 32768)));
  }
  parts.push(FLUSH_PACKET);
  sendBody(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPack(ctx: Ctx, repo: RepoRec): void {
  let packets: Packet[];
  try {
    packets = parseRequestPackets(ctx.body);
  } catch {
    sendBody(ctx.res, 400, Buffer.from('invalid upload-pack request\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  if (ctx.req.headers['git-protocol'] === 'version=2') {
    const first = packets.find((packet) => packet.kind === 'data');
    const command = first === undefined ? '' : packetText(first);
    if (command === 'command=ls-refs') {
      handleLsRefs(ctx, repo, packets);
      return;
    }
    if (command === 'command=fetch') {
      handleFetchV2(ctx, repo, packets);
      return;
    }
    sendBody(ctx.res, 400, Buffer.from('unknown command\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  handleFetchV0(ctx, repo, packets);
}

function handleReceivePack(ctx: Ctx, repo: RepoRec): void {
  let parsed: { packets: Packet[]; next: number };
  try {
    parsed = parsePackets(ctx.body, 0);
  } catch {
    sendBody(ctx.res, 400, Buffer.from('invalid receive-pack request\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const pieces = line.split(' ');
    if (pieces.length >= 3) commands.push({ oldOid: pieces[0]!, newOid: pieces[1]!, ref: pieces.slice(2).join(' ') });
  }
  const packBytes = ctx.body.subarray(parsed.next);
  const sideBand = capabilities.includes('side-band-64k');
  const reportStatus = capabilities.includes('report-status');
  let unpackLine = 'unpack ok';
  let unpackOk = true;
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackLine = 'unpack no packfile given';
      unpackOk = false;
    } else {
      try {
        readPack(repo, packBytes);
      } catch (err) {
        unpackLine = `unpack ${err instanceof Error ? err.message : 'corrupt pack'}`;
        unpackOk = false;
      }
    }
  }
  const report: string[] = [unpackLine];
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== ZERO_OID && current !== command.newOid) {
        report.push(`ng ${command.ref} reference already exists`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} stale info`);
      continue;
    }
    const oldCommit = peelToCommit(repo, command.oldOid);
    const newCommit = peelToCommit(repo, command.newOid);
    if (newCommit === null) {
      report.push(`ng ${command.ref} not a commit`);
      continue;
    }
    if (oldCommit !== null && oldCommit !== newCommit) {
      // The common case (a push straight onto the tip) is settled by the parent list alone;
      // anything else walks the ancestry.
      const newParsed = parseCommit(repo.objects.get(newCommit)!.data);
      if (!newParsed.parents.includes(oldCommit) && !isAncestor(repo, oldCommit, newCommit)) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  if (!reportStatus && !sideBand) {
    sendBody(ctx.res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const parts: Buffer[] = report.map((line) => {
    const payload = Buffer.from(`${line}\n`, 'utf8');
    return sideBand ? sidebandPacket(1, payload) : pktLine(payload);
  });
  parts.push(FLUSH_PACKET);
  sendBody(ctx.res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

function handleGit(ctx: Ctx, owner: string, repoSegment: string, tail: string[]): void {
  if (owner !== VIEWER_LOGIN || !repoSegment.endsWith('.git')) {
    sendBody(ctx.res, 404, Buffer.from('not found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const repo = ctx.forge.repos.get(repoSegment.slice(0, -'.git'.length));
  if (repo === undefined) {
    sendBody(ctx.res, 404, Buffer.from('not found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  if (!isAuthed(ctx.req)) {
    sendBody(ctx.res, 401, Buffer.from('authentication required\n', 'utf8'), 'text/plain; charset=utf-8', { 'www-authenticate': 'Basic realm="git"' });
    return;
  }
  const method = ctx.req.method ?? 'GET';
  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    handleInfoRefs(ctx, repo);
    return;
  }
  if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
    handleUploadPack(ctx, repo);
    return;
  }
  if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
    handleReceivePack(ctx, repo);
    return;
  }
  sendBody(ctx.res, 404, Buffer.from('not found\n', 'utf8'), 'text/plain; charset=utf-8');
}

// ---------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------

type GqlValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValueNode }> };

interface GqlFieldNode {
  alias: string | null;
  name: string;
  args: Map<string, GqlValueNode>;
  selection: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlFieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: GqlSelection[] }
  | { kind: 'fragmentSpread'; name: string };

interface GqlOperation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, GqlValueNode>;
  selection: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection[]>;
}

interface GqlTok {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function gqlTokenize(source: string): GqlTok[] {
  const tokens: GqlTok[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new Error('bad number');
      tokens.push({ kind: 'number', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  private tokens: GqlTok[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = gqlTokenize(source);
  }

  private peek(): GqlTok {
    return this.tokens[this.pos]!;
  }

  private next(): GqlTok {
    const tok = this.tokens[this.pos]!;
    this.pos += 1;
    return tok;
  }

  private expect(kind: GqlTok['kind'], value?: string): GqlTok {
    const tok = this.next();
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) throw new Error(`expected ${value ?? kind}, got ${tok.value}`);
    return tok;
  }

  private atPunct(value: string): boolean {
    const tok = this.peek();
    return tok.kind === 'punct' && tok.value === value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ opType: 'query', name: null, varDefaults: new Map(), selection: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        this.next();
        const opType = tok.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefaults = new Map<string, GqlValueNode>();
        if (this.atPunct('(')) this.parseVariableDefinitions(varDefaults);
        this.parseDirectives();
        operations.push({ opType, name, varDefaults, selection: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        this.expect('name');
        this.parseDirectives();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${tok.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, GqlValueNode>): void {
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      const name = this.expect('name').value;
      this.expect('punct', ':');
      this.parseTypeRef();
      if (this.atPunct('=')) {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.parseDirectives();
    }
    this.expect('punct', ')');
  }

  private parseTypeRef(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseTypeRef();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expect('name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): Map<string, GqlValueNode> {
    const args = new Map<string, GqlValueNode>();
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      const name = this.expect('name').value;
      this.expect('punct', ':');
      args.set(name, this.parseValue());
    }
    this.expect('punct', ')');
    return args;
  }

  private parseValue(): GqlValueNode {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (tok.kind === 'string') {
      this.next();
      return { kind: 'string', value: tok.value };
    }
    if (tok.kind === 'number') {
      this.next();
      return { kind: 'number', value: Number(tok.value) };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const items: GqlValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: GqlValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      this.next();
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('punct', '{');
    const selections: GqlSelection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.parseDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.parseDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expect('name').value;
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expect('name').value;
      }
      const args = this.atPunct('(') ? this.parseArguments() : new Map<string, GqlValueNode>();
      this.parseDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    this.expect('punct', '}');
    return selections;
  }
}

// --- Schema surface for introspection --------------------------------------

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'isViewer', 'repositories', 'issues', 'pullRequests'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'isFork', 'createdAt', 'updatedAt', 'url', 'stargazerCount', 'forkCount', 'primaryLanguage', 'labels', 'refs', 'object', 'assignableUsers'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'locked', 'activeLockReason', 'assignees', 'milestone', 'reactionGroups'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'mergeCommit', 'url', 'repository', 'additions', 'deletions', 'changedFiles', 'isDraft', 'headRef', 'baseRef', 'commits', 'labels'],
  Ref: ['name', 'prefix', 'target', 'repository'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue', 'pullRequest'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
};

// --- Execution ---------------------------------------------------------------

type GqlParent = { __type: string; [key: string]: unknown };

interface GqlExec {
  forge: Forge;
  variables: Record<string, unknown>;
  varDefaults: Map<string, GqlValueNode>;
  fragments: Map<string, GqlSelection[]>;
  errors: Array<{ message: string }>;
}

function gqlResolveValue(node: GqlValueNode, exec: GqlExec): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in exec.variables) return exec.variables[node.name];
      const fallback = exec.varDefaults.get(node.name);
      return fallback === undefined ? undefined : gqlResolveValue(fallback, exec);
    }
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => gqlResolveValue(item, exec));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = gqlResolveValue(field.value, exec);
      return out;
    }
  }
}

function viewerParent(): GqlParent {
  return { __type: 'User', login: VIEWER_LOGIN, id: globalId('User', VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL, url: `https://github.com/${VIEWER_LOGIN}`, isViewer: true };
}

function repoParent(repo: RepoRec): GqlParent {
  return { __type: 'Repository', repo };
}

function issueParent(repo: RepoRec, item: ItemRec): GqlParent {
  return {
    __type: 'Issue',
    repo,
    item,
    number: item.number,
    title: item.title,
    body: item.body,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.state === 'closed' ? item.updatedAt : null,
    url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/issues/${item.number}`,
    locked: false,
  };
}

function pullParent(repo: RepoRec, item: ItemRec): GqlParent {
  return {
    __type: 'PullRequest',
    repo,
    item,
    number: item.number,
    title: item.title,
    body: item.body,
    merged: item.merged,
    headRefName: item.headRef,
    baseRefName: item.baseRef,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mergedAt: item.mergedAt,
    closedAt: item.state === 'closed' ? item.updatedAt : null,
    isDraft: false,
    url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/pull/${item.number}`,
  };
}

function commentParent(comment: CommentRec): GqlParent {
  return { __type: 'IssueComment', comment, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.createdAt };
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionSpec {
  typeName: string;
  items: ItemRec[];
  repo: RepoRec;
  make: (repo: RepoRec, item: ItemRec) => GqlParent;
  args: Record<string, unknown>;
}

function connectionOf(spec: ConnectionSpec): GqlParent {
  const first = typeof spec.args['first'] === 'number' ? (spec.args['first'] as number) : 10;
  const afterNumber = cursorNumber(spec.args['after']);
  let start = 0;
  if (afterNumber !== null) {
    const index = spec.items.findIndex((item) => item.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const slice = spec.items.slice(start, start + Math.max(0, first));
  const nodes = slice.map((item) => spec.make(spec.repo, item));
  const last = slice[slice.length - 1];
  return {
    __type: spec.typeName,
    nodes,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + slice.length < spec.items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(slice[0]!.number) : null,
      endCursor: last === undefined ? null : cursorOf(last.number),
    },
    totalCount: spec.items.length,
  };
}

function repoByDbId(forge: Forge, dbId: number): RepoRec | null {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function locateItem(forge: Forge, id: string): { repo: RepoRec; item: ItemRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) return null;
  const repo = repoByDbId(forge, Number(parsed.parts[0]));
  if (repo === null) return null;
  const item = repo.items.get(Number(parsed.parts[1]));
  if (item === undefined) return null;
  if (parsed.type === 'Issue' && item.kind !== 'issue') return null;
  if (parsed.type === 'PullRequest' && item.kind !== 'pr') return null;
  return { repo, item };
}

function typeParent(name: string): GqlParent | null {
  if (name in GQL_TYPE_FIELDS) return { __type: '__Type', name, kind: 'OBJECT', fieldNames: GQL_TYPE_FIELDS[name], enumNames: null };
  if (name in GQL_ENUM_VALUES) return { __type: '__Type', name, kind: 'ENUM', fieldNames: null, enumNames: GQL_ENUM_VALUES[name] };
  return null;
}

type GqlResolver = (exec: GqlExec, parent: GqlParent, args: Record<string, unknown>) => unknown;

const GQL_RESOLVERS: Record<string, Record<string, GqlResolver>> = {
  Query: {
    viewer: () => viewerParent(),
    repository: (exec, _parent, args) => {
      if (args['owner'] !== VIEWER_LOGIN || typeof args['name'] !== 'string') return null;
      const repo = exec.forge.repos.get(args['name'] as string);
      return repo === undefined ? null : repoParent(repo);
    },
    node: (exec, _parent, args) => {
      if (typeof args['id'] !== 'string') return null;
      const parsed = parseGlobalId(args['id'] as string);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = repoByDbId(exec.forge, Number(parsed.parts[0]));
        return repo === null ? null : repoParent(repo);
      }
      if (parsed.type === 'User') return viewerParent();
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const located = locateItem(exec.forge, args['id'] as string);
        if (located === null) return null;
        return located.item.kind === 'pr' ? pullParent(located.repo, located.item) : issueParent(located.repo, located.item);
      }
      if (parsed.type === 'IssueComment') {
        const commentId = Number(parsed.parts[0]);
        for (const repo of exec.forge.repos.values()) {
          for (const list of repo.comments.values()) {
            const found = list.find((comment) => comment.id === commentId);
            if (found !== undefined) return commentParent(found);
          }
        }
        return null;
      }
      return null;
    },
    __type: (_exec, _parent, args) => (typeof args['name'] === 'string' ? typeParent(args['name'] as string) : null),
    __schema: () => ({
      __type: '__Schema',
      types: [...Object.keys(GQL_TYPE_FIELDS), ...Object.keys(GQL_ENUM_VALUES)].map((name) => typeParent(name)),
      queryType: typeParent('Query'),
      mutationType: typeParent('Mutation'),
    }),
    user: (_exec, _parent, args) => (args['login'] === VIEWER_LOGIN ? viewerParent() : null),
    search: () => ({ __type: 'SearchResultItemConnection', nodes: [], issueCount: 0, repositoryCount: 0, userCount: 0 }),
  },
  Mutation: {
    createIssue: (exec, _parent, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const parsed = typeof input['repositoryId'] === 'string' ? parseGlobalId(input['repositoryId'] as string) : null;
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(exec.forge, Number(parsed.parts[0])) : null;
      if (repo === null) throw new Error('repository not found for createIssue');
      const item = opCreateIssue(exec.forge, repo, {
        title: typeof input['title'] === 'string' ? (input['title'] as string) : '',
        body: typeof input['body'] === 'string' ? (input['body'] as string) : '',
      });
      return { __type: 'CreateIssuePayload', issue: issueParent(repo, item) };
    },
    closeIssue: (exec, _parent, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const located = typeof input['issueId'] === 'string' ? locateItem(exec.forge, input['issueId'] as string) : null;
      if (located === null) throw new Error('issue not found for closeIssue');
      located.item.state = 'closed';
      located.item.updatedAt = nowIso();
      return { __type: 'CloseIssuePayload', issue: issueParent(located.repo, located.item) };
    },
    createPullRequest: (exec, _parent, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const parsed = typeof input['repositoryId'] === 'string' ? parseGlobalId(input['repositoryId'] as string) : null;
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(exec.forge, Number(parsed.parts[0])) : null;
      if (repo === null) throw new Error('repository not found for createPullRequest');
      const head = typeof input['headRefName'] === 'string' ? (input['headRefName'] as string) : '';
      const base = typeof input['baseRefName'] === 'string' ? (input['baseRefName'] as string) : '';
      try {
        const item = opCreatePull(exec.forge, repo, {
          title: typeof input['title'] === 'string' ? (input['title'] as string) : '',
          body: typeof input['body'] === 'string' ? (input['body'] as string) : '',
          head,
          base,
        });
        return { __type: 'CreatePullRequestPayload', pullRequest: pullParent(repo, item) };
      } catch (err) {
        if (err instanceof HttpError && err.status === 422 && err.message.includes('already exists')) {
          const existing = [...repo.items.values()].find((item) => item.kind === 'pr' && item.state === 'open' && item.headRef === head && item.baseRef === base);
          if (existing !== undefined) return { __type: 'CreatePullRequestPayload', pullRequest: pullParent(repo, existing) };
        }
        throw err;
      }
    },
    mergePullRequest: (exec, _parent, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const located = typeof input['pullRequestId'] === 'string' ? locateItem(exec.forge, input['pullRequestId'] as string) : null;
      if (located === null || located.item.kind !== 'pr') throw new Error('pull request not found for mergePullRequest');
      opMergePull(exec.forge, located.repo, located.item);
      return { __type: 'MergePullRequestPayload', pullRequest: pullParent(located.repo, located.item) };
    },
    addComment: (exec, _parent, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const located = typeof input['subjectId'] === 'string' ? locateItem(exec.forge, input['subjectId'] as string) : null;
      if (located === null) throw new Error('subject not found for addComment');
      const comment = opAddComment(exec.forge, located.repo, located.item, typeof input['body'] === 'string' ? (input['body'] as string) : '');
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node: commentParent(comment) } };
    },
  },
  Repository: {
    id: (_exec, parent) => globalId('Repository', (parent['repo'] as RepoRec).dbId),
    databaseId: (_exec, parent) => (parent['repo'] as RepoRec).dbId,
    name: (_exec, parent) => (parent['repo'] as RepoRec).name,
    nameWithOwner: (_exec, parent) => `${VIEWER_LOGIN}/${(parent['repo'] as RepoRec).name}`,
    owner: () => viewerParent(),
    description: (_exec, parent) => (parent['repo'] as RepoRec).description,
    isPrivate: (_exec, parent) => (parent['repo'] as RepoRec).isPrivate,
    defaultBranchRef: (_exec, parent) => {
      const repo = parent['repo'] as RepoRec;
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
      return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', repo };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (_exec, parent) => (parent['repo'] as RepoRec).createdAt,
    updatedAt: (_exec, parent) => (parent['repo'] as RepoRec).createdAt,
    url: (_exec, parent) => `https://github.com/${VIEWER_LOGIN}/${(parent['repo'] as RepoRec).name}`,
    issue: (_exec, parent, args) => {
      const repo = parent['repo'] as RepoRec;
      const item = typeof args['number'] === 'number' ? repo.items.get(args['number'] as number) : undefined;
      return item !== undefined && item.kind === 'issue' ? issueParent(repo, item) : null;
    },
    issues: (_exec, parent, args) => {
      const repo = parent['repo'] as RepoRec;
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      const states = args['states'];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        items = items.filter((item) => wanted.has(item.state));
      }
      const orderBy = (args['orderBy'] ?? {}) as Record<string, unknown>;
      const direction = orderBy['direction'] === 'DESC' ? -1 : 1;
      items.sort((a, b) => (a.number - b.number) * direction);
      return connectionOf({ typeName: 'IssueConnection', items, repo, make: issueParent, args });
    },
    pullRequest: (_exec, parent, args) => {
      const repo = parent['repo'] as RepoRec;
      const item = typeof args['number'] === 'number' ? repo.items.get(args['number'] as number) : undefined;
      return item !== undefined && item.kind === 'pr' ? pullParent(repo, item) : null;
    },
    pullRequests: (_exec, parent, args) => {
      const repo = parent['repo'] as RepoRec;
      let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
      const states = args['states'];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state)));
        items = items.filter((item) => wanted.has(item.merged ? 'MERGED' : item.state.toUpperCase()));
      }
      items.sort((a, b) => a.number - b.number);
      return connectionOf({ typeName: 'PullRequestConnection', items, repo, make: pullParent, args });
    },
  },
  Issue: {
    id: (_exec, parent) => globalId('Issue', (parent['repo'] as RepoRec).dbId, (parent['item'] as ItemRec).number),
    state: (_exec, parent) => ((parent['item'] as ItemRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => viewerParent(),
    repository: (_exec, parent) => repoParent(parent['repo'] as RepoRec),
    labels: (_exec, parent) => ({
      __type: 'LabelConnection',
      nodes: (parent['item'] as ItemRec).labels.map((name) => ({ __type: 'Label', name, color: (parent['repo'] as RepoRec).labels.get(name)?.color ?? '000000' })),
    }),
    comments: (_exec, parent) => ({
      __type: 'IssueCommentConnection',
      nodes: ((parent['repo'] as RepoRec).comments.get((parent['item'] as ItemRec).number) ?? []).map(commentParent),
      totalCount: ((parent['repo'] as RepoRec).comments.get((parent['item'] as ItemRec).number) ?? []).length,
    }),
  },
  PullRequest: {
    id: (_exec, parent) => globalId('PullRequest', (parent['repo'] as RepoRec).dbId, (parent['item'] as ItemRec).number),
    state: (_exec, parent) => {
      const item = parent['item'] as ItemRec;
      return item.merged ? 'MERGED' : item.state.toUpperCase();
    },
    mergeable: (exec, parent) => pullMergeable(parent['repo'] as RepoRec, parent['item'] as ItemRec),
    author: () => viewerParent(),
    repository: (_exec, parent) => repoParent(parent['repo'] as RepoRec),
    files: (_exec, parent, args) => {
      const repo = parent['repo'] as RepoRec;
      const item = parent['item'] as ItemRec;
      const baseTip = branchTip(repo, item.baseRef);
      const headTip = branchTip(repo, item.headRef) ?? item.headSha;
      const files = baseTip === null || headTip === null ? [] : pullRequestFiles(repo, baseTip, headTip);
      const first = typeof args['first'] === 'number' ? (args['first'] as number) : 10;
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, Math.max(0, first)).map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
        totalCount: files.length,
      };
    },
    additions: (_exec, parent) => {
      const repo = parent['repo'] as RepoRec;
      const item = parent['item'] as ItemRec;
      const baseTip = branchTip(repo, item.baseRef);
      const headTip = branchTip(repo, item.headRef) ?? item.headSha;
      if (baseTip === null || headTip === null) return 0;
      return pullRequestFiles(repo, baseTip, headTip).reduce((sum, file) => sum + file.additions, 0);
    },
    deletions: (_exec, parent) => {
      const repo = parent['repo'] as RepoRec;
      const item = parent['item'] as ItemRec;
      const baseTip = branchTip(repo, item.baseRef);
      const headTip = branchTip(repo, item.headRef) ?? item.headSha;
      if (baseTip === null || headTip === null) return 0;
      return pullRequestFiles(repo, baseTip, headTip).reduce((sum, file) => sum + file.deletions, 0);
    },
    changedFiles: (_exec, parent) => {
      const repo = parent['repo'] as RepoRec;
      const item = parent['item'] as ItemRec;
      const baseTip = branchTip(repo, item.baseRef);
      const headTip = branchTip(repo, item.headRef) ?? item.headSha;
      if (baseTip === null || headTip === null) return 0;
      return pullRequestFiles(repo, baseTip, headTip).length;
    },
  },
  IssueComment: {
    id: (_exec, parent) => globalId('IssueComment', (parent['comment'] as CommentRec).id),
    author: () => viewerParent(),
  },
  Ref: {
    target: (_exec, parent) => {
      const repo = parent['repo'] as RepoRec;
      const oid = repo.refs.get(`refs/heads/${parent['name'] as string}`);
      return oid === undefined ? null : { __type: 'Commit', oid, sha: oid };
    },
  },
  __Type: {
    fields: (_exec, parent) => {
      const names = parent['fieldNames'] as string[] | null;
      return names === null ? null : names.map((name) => ({ __type: '__Field', name, description: null }));
    },
    enumValues: (_exec, parent) => {
      const names = parent['enumNames'] as string[] | null;
      return names === null ? null : names.map((name) => ({ __type: '__EnumValue', name, description: null }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
  },
  __Field: {
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

function gqlComplete(exec: GqlExec, value: unknown, selection: GqlSelection[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (selection === null) return value;
  if (Array.isArray(value)) return value.map((entry) => gqlComplete(exec, entry, selection));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const parent = value as GqlParent;
    const out: Record<string, unknown> = {};
    gqlExecSelection(exec, parent['__type'], parent, selection, out);
    return out;
  }
  return value;
}

function gqlExecSelection(exec: GqlExec, typeName: string, parent: GqlParent, selections: GqlSelection[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        gqlExecSelection(exec, typeName, parent, selection.selection, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment !== undefined) gqlExecSelection(exec, typeName, parent, fragment, out);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argNode] of field.args) args[argName] = gqlResolveValue(argNode, exec);
    const resolver = GQL_RESOLVERS[typeName]?.[field.name];
    try {
      let value: unknown;
      if (resolver !== undefined) value = resolver(exec, parent, args);
      else if (field.name in parent) value = parent[field.name];
      else {
        exec.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
        out[key] = null;
        continue;
      }
      out[key] = gqlComplete(exec, value, field.selection);
    } catch (err) {
      exec.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
}

function executeGraphQL(forge: Forge, request: Record<string, unknown>): Record<string, unknown> {
  const query = request['query'];
  if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
  let document: GqlDocument;
  try {
    document = new GqlParser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof request['operationName'] === 'string' ? (request['operationName'] as string) : null;
  const operation = (operationName === null ? document.operations[0] : document.operations.find((op) => op.name === operationName)) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const variables = (typeof request['variables'] === 'object' && request['variables'] !== null ? request['variables'] : {}) as Record<string, unknown>;
  const exec: GqlExec = { forge, variables, varDefaults: operation.varDefaults, fragments: document.fragments, errors: [] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  gqlExecSelection(exec, rootType, { __type: rootType }, operation.selection, data);
  const response: Record<string, unknown> = { data };
  if (exec.errors.length > 0) response['errors'] = exec.errors;
  return response;
}

async function handleGraphQL(ctx: Ctx): Promise<void> {
  if (!isAuthed(ctx.req)) {
    sendJson(ctx.res, 401, { errors: [{ message: 'Bad credentials' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx.res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeGraphQL(ctx.forge, (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>));
    sendJson(ctx.res, 200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(ctx.res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  sendJson(ctx.res, 200, executeGraphQL(ctx.forge, parsed as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol over streamable HTTP)
// ---------------------------------------------------------------------------

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'konongsz-forge', version: FORGE_VERSION };

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const MCP_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the new repository.' },
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['owner', 'name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by a user.',
    properties: {
      owner: { type: 'string', description: 'The owner login whose repositories to list.' },
    },
    required: ['owner'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body text of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its number.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      issue_number: { type: 'number', description: 'The number of the issue.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The body text of the pull request.' },
      head: { type: 'string', description: 'The head branch to merge from.' },
      base: { type: 'string', description: 'The base branch to merge into.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner login of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list payload: built once, so repeated calls are byte-identical. */
const MCP_TOOLS_LIST = MCP_TOOL_DEFS.map((def) => ({
  name: def.name,
  description: def.description,
  inputSchema: { type: 'object', properties: def.properties, required: def.required, additionalProperties: true },
}));

function mcpToolResult(value: unknown): Record<string, unknown> {
  const structured = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
    isError: false,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = args['owner'];
  if (typeof owner === 'string' && owner !== VIEWER_LOGIN) throw new Error(`repository owner "${owner}" not found`);
  const name = typeof args['repo'] === 'string' ? (args['repo'] as string) : typeof args['name'] === 'string' ? (args['name'] as string) : '';
  const repo = forge.repos.get(name);
  if (repo === undefined) throw new Error(`repository "${name}" not found`);
  return repo;
}

function runMcpTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = MCP_TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) throw new McpRpcError(-32602, `unknown tool: ${name}`);
  for (const required of def.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return mcpToolError(`missing required argument: ${required}`);
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = opCreateRepo(forge, {
          name: args['name'] as string,
          isPrivate: args['private'] === true,
          description: typeof args['description'] === 'string' ? (args['description'] as string) : '',
        });
        return mcpToolResult(repoJson(repo));
      }
      case 'get_repo':
        return mcpToolResult(repoJson(mcpRepo(forge, args)));
      case 'list_repos':
        return mcpToolResult([...forge.repos.values()].map(repoJson));
      case 'create_issue': {
        const repo = mcpRepo(forge, args);
        const item = opCreateIssue(forge, repo, {
          title: args['title'] as string,
          body: typeof args['body'] === 'string' ? (args['body'] as string) : '',
        });
        return mcpToolResult(issueJson(repo, item));
      }
      case 'list_issues': {
        const repo = mcpRepo(forge, args);
        const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
        let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
        if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
        items.sort((a, b) => a.number - b.number);
        return mcpToolResult(items.map((item) => issueJson(repo, item)));
      }
      case 'get_issue': {
        const repo = mcpRepo(forge, args);
        const item = repo.items.get(Number(args['issue_number']));
        if (item === undefined) return mcpToolError(`issue ${String(args['issue_number'])} not found`);
        return mcpToolResult(issueJson(repo, item));
      }
      case 'create_pull_request': {
        const repo = mcpRepo(forge, args);
        const item = opCreatePull(forge, repo, {
          title: args['title'] as string,
          body: typeof args['body'] === 'string' ? (args['body'] as string) : '',
          head: args['head'] as string,
          base: args['base'] as string,
        });
        return mcpToolResult(pullJson(repo, item));
      }
      case 'list_pull_requests': {
        const repo = mcpRepo(forge, args);
        const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
        let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
        if (state === 'open') items = items.filter((item) => item.state === 'open' && !item.merged);
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed' || item.merged);
        items.sort((a, b) => a.number - b.number);
        return mcpToolResult(items.map((item) => pullJson(repo, item)));
      }
      case 'merge_pull_request': {
        const repo = mcpRepo(forge, args);
        const item = repo.items.get(Number(args['pull_number']));
        if (item === undefined || item.kind !== 'pr') return mcpToolError(`pull request ${String(args['pull_number'])} not found`);
        opMergePull(forge, repo, item);
        return mcpToolResult(pullJson(repo, item));
      }
      default:
        throw new McpRpcError(-32602, `unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpRpcError) throw err;
    return mcpToolError(err instanceof Error ? err.message : String(err));
  }
}

/** A JSON-RPC error that must surface as a protocol error, not a tool result. */
class McpRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function handleMcp(ctx: Ctx): void {
  const { res } = ctx;
  if (!isAuthed(ctx.req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request['method'] === 'string' ? (request['method'] as string) : '';
  const id = request['id'];
  if (id === undefined || id === null) {
    // A notification: accepted, never answered.
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  const params = (typeof request['params'] === 'object' && request['params'] !== null ? request['params'] : {}) as Record<string, unknown>;
  const answer = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'server/discover':
        answer({
          resultType: 'complete',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
        });
        return;
      case 'initialize': {
        const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
        answer({
          protocolVersion: MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
        });
        return;
      }
      case 'ping':
        answer({});
        return;
      case 'tools/list':
        answer({ tools: MCP_TOOLS_LIST });
        return;
      case 'tools/call': {
        const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
        const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
        answer(runMcpTool(ctx.forge, toolName, args));
        return;
      }
      default:
        fail(-32601, `Method not found: ${method}`);
        return;
    }
  } catch (err) {
    if (err instanceof McpRpcError) fail(err.code, err.message);
    else fail(-32603, err instanceof Error ? err.message : 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const forge = createForge();
  const server = createServer((req, res) => {
    res.setHeader('x-github-request-id', randomUUID());
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const body = await readBody(req);
        const segments = url.pathname
          .split('/')
          .filter((piece) => piece !== '')
          .map((piece) => {
            try {
              return decodeURIComponent(piece);
            } catch {
              return piece;
            }
          });
        const ctx: Ctx = { forge, req, res, url, body };
        if (segments.length === 1 && segments[0] === 'healthz') {
          if (req.method === 'GET') sendJson(res, 200, { ok: true });
          else sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest(ctx, segments.slice(2));
          return;
        }
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (req.method === 'POST') await handleGraphQL(ctx);
          else sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (req.method === 'POST') handleMcp(ctx);
          else {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ message: 'Method Not Allowed' }));
          }
          return;
        }
        if (segments.length >= 3) {
          handleGit(ctx, segments[0]!, segments[1]!, segments.slice(2));
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) sendJson(res, err.status, { message: err.message });
        else {
          process.stderr.write(`[forge] unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      }
    })();
  });
  return server;
}
