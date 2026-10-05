/**
 * C-9 (omnist-spec Sec7.3, v0.32.0-beta): every writer MUST fail, unconditionally,
 * with `write.unsupported-value` when a Document holds a string value or an
 * edge label that has no UTF-8 encoding. In JavaScript that is a UTF-16 lone
 * surrogate: a high surrogate not followed by a low one, or a low surrogate
 * not preceded by a high one. A valid surrogate pair is an astral character
 * and writes normally; an astral character, a noncharacter and NUL all encode.
 *
 * Emitting the string as an escape (`\ud800`) or raw does not comply: only a
 * failure does. The path is the Document path of the node HOLDING the string:
 * the leaf, for a value (indexed per E-10); the node that holds the edge, for a
 * label, because Sec8.4 has no way to quote a label in a path.
 *
 * Cost: the check runs on every write, so the common case, a Document with no
 * offender, is a pathless scan: an iterative walk that tests each string with
 * the engine's own well-formedness test (a one-byte string is well formed at
 * once) and builds no path string. Only a failure pays for the second walk
 * that finds the first offender in document order and builds its path. Both
 * walks are iterative, so a node deeper than the writers' own depth limit is
 * refused by THEIR depth check, not by a stack overflow here.
 */

import type { Edge, Node } from "./document.js";
import { WriteError } from "./errors.js";
import { edgePaths } from "./paths.js";

/** `String.prototype.isWellFormed` (ES2024; Node 20+): no lone surrogate. */
function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

/** The fast, pathless test: does any string value or label lack a UTF-8 encoding? */
function anyUnencodable(root: Node): boolean {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (Array.isArray(node)) {
      for (const { label, target } of node as Edge[]) {
        if (!wellFormed(label)) return true;
        if (Array.isArray(target)) stack.push(target);
        else if (typeof target === "string" && !wellFormed(target)) return true;
      }
    } else if (typeof node === "string" && !wellFormed(node)) {
      return true;
    }
  }
  return false;
}

function unsupported(message: string, path: string): WriteError {
  return new WriteError(message, undefined, "write.unsupported-value", path);
}

/** The slow walk, run only once an offender is known to exist: finds the first
 * one in document order (a node's labels before its children) and reports it. */
function raiseFirstUnencodable(root: Node): never {
  const stack: Array<[string, Node]> = [["$", root]];
  for (;;) {
    const [path, node] = stack.pop() as [string, Node];
    if (!Array.isArray(node)) {
      // A scalar leaf: the only way here that is not the offender is a
      // well-formed value, and anyUnencodable() found exactly one string that
      // is not, so this is it once every earlier entry has been passed.
      if (typeof node === "string" && !wellFormed(node)) {
        throw unsupported(
          path + ": a string value with no UTF-8 encoding (a lone surrogate) cannot be written",
          path,
        );
      }
      continue;
    }
    const edges = node as Edge[];
    for (const { label } of edges) {
      if (!wellFormed(label)) {
        throw unsupported(
          path + ": an edge label with no UTF-8 encoding (a lone surrogate) cannot be written",
          path,
        );
      }
    }
    const paths = edgePaths(path, edges);
    for (let i = edges.length - 1; i >= 0; i--) {
      stack.push([paths[i] as string, (edges[i] as Edge).target]);
    }
  }
}

/** C-9: throw `WriteError` (`write.unsupported-value`) if `node` holds a string
 * value or an edge label with no UTF-8 encoding. Every writer and checker calls
 * this first. */
export function checkEncodable(node: Node): void {
  if (anyUnencodable(node)) raiseFirstUnencodable(node);
}
